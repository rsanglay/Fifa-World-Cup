"""Interactive minute-by-minute managed match (in-game management).

Football-Manager-style live match: the server simulates one minute at a time
(`tick`), so the manager can pause, change mentality, and make substitutions
at ANY minute — not just half-time. The visual 2D match view on the client is
a pure renderer of this event stream (sim and view are fully decoupled, the
same split Sports Interactive use between the FM match engine and its 2D/3D
viewers).

Model notes
-----------
* Goal arrival is a per-minute Bernoulli thinning of the same Poisson rates
  (`_lambdas`) the rest of the engine uses, so a full live match has exactly
  the same expected scoreline as the old pre-simulated halves.
* Our XI carries per-player stamina; tired legs lower the effective lineup
  Elo delta, which feeds straight back into the per-minute rates. Fresh subs
  restore it — substitutions genuinely matter.
* The opponent runs a tiny AI: it goes attacking when chasing late, and
  parks the bus when protecting a lead.
* Yellow/red cards are simulated live for the managed team (two yellows in
  one match = a red) and feed the existing cross-match suspension system.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from app.engine.match import RED_CARD_PROB, _lambdas, _shootout, win_expectancy
from app.engine.squad import FORMATIONS, POS_WEIGHT, RATING_TO_ELO, optimal_score

SUBS_LIMIT = 5
YELLOW_PROB_MATCH = 0.16          # per player, per match (matches managed.py)
CHANCE_RATE = 2.1                 # non-goal chances per expected goal
# Stamina drain per minute by mentality (attacking football costs more legs).
STAMINA_DRAIN = {"defensive": 0.50, "balanced": 0.57, "attacking": 0.68}
# Effective rating starts dropping below this stamina, this many pts per unit.
FATIGUE_KNEE = 70.0
FATIGUE_SLOPE = 0.15
# Opponent (un-managed) side tires generically late on; both sides get the
# real-football late-game goal-rate lift.
OPP_FADE_FROM = 65
OPP_FADE_MAX = 0.045              # max ~4.5% rate loss at 90'
LATE_SURGE_FROM = 75
LATE_SURGE = 1.10
MENTALITY = {"attacking": (1.20, 1.14), "balanced": (1.0, 1.0), "defensive": (0.84, 0.80)}
SCORE_W = {"FWD": 6.0, "MID": 3.0, "DEF": 1.0, "GK": 0.02}


class LiveMatch:
    """One in-progress managed match, advanced a minute at a time."""

    def __init__(self, rng, team, home, away, knockout, sh, sa, h_adv,
                 squad, opp_players, xi_ids, mentality, date):
        self.rng = rng
        self.team = team
        self.home, self.away = home, away
        self.us_home = home == team
        self.knockout = knockout
        self.sh, self.sa, self.h_adv = sh, sa, h_adv
        self.squad = squad
        self.by_id = {p.id: p for p in squad}
        self.opp_players = opp_players
        self.date = date

        # Suspended players are excluded from `squad`; silently drop any of
        # their ids from the requested XI rather than crashing mid-career.
        self.xi: List[str] = [i for i in xi_ids if i in self.by_id]
        self.bench: List[str] = [p.id for p in squad if p.id not in self.xi]
        self.stamina: Dict[str, float] = {p.id: 100.0 for p in squad}
        self.mentality = mentality
        self.opp_mentality = "balanced"

        self.minute = 0
        self.hg = 0
        self.ag = 0
        self.events: List[dict] = []
        self.subs_made = 0
        self.subs: List[dict] = []
        self.match_yellows: Dict[str, int] = {}   # our players, this match
        self.yellow_ids: List[str] = []           # feed cross-match discipline
        self.red_ids: List[str] = []
        self.our_red_minute: Optional[int] = None
        self.opp_red_minute: Optional[int] = None

        self.break_flag: Optional[str] = None     # "HT" | "ET"
        self.done = False
        self.penalties = False
        self.home_pens: Optional[int] = None
        self.away_pens: Optional[int] = None

    # ------------------------------------------------------------- strength
    def _effective_delta(self) -> float:
        """Lineup Elo delta from the CURRENT on-pitch XI with fatigue applied."""
        players = [self.by_id[i] for i in self.xi if i in self.by_id]
        if not players:
            return -250.0
        tot = wt = 0.0
        for p in players:
            fatigue = max(0.0, FATIGUE_KNEE - self.stamina[p.id]) * FATIGUE_SLOPE
            w = POS_WEIGHT.get(p.position, 1.0)
            tot += (p.rating - fatigue) * w
            wt += w
        score = tot / wt
        delta = (score - optimal_score(self.squad)) * RATING_TO_ELO
        return min(0.0, max(-300.0, delta))

    def _minute_lambdas(self) -> tuple[float, float]:
        """Per-minute goal probabilities (ours, theirs) for the current state."""
        delta = self._effective_delta()
        if self.us_home:
            self.sh.lineup_delta = delta
        else:
            self.sa.lineup_delta = delta
        lh, la = _lambdas(self.sh, self.sa, self.h_adv)
        l_us, l_opp = (lh, la) if self.us_home else (la, lh)

        own, opp = MENTALITY.get(self.mentality, (1.0, 1.0))
        l_us, l_opp = l_us * own, l_opp * opp
        o_own, o_opp = MENTALITY.get(self.opp_mentality, (1.0, 1.0))
        l_opp, l_us = l_opp * o_own, l_us * o_opp

        if self.minute > OPP_FADE_FROM:
            l_opp *= 1.0 - OPP_FADE_MAX * min(1.0, (self.minute - OPP_FADE_FROM) / 25.0)
        if self.minute >= LATE_SURGE_FROM:
            l_us *= LATE_SURGE
            l_opp *= LATE_SURGE
        # Red cards reshape both rates for the rest of the match.
        if self.our_red_minute is not None:
            l_us *= 0.72
            l_opp *= 1.22
        if self.opp_red_minute is not None:
            l_opp *= 0.72
            l_us *= 1.22
        return l_us / 90.0, l_opp / 90.0

    # ------------------------------------------------------------ opponent AI
    def _opp_ai(self) -> None:
        diff = (self.ag - self.hg) if self.us_home else (self.hg - self.ag)
        if self.minute >= 75 and diff > 0:
            self.opp_mentality = "defensive"
        elif self.minute >= 60 and diff < 0:
            self.opp_mentality = "attacking"
        else:
            self.opp_mentality = "balanced"

    # --------------------------------------------------------------- events
    def _on_pitch(self, ours: bool):
        if ours:
            return [self.by_id[i] for i in self.xi if i in self.by_id]
        return self.opp_players

    def _pick(self, players, attacking=True):
        if not players:
            return None
        if attacking:
            w = [SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players]
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

    def _emit(self, ev: dict) -> dict:
        self.events.append(ev)
        return ev

    def _goal(self, our_side: bool) -> dict:
        side = self.team if our_side else (self.away if self.us_home else self.home)
        scorer = self._pick(self._on_pitch(our_side), attacking=True)
        if (our_side and self.us_home) or (not our_side and not self.us_home):
            self.hg += 1
        else:
            self.ag += 1
        return self._emit({
            "type": "goal", "minute": self.minute, "team": side,
            "scorer": scorer.name if scorer else side,
            "scorer_id": scorer.id if scorer else "",
            "position": scorer.position if scorer else "", "assist": None,
        })

    def _chance(self, our_side: bool) -> dict:
        side = self.team if our_side else (self.away if self.us_home else self.home)
        player = self._pick(self._on_pitch(our_side), attacking=True)
        outcome = ["saved", "missed", "woodwork"][int(self.rng.random() * 3) % 3]
        return self._emit({
            "type": "chance", "minute": self.minute, "team": side,
            "scorer": player.name if player else side,
            "scorer_id": player.id if player else "",
            "position": player.position if player else "",
            "assist": None, "outcome": outcome,
        })

    def _our_card(self) -> Optional[dict]:
        players = self._on_pitch(True)
        p_minute = YELLOW_PROB_MATCH / 90.0
        for p in players:
            if self.rng.random() < p_minute:
                self.match_yellows[p.id] = self.match_yellows.get(p.id, 0) + 1
                if self.match_yellows[p.id] >= 2 and self.our_red_minute is None:
                    # Second yellow: off you go.
                    self.our_red_minute = self.minute
                    self.red_ids.append(p.id)
                    self.xi = [i for i in self.xi if i != p.id]
                    return self._emit({"type": "red", "minute": self.minute,
                                       "team": self.team, "scorer": p.name,
                                       "scorer_id": p.id, "position": p.position,
                                       "assist": None, "second_yellow": True})
                self.yellow_ids.append(p.id)
                return self._emit({"type": "yellow", "minute": self.minute,
                                   "team": self.team, "scorer": p.name,
                                   "scorer_id": p.id, "position": p.position,
                                   "assist": None})
        return None

    def _straight_reds(self) -> None:
        if self.our_red_minute is None and self.rng.random() < RED_CARD_PROB / 90.0:
            p = self._pick(self._on_pitch(True), attacking=False)
            if p:
                self.our_red_minute = self.minute
                self.red_ids.append(p.id)
                self.xi = [i for i in self.xi if i != p.id]
                self._emit({"type": "red", "minute": self.minute, "team": self.team,
                            "scorer": p.name, "scorer_id": p.id,
                            "position": p.position, "assist": None})
        opp_side = self.away if self.us_home else self.home
        if self.opp_red_minute is None and self.rng.random() < RED_CARD_PROB / 90.0:
            p = self._pick(self._on_pitch(False), attacking=False)
            self.opp_red_minute = self.minute
            self._emit({"type": "red", "minute": self.minute, "team": opp_side,
                        "scorer": p.name if p else opp_side,
                        "scorer_id": p.id if p else "",
                        "position": p.position if p else "", "assist": None})

    # ------------------------------------------------------------ management
    def set_mentality(self, mentality: str) -> bool:
        if mentality not in MENTALITY:
            return False
        self.mentality = mentality
        return True

    def substitute(self, out_id: str, in_id: str) -> tuple[bool, str]:
        if self.done:
            return False, "The match is over."
        if self.subs_made >= SUBS_LIMIT:
            return False, f"All {SUBS_LIMIT} substitutions used."
        if out_id not in self.xi:
            return False, "That player is not on the pitch."
        if in_id not in self.bench:
            return False, "That player is not on the bench."
        out_p, in_p = self.by_id.get(out_id), self.by_id.get(in_id)
        if not out_p or not in_p:
            return False, "Unknown player."
        nxt = [in_id if i == out_id else i for i in self.xi]
        # Keep the shape legal (skip strict check when down to 10 after a red).
        if self.our_red_minute is None:
            players = [self.by_id[i] for i in nxt]
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
        self.xi = nxt
        self.bench = [i for i in self.bench if i != in_id]
        self.subs_made += 1
        self.subs.append({"minute": self.minute, "out_id": out_id, "in_id": in_id,
                          "out": out_p.name, "in": in_p.name})
        self._emit({"type": "sub", "minute": self.minute, "team": self.team,
                    "scorer": in_p.name, "scorer_id": in_id,
                    "position": in_p.position, "assist": out_p.name})
        return True, "ok"

    # ----------------------------------------------------------------- clock
    def tick(self, minutes: int = 1) -> List[dict]:
        """Advance up to `minutes` game-minutes; stop early at HT/ET/FT."""
        new_from = len(self.events)
        steps = 0
        self.break_flag = None
        while steps < max(1, min(int(minutes), 5)) and not self.done:
            self.minute += 1
            steps += 1
            drain = STAMINA_DRAIN.get(self.mentality, 0.57)
            for pid in self.xi:
                self.stamina[pid] = max(0.0, self.stamina[pid] - drain)
            self._opp_ai()
            p_us, p_opp = self._minute_lambdas()
            if self.rng.random() < p_us:
                self._goal(True)
            elif self.rng.random() < p_us * CHANCE_RATE:
                self._chance(True)
            if self.rng.random() < p_opp:
                self._goal(False)
            elif self.rng.random() < p_opp * CHANCE_RATE:
                self._chance(False)
            self._our_card()
            self._straight_reds()

            if self.minute == 45:
                self.break_flag = "HT"
                break
            if self.minute == 90:
                if self.knockout and self.hg == self.ag:
                    self.break_flag = "ET"
                    break
                self.done = True
                break
            if self.minute == 120:
                if self.hg == self.ag:
                    self._penalties()
                self.done = True
                break
        return self.events[new_from:]

    def _penalties(self) -> None:
        self.penalties = True
        elo_h = self.sh.effective_elo(self.h_adv)
        elo_a = self.sa.effective_elo(0.0)
        p_home = 0.5 + (win_expectancy(elo_h, elo_a) - 0.5) * 0.30
        self.home_pens, self.away_pens = _shootout(self.rng, p_home)
        self._emit({"type": "pens", "minute": 120, "team": self.home,
                    "scorer": f"{self.home_pens}-{self.away_pens}", "scorer_id": "",
                    "position": "", "assist": None})

    # ----------------------------------------------------------------- output
    @property
    def winner(self) -> Optional[str]:
        if self.hg > self.ag or (self.penalties and (self.home_pens or 0) > (self.away_pens or 0)):
            return self.home
        if self.ag > self.hg or (self.penalties and (self.away_pens or 0) > (self.home_pens or 0)):
            return self.away
        return None

    def period(self) -> str:
        if self.done:
            return "FT"
        if self.break_flag == "HT":
            return "HT"
        if self.break_flag == "ET":
            return "ET-BREAK"
        if self.minute <= 45:
            return "1H"
        if self.minute <= 90:
            return "2H"
        return "ET"

    def snapshot(self, new_events: Optional[List[dict]] = None) -> dict:
        return {
            "minute": self.minute, "period": self.period(),
            "home": self.home, "away": self.away,
            "home_goals": self.hg, "away_goals": self.ag,
            "our_side": "home" if self.us_home else "away",
            "events": self.events, "new_events": new_events or [],
            "xi": self.xi, "bench": self.bench,
            "stamina": {i: round(self.stamina[i]) for i in self.xi + self.bench},
            "subs_made": self.subs_made, "subs_remaining": SUBS_LIMIT - self.subs_made,
            "subs": self.subs, "mentality": self.mentality,
            "opp_mentality": self.opp_mentality,
            "our_red": self.our_red_minute, "opp_red": self.opp_red_minute,
            "break": self.break_flag, "done": self.done,
            "penalties": self.penalties,
            "home_pens": self.home_pens, "away_pens": self.away_pens,
            "knockout": self.knockout,
        }
