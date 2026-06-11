"""Head-to-head live match: TWO human managers, one minute-by-minute engine.

The multiplayer grudge match. Both sides are fully managed — each manager
brings a real squad, XI, tactics dials, five substitutions, stamina, cards
and injuries. The maths mirrors `live.py` (same Bernoulli thinning of the
Poisson rates, same tactical dial tables) but is symmetric: there is no AI
opponent, the other dugout is your friend.

Driven by the WebSocket ticker in the API layer: the server owns the clock,
both clients receive every snapshot, and each manager's commands only touch
their own side. Breaks (HT / before extra time) pause the clock until both
managers ready-up (or the ticker times them out).
"""
from __future__ import annotations

from typing import Dict, List, Optional

from app.engine.live import (
    ASSIST_PROB,
    ASSIST_W,
    ATTACK_STYLE,
    CHANCE_RATE,
    FATIGUE_KNEE,
    FATIGUE_SLOPE,
    INJURY_PROB_MATCH,
    INJURY_STAMINA,
    LATE_SURGE,
    LATE_SURGE_FROM,
    LiveMatch,
    MENTALITY,
    NET_CLAMP,
    PASSING,
    PEN_MISS_PER_MIN,
    PENALTY_GOAL_SHARE,
    FREEKICK_GOAL_SHARE,
    PRESS_TIRED_CAP,
    PRESS_TIRED_RATE,
    PRESS_TIRED_STAMINA,
    PRESSING,
    SCORE_W,
    STAMINA_DRAIN,
    STYLE_RATE_BONUS,
    STYLE_SCORER_BOOST,
    SUBS_LIMIT,
    TEMPO,
    WASTE_DRAIN,
    WASTE_OPP,
    WASTE_OWN,
    YELLOW_PROB_MATCH,
)
from app.engine.match import RED_CARD_PROB, _lambdas, _shootout, win_expectancy
from app.engine.squad import FORMATIONS, POS_WEIGHT, RATING_TO_ELO, optimal_score


class Side:
    """One managed dugout in a head-to-head live match."""

    def __init__(self, code: str, manager: str, squad: list, xi_ids: List[str],
                 mentality: str, cond_mult: Optional[Dict[str, float]] = None):
        self.code = code
        self.manager = manager
        self.squad = squad
        self.by_id = {p.id: p for p in squad}
        self.xi: List[str] = [i for i in xi_ids if i in self.by_id]
        self.bench: List[str] = [p.id for p in squad if p.id not in self.xi]
        self.played_ids: List[str] = list(self.xi)
        self.stamina: Dict[str, float] = {p.id: 100.0 for p in squad}
        self.cond_mult = cond_mult or {}
        self.mentality = mentality if mentality in MENTALITY else "balanced"
        self.tempo, self.passing, self.pressing = "balanced", "mixed", "mid"
        self.attack_style, self.time_wasting = "balanced", False
        self.penalty_taker_id: Optional[str] = None
        self.subs_made = 0
        self.subs: List[dict] = []
        self.match_yellows: Dict[str, int] = {}
        self.yellow_ids: List[str] = []
        self.red_ids: List[str] = []
        self.red_minute: Optional[int] = None
        self.injured_ids: List[str] = []
        self.ready = False              # break ready-up flag

    def on_pitch(self) -> list:
        return [self.by_id[i] for i in self.xi if i in self.by_id]

    def avg_stamina(self) -> float:
        if not self.xi:
            return 100.0
        return sum(self.stamina[i] for i in self.xi) / len(self.xi)

    def effective_delta(self) -> float:
        players = self.on_pitch()
        if not players:
            return -250.0
        tot = wt = 0.0
        for p in players:
            fatigue = max(0.0, FATIGUE_KNEE - self.stamina[p.id]) * FATIGUE_SLOPE
            w = POS_WEIGHT.get(p.position, 1.0)
            tot += (p.rating * self.cond_mult.get(p.id, 1.0) - fatigue) * w
            wt += w
        delta = (tot / wt - optimal_score(self.squad)) * RATING_TO_ELO
        return min(0.0, max(-300.0, delta))


class H2HLiveMatch:
    """Two-sided live match. `sides` keys are "home" and "away"."""

    def __init__(self, rng, home_side: Side, away_side: Side, knockout: bool,
                 sh, sa, h_adv: float, date: Optional[str]):
        self.rng = rng
        self.sides: Dict[str, Side] = {"home": home_side, "away": away_side}
        self.knockout = knockout
        self.sh, self.sa, self.h_adv = sh, sa, h_adv
        self.date = date
        self.minute = 0
        self.hg = 0
        self.ag = 0
        self.events: List[dict] = []
        self.break_flag: Optional[str] = None
        self.done = False
        self.penalties = False
        self.home_pens: Optional[int] = None
        self.away_pens: Optional[int] = None

    # ----------------------------------------------------------------- rates
    def _minute_lambdas(self) -> tuple[float, float]:
        h, a = self.sides["home"], self.sides["away"]
        self.sh.lineup_delta = h.effective_delta()
        self.sa.lineup_delta = a.effective_delta()
        lh, la = _lambdas(self.sh, self.sa, self.h_adv)
        base_h, base_a = lh, la

        h_own, h_opp = MENTALITY.get(h.mentality, (1.0, 1.0))
        a_own, a_opp = MENTALITY.get(a.mentality, (1.0, 1.0))
        lh, la = lh * h_own * a_opp, la * a_own * h_opp
        lh, la = LiveMatch._apply_dials(lh, la, h.tempo, h.passing, h.pressing,
                                        a.mentality)
        la, lh = LiveMatch._apply_dials(la, lh, a.tempo, a.passing, a.pressing,
                                        h.mentality)
        for side, get in ((h, "h"), (a, "a")):
            if ((side.attack_style == "target_man" and side.passing == "direct")
                    or (side.attack_style == "false_nine" and side.passing == "short")):
                if get == "h":
                    lh *= STYLE_RATE_BONUS
                else:
                    la *= STYLE_RATE_BONUS
        lo, hi = NET_CLAMP
        lh = min(max(lh, base_h * lo), base_h * hi)
        la = min(max(la, base_a * lo), base_a * hi)
        # Game-state stacks (post-clamp): time-wasting + tired-press collapse.
        if h.time_wasting:
            lh *= WASTE_OWN
            la *= WASTE_OPP
        if a.time_wasting:
            la *= WASTE_OWN
            lh *= WASTE_OPP
        if h.pressing == "high" and h.avg_stamina() < PRESS_TIRED_STAMINA:
            la *= min(PRESS_TIRED_CAP,
                      1.0 + PRESS_TIRED_RATE * (PRESS_TIRED_STAMINA - h.avg_stamina()))
        if a.pressing == "high" and a.avg_stamina() < PRESS_TIRED_STAMINA:
            lh *= min(PRESS_TIRED_CAP,
                      1.0 + PRESS_TIRED_RATE * (PRESS_TIRED_STAMINA - a.avg_stamina()))
        if self.minute >= LATE_SURGE_FROM:
            lh *= LATE_SURGE
            la *= LATE_SURGE
        if h.red_minute is not None:
            lh *= 0.72
            la *= 1.22
        if a.red_minute is not None:
            la *= 0.72
            lh *= 1.22
        return lh / 90.0, la / 90.0

    # ---------------------------------------------------------------- events
    def _emit(self, ev: dict) -> dict:
        self.events.append(ev)
        return ev

    def _pick(self, side: Side, attacking=True):
        players = side.on_pitch()
        if not players:
            return None
        if attacking:
            w = [SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players]
            if side.attack_style != "balanced":
                boosted = "FWD" if side.attack_style == "target_man" else "MID"
                w = [x * (STYLE_SCORER_BOOST if p.position == boosted else 1.0)
                     for x, p in zip(w, players)]
        else:
            w = [3.0 if p.position == "DEF" else 1.5 if p.position == "MID" else 0.7
                 for p in players]
        tot = sum(w)
        r = self.rng.random() * tot
        for p, x in zip(players, w):
            r -= x
            if r <= 0:
                return p
        return players[-1]

    def _goal(self, key: str) -> None:
        side = self.sides[key]
        r = self.rng.random()
        source = ("penalty" if r < PENALTY_GOAL_SHARE
                  else "freekick" if r < PENALTY_GOAL_SHARE + FREEKICK_GOAL_SHARE
                  else "open")
        scorer = None
        if source == "penalty" and side.penalty_taker_id in side.xi:
            scorer = side.by_id.get(side.penalty_taker_id)
        if scorer is None:
            scorer = self._pick(side, attacking=True)
        if key == "home":
            self.hg += 1
        else:
            self.ag += 1
        ev = {"type": "goal", "minute": self.minute, "team": side.code,
              "scorer": scorer.name if scorer else side.code,
              "scorer_id": scorer.id if scorer else "",
              "position": scorer.position if scorer else "", "assist": None,
              "source": source}
        if source == "open" and scorer and self.rng.random() < ASSIST_PROB:
            mates = [p for p in side.on_pitch() if p.id != scorer.id]
            if mates:
                w = [ASSIST_W.get(p.position, 1.0) * (p.rating / 80.0) for p in mates]
                tot = sum(w)
                r2 = self.rng.random() * tot
                for p, x in zip(mates, w):
                    r2 -= x
                    if r2 <= 0:
                        ev["assist"], ev["assist_id"] = p.name, p.id
                        ev["assist_position"] = p.position
                        break
        self._emit(ev)

    def _chance(self, key: str) -> None:
        side = self.sides[key]
        player = self._pick(side, attacking=True)
        self._emit({"type": "chance", "minute": self.minute, "team": side.code,
                    "scorer": player.name if player else side.code,
                    "scorer_id": player.id if player else "",
                    "position": player.position if player else "", "assist": None,
                    "outcome": ["saved", "missed", "woodwork"][int(self.rng.random() * 3) % 3]})

    def _cards(self, key: str) -> None:
        side = self.sides[key]
        p_minute = YELLOW_PROB_MATCH / 90.0
        for p in side.on_pitch():
            if self.rng.random() < p_minute:
                side.match_yellows[p.id] = side.match_yellows.get(p.id, 0) + 1
                if side.match_yellows[p.id] >= 2 and side.red_minute is None:
                    side.red_minute = self.minute
                    side.red_ids.append(p.id)
                    side.xi = [i for i in side.xi if i != p.id]
                    self._emit({"type": "red", "minute": self.minute,
                                "team": side.code, "scorer": p.name,
                                "scorer_id": p.id, "position": p.position,
                                "assist": None, "second_yellow": True})
                else:
                    side.yellow_ids.append(p.id)
                    self._emit({"type": "yellow", "minute": self.minute,
                                "team": side.code, "scorer": p.name,
                                "scorer_id": p.id, "position": p.position,
                                "assist": None})
                return
        if side.red_minute is None and self.rng.random() < RED_CARD_PROB / 90.0:
            p = self._pick(side, attacking=False)
            if p:
                side.red_minute = self.minute
                side.red_ids.append(p.id)
                side.xi = [i for i in side.xi if i != p.id]
                self._emit({"type": "red", "minute": self.minute, "team": side.code,
                            "scorer": p.name, "scorer_id": p.id,
                            "position": p.position, "assist": None})

    def _injury(self, key: str) -> None:
        side = self.sides[key]
        if self.rng.random() >= INJURY_PROB_MATCH / 90.0:
            return
        candidates = [p for p in side.on_pitch() if p.id not in side.injured_ids]
        if not candidates:
            return
        p = candidates[int(self.rng.random() * len(candidates))]
        side.injured_ids.append(p.id)
        side.stamina[p.id] = min(side.stamina[p.id], INJURY_STAMINA)
        self._emit({"type": "injury", "minute": self.minute, "team": side.code,
                    "scorer": p.name, "scorer_id": p.id, "position": p.position,
                    "assist": None,
                    "detail": "is down injured — sub him or gamble on heart"})

    # ------------------------------------------------------------ management
    def set_tactics(self, key: str, mentality=None, tempo=None, passing=None,
                    pressing=None, attack_style=None, time_wasting=None,
                    penalty_taker=None) -> bool:
        side = self.sides[key]
        changed = False
        if mentality in MENTALITY:
            side.mentality, changed = mentality, True
        if tempo in TEMPO:
            side.tempo, changed = tempo, True
        if passing in PASSING:
            side.passing, changed = passing, True
        if pressing in PRESSING:
            side.pressing, changed = pressing, True
        if attack_style in ATTACK_STYLE:
            side.attack_style, changed = attack_style, True
        if time_wasting is not None:
            side.time_wasting, changed = bool(time_wasting), True
        if penalty_taker is not None:
            if penalty_taker in side.by_id:
                side.penalty_taker_id, changed = penalty_taker, True
            elif penalty_taker == "":
                side.penalty_taker_id, changed = None, True
        return changed

    def substitute(self, key: str, out_id: str, in_id: str) -> tuple[bool, str]:
        side = self.sides[key]
        if self.done:
            return False, "The match is over."
        if side.subs_made >= SUBS_LIMIT:
            return False, f"All {SUBS_LIMIT} substitutions used."
        if out_id not in side.xi:
            return False, "That player is not on the pitch."
        if in_id not in side.bench:
            return False, "That player is not on the bench."
        out_p, in_p = side.by_id.get(out_id), side.by_id.get(in_id)
        if not out_p or not in_p:
            return False, "Unknown player."
        nxt = [in_id if i == out_id else i for i in side.xi]
        if side.red_minute is None:
            players = [side.by_id[i] for i in nxt]
            gk = sum(1 for p in players if p.position == "GK")
            d = sum(1 for p in players if p.position == "DEF")
            m = sum(1 for p in players if p.position == "MID")
            f = sum(1 for p in players if p.position == "FWD")
            if gk != 1:
                return False, "You must keep exactly one goalkeeper."
            if (d, m, f) not in FORMATIONS.values():
                return False, f"{d}-{m}-{f} is not a playable formation."
        elif in_p.position == "GK" and out_p.position != "GK":
            return False, "You must keep exactly one goalkeeper."
        side.xi = nxt
        side.bench = [i for i in side.bench if i != in_id]
        side.played_ids.append(in_id)
        side.subs_made += 1
        side.subs.append({"minute": self.minute, "out_id": out_id, "in_id": in_id,
                          "out": out_p.name, "in": in_p.name})
        self._emit({"type": "sub", "minute": self.minute, "team": side.code,
                    "scorer": in_p.name, "scorer_id": in_id,
                    "position": in_p.position, "assist": out_p.name})
        return True, "ok"

    def set_ready(self, key: str) -> None:
        self.sides[key].ready = True

    def both_ready(self) -> bool:
        return self.sides["home"].ready and self.sides["away"].ready

    def clear_ready(self) -> None:
        self.sides["home"].ready = False
        self.sides["away"].ready = False

    # ----------------------------------------------------------------- clock
    def tick(self, minutes: int = 1) -> List[dict]:
        new_from = len(self.events)
        steps = 0
        self.break_flag = None
        while steps < max(1, min(int(minutes), 5)) and not self.done:
            self.minute += 1
            steps += 1
            for side in self.sides.values():
                drain = (STAMINA_DRAIN.get(side.mentality, 0.57)
                         * TEMPO.get(side.tempo, (1, 1, 1))[2]
                         * PRESSING.get(side.pressing, (1, 1, 1))[2]
                         * (WASTE_DRAIN if side.time_wasting else 1.0))
                for pid in side.xi:
                    side.stamina[pid] = max(0.0, side.stamina[pid] - drain)
            ph, pa = self._minute_lambdas()
            for key, p in (("home", ph), ("away", pa)):
                if self.rng.random() < p:
                    self._goal(key)
                elif self.rng.random() < p * CHANCE_RATE:
                    self._chance(key)
                elif self.rng.random() < PEN_MISS_PER_MIN:
                    self._emit({"type": "penalty_miss", "minute": self.minute,
                                "team": self.sides[key].code,
                                "scorer": "", "scorer_id": "", "position": "",
                                "assist": None,
                                "outcome": "saved" if self.rng.random() < 0.72 else "missed"})
                self._cards(key)
                self._injury(key)

            if self.minute == 45:
                self.break_flag = "HT"
                self.clear_ready()
                break
            if self.minute == 90:
                if self.knockout and self.hg == self.ag:
                    self.break_flag = "ET"
                    self.clear_ready()
                    break
                self.done = True
                break
            if self.minute == 120:
                if self.hg == self.ag:
                    self.penalties = True
                    p_home = 0.5 + (win_expectancy(
                        self.sh.effective_elo(self.h_adv),
                        self.sa.effective_elo(0.0)) - 0.5) * 0.30
                    self.home_pens, self.away_pens = _shootout(self.rng, p_home)
                    self._emit({"type": "pens", "minute": 120,
                                "team": self.sides["home"].code,
                                "scorer": f"{self.home_pens}-{self.away_pens}",
                                "scorer_id": "", "position": "", "assist": None})
                self.done = True
                break
        return self.events[new_from:]

    # ---------------------------------------------------------------- output
    @property
    def winner(self) -> Optional[str]:
        if self.hg > self.ag or (self.penalties and (self.home_pens or 0) > (self.away_pens or 0)):
            return self.sides["home"].code
        if self.ag > self.hg or (self.penalties and (self.away_pens or 0) > (self.home_pens or 0)):
            return self.sides["away"].code
        return None

    def period(self) -> str:
        if self.done:
            return "FT"
        if self.break_flag == "HT":
            return "HT"
        if self.break_flag == "ET":
            return "ET-BREAK"
        return "1H" if self.minute <= 45 else "2H" if self.minute <= 90 else "ET"

    def snapshot(self, viewer: Optional[str] = None) -> dict:
        """Full match view. `viewer` ("home"/"away"/None) marks whose dugout."""
        def side_payload(key: str) -> dict:
            s = self.sides[key]
            return {
                "code": s.code, "manager": s.manager,
                "xi": s.xi, "bench": s.bench,
                "stamina": {i: round(s.stamina[i]) for i in s.xi + s.bench},
                "subs_made": s.subs_made,
                "subs_remaining": SUBS_LIMIT - s.subs_made, "subs": s.subs,
                "mentality": s.mentality, "tempo": s.tempo,
                "passing": s.passing, "pressing": s.pressing,
                "attack_style": s.attack_style, "time_wasting": s.time_wasting,
                "penalty_taker": s.penalty_taker_id,
                "injured": list(s.injured_ids), "red": s.red_minute,
                "avg_stamina": round(s.avg_stamina()), "ready": s.ready,
            }
        return {
            "minute": self.minute, "period": self.period(),
            "home": self.sides["home"].code, "away": self.sides["away"].code,
            "home_goals": self.hg, "away_goals": self.ag,
            "events": self.events,
            "home_side": side_payload("home"), "away_side": side_payload("away"),
            "viewer": viewer, "break": self.break_flag, "done": self.done,
            "penalties": self.penalties,
            "home_pens": self.home_pens, "away_pens": self.away_pens,
            "knockout": self.knockout,
        }

    def result_md(self, round_label: str, managers: Dict[str, Optional[str]]) -> dict:
        """The finished match in the room's standard result shape."""
        record_events = [e for e in self.events
                         if e.get("type") in ("goal", "red", "injury")]
        return {"round": round_label,
                "home": self.sides["home"].code, "away": self.sides["away"].code,
                "home_goals": self.hg, "away_goals": self.ag,
                "penalties": self.penalties, "home_pens": self.home_pens,
                "away_pens": self.away_pens, "winner": self.winner,
                "date": self.date, "events": record_events,
                "home_manager": managers.get("home"),
                "away_manager": managers.get("away"), "was_live": True}
