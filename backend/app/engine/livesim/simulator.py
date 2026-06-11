"""Possession-chain match engine (replaces per-minute Bernoulli thinning).

Each game-minute one side has the ball (share weighted by midfield ratings +
mentality). That side generates a possession chain — a Poisson(λ=4.5)-length
sequence of PASS / DRIBBLE events, interleaved with PRESS events from the
defending side, ending in a SHOT, a FOUL won, or a turnover. Shots resolve
through a logistic conversion model:

    P(goal | shot) = sigmoid((attack_strength - defend_strength) / 200
                             + mentality_bias + SHOT_OFFSET)

SHOT_OFFSET (-2.0) is the calibration anchor: with equal strengths and a
balanced mentality conversion sits at ≈ 12%, the real-football rate. Shot
FREQUENCY is then derived from the same Elo/Poisson per-minute goal rates the
rest of the engine uses (`_minute_lambdas`), so a chain-engine match has the
same expected scoreline as the analytic model — tactics dials, red cards and
the late-game surge all still apply.

ChainMatch subclasses the proven LiveMatch for everything that is not the
event model: substitution legality, card discipline, penalties, tactical
dials, and the snapshot/finalisation contract used by ManagedTournament.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from app.engine.live import (
    LiveMatch,
    PEN_MISS_PER_MIN,
    PRESSING,
    RED_CARD_PROB,
    SUBS_LIMIT,
    TEMPO,
    WASTE_DRAIN,
)
from app.engine.livesim.ai import OppAI
from app.engine.livesim.events import EventType, MatchEvent
from app.engine.livesim.stamina import (
    DEFAULT_FORM,
    assign_roles,
    decay_for,
    effective_rating,
    formation_slots,
)
from app.engine.squad import POS_WEIGHT, RATING_TO_ELO, optimal_score

CHAIN_LAMBDA = 4.5
SHOT_OFFSET = -2.0
MENTALITY_BIAS = {"attacking": 0.10, "balanced": 0.0, "defensive": -0.10}
MENTALITY_POSSESSION = {"attacking": 0.05, "balanced": 0.0, "defensive": -0.05}
MIDFIELD_POSS_SCALE = 0.004      # possession points per midfield-rating point
FOUL_END_PROB = 0.10             # chain ends in a foul won
CORNER_AFTER_SAVE = 0.40
CORNER_HEADER_SHOT = 0.25
ERROR_ON_CONCEDE = 0.30
# Injuries. Two risk layers per outfield player per minute:
#  * a small baseline match-knock rate (≈9% per team per match, matching the
#    long-standing career-mode injury frequency), and
#  * the exhaustion model: below 30 stamina the risk is amplified by
#    0.0008 * (1 + (30 - stamina) / 30) on top.
INJURY_STAMINA_CUTOFF = 30.0
INJURY_BASE = 0.0008
INJURY_KNOCK_PER_PLAYER_MIN = 0.0001   # 10 outfielders * 90' ~= 0.09 / match
INJURY_SEVERITY = (("minor", 0, 0.50), ("moderate", 1, 0.35), ("serious", 2, 0.15))


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


class ChainMatch(LiveMatch):
    """LiveMatch with a possession-chain event model, positional stamina,
    player form, frame streaming (positions + ball + stats) and ratings."""

    def __init__(self, *args, form: Optional[Dict[str, float]] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.form: Dict[str, float] = dict(form or {})
        self.opp_code = self.away if self.us_home else self.home
        self.opp_on_pitch = list(self.opp_players)
        self.opp_stamina: Dict[str, float] = {p.id: 100.0 for p in self.opp_players}
        self.opp_ai = OppAI()

        self.minutes_played: Dict[str, int] = {pid: 0 for pid in self.xi}
        self.pstats: Dict[str, dict] = defaultdict(
            lambda: {"goals": 0, "assists": 0, "key_passes": 0, "errors": 0,
                     "shots": 0, "on_target": 0})
        self.injury_rounds: Dict[str, int] = {}   # pid -> matches missed
        self.injury_types: Dict[str, str] = {}

        self.match_stats = {
            "possession": {"home": 0, "away": 0},   # minute counts
            "shots": {"home": 0, "away": 0},
            "on_target": {"home": 0, "away": 0},
            "corners": {"home": 0, "away": 0},
            "fouls": {"home": 0, "away": 0},
        }
        self.ball_xy: Tuple[float, float] = (50.0, 50.0)
        self.possession_team = "home"
        self.tick_events: List[dict] = []
        self._drift: Dict[str, Tuple[float, float]] = {}
        self._last_passer: Dict[bool, Optional[str]] = {True: None, False: None}
        self._refresh_shape()

    # ------------------------------------------------------------- shape
    def _refresh_shape(self) -> None:
        ours = [self.by_id[i] for i in self.xi if i in self.by_id]
        self.roles = assign_roles(ours)
        self.slots = formation_slots(ours, self.roles)
        self.opp_roles = assign_roles(self.opp_on_pitch)
        self.opp_slots = formation_slots(self.opp_on_pitch, self.opp_roles)

    # ----------------------------------------------------------- strength
    def _player_eff(self, p, ours: bool) -> float:
        if ours:
            return effective_rating(
                p.rating, self.stamina.get(p.id, 100.0),
                self.form.get(p.id, DEFAULT_FORM), self.cond_mult.get(p.id, 1.0))
        return effective_rating(p.rating, self.opp_stamina.get(p.id, 100.0))

    def _effective_delta(self) -> float:
        """Lineup Elo delta from live effective ratings (form + stamina)."""
        players = [self.by_id[i] for i in self.xi if i in self.by_id]
        if not players:
            return -250.0
        tot = wt = 0.0
        for p in players:
            w = POS_WEIGHT.get(p.position, 1.0)
            tot += self._player_eff(p, True) * w
            wt += w
        delta = (tot / wt - optimal_score(self.squad)) * RATING_TO_ELO
        return min(0.0, max(-300.0, delta))

    def _group_eff(self, ours: bool, positions: tuple) -> float:
        pool = ([self.by_id[i] for i in self.xi if i in self.by_id] if ours
                else self.opp_on_pitch)
        picked = [p for p in pool if p.position in positions] or pool
        return sum(self._player_eff(p, ours) for p in picked) / len(picked)

    # --------------------------------------------------------- possession
    def _possession_home_share(self) -> float:
        mid_h = self._group_eff(self.us_home, ("MID",))
        mid_a = self._group_eff(not self.us_home, ("MID",))
        ment_h = self.mentality if self.us_home else self.opp_mentality
        ment_a = self.opp_mentality if self.us_home else self.mentality
        share = (0.5
                 + MENTALITY_POSSESSION.get(ment_h, 0.0)
                 - MENTALITY_POSSESSION.get(ment_a, 0.0)
                 + (mid_h - mid_a) * MIDFIELD_POSS_SCALE)
        return max(0.25, min(0.75, share))

    # ------------------------------------------------------------ helpers
    def _micro(self, etype: EventType, our_side: bool, player=None,
               x: float = 50.0, y: float = 50.0, **extra) -> dict:
        side_home = self.us_home == our_side
        ev = MatchEvent(
            type=etype.value, minute=self.minute,
            team=self.team if our_side else self.opp_code,
            side="home" if side_home else "away",
            player_id=getattr(player, "id", "") if player else "",
            player=getattr(player, "name", "") if player else "",
            x=round(x, 1), y=round(y, 1), **extra,
        ).to_dict()
        self.tick_events.append(ev)
        if player is not None:
            self._drift[player.id] = (x, y)
        self.ball_xy = (x, y)
        return ev

    def _side_key(self, our_side: bool) -> str:
        return "home" if self.us_home == our_side else "away"

    def _weighted(self, players: List, weights: List[float]):
        tot = sum(weights)
        if not players or tot <= 0:
            return players[0] if players else None
        r = self.rng.random() * tot
        for p, w in zip(players, weights):
            r -= w
            if r <= 0:
                return p
        return players[-1]

    def _pick_role(self, our_side: bool, role_weights: Dict[str, float]):
        pool = ([self.by_id[i] for i in self.xi if i in self.by_id] if our_side
                else self.opp_on_pitch)
        roles = self.roles if our_side else self.opp_roles
        ws = [role_weights.get(roles.get(p.id, "CM"), 0.2) * (p.rating / 80.0)
              for p in pool]
        return self._weighted(pool, ws)

    # Role weights: who touches the ball for each action type.
    PASS_W = {"GK": 0.3, "LB": 1.0, "RB": 1.0, "CB": 0.9, "DM": 1.6, "CM": 2.0,
              "AM": 1.6, "LW": 0.9, "RW": 0.9, "CF": 0.6}
    DRIBBLE_W = {"GK": 0.02, "LB": 0.7, "RB": 0.7, "CB": 0.15, "DM": 0.4,
                 "CM": 0.8, "AM": 1.5, "LW": 2.0, "RW": 2.0, "CF": 1.2}
    PRESS_W = {"GK": 0.02, "LB": 1.0, "RB": 1.0, "CB": 1.2, "DM": 1.6,
               "CM": 1.3, "AM": 0.8, "LW": 0.6, "RW": 0.6, "CF": 0.5}
    SHOT_W = {"GK": 0.01, "LB": 0.15, "RB": 0.15, "CB": 0.2, "DM": 0.3,
              "CM": 0.7, "AM": 1.6, "LW": 1.7, "RW": 1.7, "CF": 3.0}

    # ----------------------------------------------------------------- clock
    def tick(self, minutes: int = 1) -> List[dict]:
        """Advance up to `minutes` game-minutes via possession chains."""
        self.tick_events = []
        new_from = len(self.events)
        steps = 0
        self.break_flag = None
        while steps < max(1, min(int(minutes), 5)) and not self.done:
            self.minute += 1
            steps += 1
            self._advance_minute()
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

    def _advance_minute(self) -> None:
        self._drift = {}
        for pid in self.xi:
            self.minutes_played[pid] = self.minutes_played.get(pid, 0) + 1

        # 1. Positional stamina decay (ours: tactical multipliers stack).
        tact = (TEMPO.get(self.tempo, (1, 1, 1))[2]
                * PRESSING.get(self.pressing, (1, 1, 1))[2]
                * (WASTE_DRAIN if self.time_wasting else 1.0))
        for pid in self.xi:
            rate = decay_for(self.roles.get(pid, "CM"), self.mentality) * tact
            self.stamina[pid] = max(0.0, self.stamina[pid] - rate)
        opp_tact = (TEMPO.get(self.opp_tempo, (1, 1, 1))[2]
                    * PRESSING.get(self.opp_pressing, (1, 1, 1))[2])
        for p in self.opp_on_pitch:
            rate = decay_for(self.opp_roles.get(p.id, "CM"), self.opp_mentality) * opp_tact
            self.opp_stamina[p.id] = max(0.0, self.opp_stamina[p.id] - rate)

        # 2. Stamina-driven injuries (forced subs).
        self._injury_model()

        # 3. Opposition AI re-evaluates every 5 minutes.
        self._run_opp_ai()

        # 4. Per-minute goal expectation from the calibrated Elo/Poisson model.
        p_us, p_opp = self._minute_lambdas()

        # 5. Who has the ball this minute?
        p_home = self._possession_home_share()
        home_ball = self.rng.random() < p_home
        we_have_ball = home_ball == self.us_home
        self.possession_team = "home" if home_ball else "away"
        self.match_stats["possession"]["home" if home_ball else "away"] += 1

        # 6. Possession chains (both sides draw; the off-ball side presses).
        if we_have_ball:
            self._chain(True, p_us, p_home if self.us_home else 1 - p_home)
        else:
            self._chain(False, p_opp, p_home if not self.us_home else 1 - p_home)

        # 7. Set-piece drama + discipline (proven base-class machinery).
        if self.rng.random() < PEN_MISS_PER_MIN:
            ev = self._penalty_miss(we_have_ball)
            self.tick_events.append(ev)
        card = self._our_card()
        if card is not None:
            self._mirror_card(card)
        self._straight_reds()

    # ------------------------------------------------------------- opp AI
    def _run_opp_ai(self) -> None:
        opp_goals = self.ag if self.us_home else self.hg
        our_goals = self.hg if self.us_home else self.ag
        change = self.opp_ai.evaluate(self.minute, opp_goals - our_goals,
                                      self.opp_red_minute is not None)
        if change is None:
            return
        self.opp_mentality, self.opp_tempo = change.mentality, change.tempo
        self.opp_passing, self.opp_pressing = change.passing, change.pressing
        self._opp_setup = (change.mentality, change.tempo, change.passing,
                           change.pressing)
        if change.cb_in_midfield:
            # Push a CB into midfield: re-tag the lowest-rated CB as a DM.
            cbs = [p for p in self.opp_on_pitch
                   if self.opp_roles.get(p.id) == "CB"]
            if len(cbs) > 1:
                mover = min(cbs, key=lambda p: p.rating)
                self.opp_roles[mover.id] = "DM"
                self.opp_slots[mover.id] = (34.0, self.opp_slots[mover.id][1])
        # Spec-shaped frame event + legacy headline event (old UIs show it).
        self._micro(EventType.OPP_TACTICAL_CHANGE, False, None, 50, 50,
                    new_mentality=change.mentality, reason=change.reason)
        self._emit({"type": "tactic", "minute": self.minute, "team": self.opp_code,
                    "scorer": "", "scorer_id": "", "position": "", "assist": None,
                    "detail": change.reason, "new_mentality": change.mentality,
                    "mentality": self.opp_mentality, "tempo": self.opp_tempo,
                    "passing": self.opp_passing, "pressing": self.opp_pressing})

    # ------------------------------------------------------------ injuries
    def _injury_model(self) -> None:
        """Tired legs snap: outfield players under 30 stamina risk injury."""
        for pid in list(self.xi):
            p = self.by_id.get(pid)
            if p is None or p.position == "GK" or pid in self.injured_ids:
                continue
            st = self.stamina.get(pid, 100.0)
            prob = INJURY_KNOCK_PER_PLAYER_MIN
            if st < INJURY_STAMINA_CUTOFF:
                prob += INJURY_BASE * (1.0 + (INJURY_STAMINA_CUTOFF - st)
                                       / INJURY_STAMINA_CUTOFF)
            if self.rng.random() >= prob:
                continue
            severity = self._roll_severity()
            label, miss, _ = severity
            self.injured_ids.append(pid)
            self.injury_rounds[pid] = miss
            self.injury_types[pid] = label
            self._micro(EventType.INJURY, True, p, *self.slots.get(pid, (50, 50)),
                        reason=label)
            self._emit({"type": "injury", "minute": self.minute, "team": self.team,
                        "scorer": p.name, "scorer_id": pid, "position": p.position,
                        "assist": None, "severity": label,
                        "detail": f"{label} injury — forced off"
                                  + (f", misses {miss} match(es)" if miss else "")})
            self._forced_sub(pid)

    def _roll_severity(self):
        r = self.rng.random()
        acc = 0.0
        for sev in INJURY_SEVERITY:
            acc += sev[2]
            if r < acc:
                return sev
        return INJURY_SEVERITY[-1]

    def _forced_sub(self, out_id: str) -> None:
        """Injured player leaves the pitch; auto-sub burns one of the five."""
        out_p = self.by_id.get(out_id)
        if self.subs_made < SUBS_LIMIT and self.bench:
            candidates = sorted(
                self.bench,
                key=lambda i: ((self.by_id[i].position != out_p.position),
                               -self.by_id[i].rating))
            for in_id in candidates:
                ok, _ = self.substitute(out_id, in_id)
                if ok:
                    return
        # No legal replacement: play short-handed.
        self.xi = [i for i in self.xi if i != out_id]
        self._refresh_shape()

    # --------------------------------------------------------------- cards
    def _mirror_card(self, card: dict) -> None:
        p = self.by_id.get(card.get("scorer_id"))
        et = EventType.RED if card["type"] == "red" else EventType.YELLOW
        self._micro(et, True, p, *self.slots.get(card.get("scorer_id"), (50, 50)))
        self.match_stats["fouls"][self._side_key(True)] += 1
        if card["type"] == "red":
            self._refresh_shape()

    def _straight_reds(self) -> None:
        if self.our_red_minute is None and self.rng.random() < RED_CARD_PROB / 90.0:
            p = self._pick(self._on_pitch(True), attacking=False)
            if p:
                self.our_red_minute = self.minute
                self.red_ids.append(p.id)
                self.xi = [i for i in self.xi if i != p.id]
                self._refresh_shape()
                ev = self._emit({"type": "red", "minute": self.minute,
                                 "team": self.team, "scorer": p.name,
                                 "scorer_id": p.id, "position": p.position,
                                 "assist": None})
                self._micro(EventType.RED, True, p)
                self.match_stats["fouls"][self._side_key(True)] += 1
        if self.opp_red_minute is None and self.rng.random() < RED_CARD_PROB / 90.0:
            p = self._pick(self.opp_on_pitch, attacking=False)
            self.opp_red_minute = self.minute
            if p:
                self.opp_on_pitch = [q for q in self.opp_on_pitch if q.id != p.id]
                self._refresh_shape()
            self._emit({"type": "red", "minute": self.minute, "team": self.opp_code,
                        "scorer": p.name if p else self.opp_code,
                        "scorer_id": p.id if p else "",
                        "position": p.position if p else "", "assist": None})
            self._micro(EventType.RED, False, p)
            self.match_stats["fouls"][self._side_key(False)] += 1

    def _on_pitch(self, ours: bool):
        if ours:
            return [self.by_id[i] for i in self.xi if i in self.by_id]
        return self.opp_on_pitch

    # --------------------------------------------------------------- chains
    def _chain(self, our_side: bool, p_goal_min: float, poss_share: float) -> None:
        """One possession chain for the on-ball side, pressed by the other."""
        side_home = self.us_home == our_side
        # Park-the-bus keep-ball: longer, slower chains.
        lam = CHAIN_LAMBDA + (0.0 if our_side else self.opp_ai.state.chain_bonus)
        if our_side and self.time_wasting:
            lam += 1.0
        n = max(1, min(10, int(self.rng.poisson(lam))))
        n_press = max(0, min(3, int(self.rng.poisson(CHAIN_LAMBDA) * 0.3)))

        # Ball path: build-up third -> attacking third (mirrored for away).
        x0, x1 = (30.0, 86.0) if side_home else (70.0, 14.0)
        y = 15.0 + self.rng.random() * 70.0
        self._last_passer[our_side] = None
        press_at = set(int(self.rng.random() * n) for _ in range(n_press))
        for k in range(n):
            t = (k + 1) / n
            x = x0 + (x1 - x0) * t * (0.85 + self.rng.random() * 0.3)
            y = max(8.0, min(92.0, y + (self.rng.random() - 0.5) * 24.0))
            if self.rng.random() < 0.76:
                p = self._pick_role(our_side, self.PASS_W)
                self._micro(EventType.PASS, our_side, p, x, y)
                self._last_passer[our_side] = p.id if p else None
            else:
                p = self._pick_role(our_side, self.DRIBBLE_W)
                self._micro(EventType.DRIBBLE, our_side, p, x, y)
            if k in press_at:
                d = self._pick_role(not our_side, self.PRESS_W)
                self._micro(EventType.PRESS, not our_side, d, x, y)

        # Chain resolution.
        conv = self._conversion(our_side)
        shot_mult = self.opp_ai.state.shot_mult if not our_side else 1.0
        denom = max(0.05, poss_share) * max(1e-6, conv)
        shot_p = min(0.65, (p_goal_min / denom) * shot_mult)
        r = self.rng.random()
        if r < shot_p:
            self._shot(our_side, conv, x1, y)
        elif r < shot_p + FOUL_END_PROB:
            d = self._pick_role(not our_side, self.PRESS_W)
            fx = x1 * 0.85 + (50.0 * 0.15)
            self._micro(EventType.FOUL, not our_side, d, fx, y)
            self.match_stats["fouls"]["away" if side_home else "home"] += 1
        # else: turnover — possession simply ends.

    def _conversion(self, our_side: bool) -> float:
        att = self._group_eff(our_side, ("FWD", "MID"))
        deff = self._group_eff(not our_side, ("DEF", "GK"))
        ment = self.mentality if our_side else self.opp_mentality
        return sigmoid((att - deff) / 200.0
                       + MENTALITY_BIAS.get(ment, 0.0) + SHOT_OFFSET)

    def _shot(self, our_side: bool, conv: float, gx: float, gy: float) -> None:
        side_home = self.us_home == our_side
        sk = "home" if side_home else "away"
        self.match_stats["shots"][sk] += 1
        goal_x = 95.0 if side_home else 5.0
        goal_y = 38.0 + self.rng.random() * 24.0

        if self.rng.random() < conv:
            # ---- GOAL: the base-class scorer/assist/source machinery owns it.
            ev = self._goal(our_side)
            scorer = (self.by_id.get(ev.get("scorer_id"))
                      if our_side else next(
                          (p for p in self.opp_on_pitch if p.id == ev.get("scorer_id")),
                          None))
            self.match_stats["on_target"][sk] += 1
            self.pstats[ev.get("scorer_id", "")]["goals"] += 1
            self.pstats[ev.get("scorer_id", "")]["shots"] += 1
            self.pstats[ev.get("scorer_id", "")]["on_target"] += 1
            if ev.get("assist_id"):
                self.pstats[ev["assist_id"]]["assists"] += 1
            if ev.get("source") == "penalty":
                self._micro(EventType.PENALTY, our_side, scorer, goal_x, 50.0)
            self._micro(EventType.SHOT, our_side, scorer, goal_x, goal_y,
                        outcome="goal")
            self._micro(EventType.GOAL, our_side, scorer,
                        100.0 if side_home else 0.0, 50.0)
            # Defensive error bookkeeping on the conceding side (open play).
            if ev.get("source") == "open" and self.rng.random() < ERROR_ON_CONCEDE:
                culprit = self._pick_role(not our_side, self.PRESS_W)
                if culprit is not None:
                    self.pstats[culprit.id]["errors"] += 1
            return

        # ---- Non-goal shot: save / woodwork / wide (+ corners off saves).
        shooter = self._pick_role(our_side, self.SHOT_W)
        if shooter is not None:
            self.pstats[shooter.id]["shots"] += 1
            kp = self._last_passer.get(our_side)
            if kp and kp != shooter.id:
                self.pstats[kp]["key_passes"] += 1
        r = self.rng.random()
        outcome = "saved" if r < 0.45 else "woodwork" if r < 0.53 else "missed"
        self._micro(EventType.SHOT, our_side, shooter, goal_x, goal_y,
                    outcome="saved" if outcome == "saved"
                    else "woodwork" if outcome == "woodwork" else "off_target")
        # Headline "chance" keeps the old feed/crowd/test contract alive.
        self._emit({"type": "chance", "minute": self.minute,
                    "team": self.team if our_side else self.opp_code,
                    "scorer": shooter.name if shooter else "",
                    "scorer_id": shooter.id if shooter else "",
                    "position": shooter.position if shooter else "",
                    "assist": None, "outcome": outcome})
        if outcome == "saved":
            self.match_stats["on_target"][sk] += 1
            if shooter is not None:
                self.pstats[shooter.id]["on_target"] += 1
            gk = next((p for p in self._on_pitch(not our_side)
                       if p.position == "GK"), None)
            self._micro(EventType.SAVE, not our_side, gk, goal_x, 50.0)
            if self.rng.random() < CORNER_AFTER_SAVE:
                self._corner(our_side, side_home)

    def _corner(self, our_side: bool, side_home: bool) -> None:
        sk = "home" if side_home else "away"
        self.match_stats["corners"][sk] += 1
        cx = 99.0 if side_home else 1.0
        cy = 2.0 if self.rng.random() < 0.5 else 98.0
        taker = self._pick_role(our_side, self.PASS_W)
        self._micro(EventType.CORNER, our_side, taker, cx, cy)
        if self.rng.random() < CORNER_HEADER_SHOT:
            self._shot(our_side, self._conversion(our_side) * 0.8,
                       95.0 if side_home else 5.0, 50.0)

    # ------------------------------------------------------------ overrides
    def substitute(self, out_id: str, in_id: str):
        ok, msg = super().substitute(out_id, in_id)
        if ok:
            self.minutes_played.setdefault(in_id, 0)
            self._refresh_shape()
            self._micro(EventType.SUB, True, self.by_id.get(in_id),
                        *self.slots.get(in_id, (50.0, 50.0)))
        return ok, msg

    # -------------------------------------------------------------- frames
    def player_positions(self) -> List[dict]:
        out: List[dict] = []
        bx, by = self.ball_xy

        def add(p, slots, roles, ours: bool) -> None:
            side_home = self.us_home == ours
            x, y = slots.get(p.id, (50.0, 50.0))
            if not side_home:
                x, y = 100.0 - x, 100.0 - y
            # Involved players drift up to ±8 units toward the ball.
            if p.id in self._drift:
                tx, ty = self._drift[p.id]
                x += max(-8.0, min(8.0, tx - x))
                y += max(-8.0, min(8.0, ty - y))
            else:
                # Whole team leans with possession (small, FM-style).
                lean = 3.0 if (self.possession_team == ("home" if side_home else "away")) else -2.0
                x += lean if side_home else -lean
                x += (bx - 50.0) * 0.06
            out.append({
                "player_id": p.id, "name": p.name, "number": getattr(p, "number", 0),
                "role": (roles.get(p.id, "CM")),
                "team": "home" if side_home else "away",
                "x": round(max(1.0, min(99.0, x)), 1),
                "y": round(max(2.0, min(98.0, y)), 1),
            })

        for pid in self.xi:
            p = self.by_id.get(pid)
            if p:
                add(p, self.slots, self.roles, True)
        for p in self.opp_on_pitch:
            add(p, self.opp_slots, self.opp_roles, False)
        return out

    def stats_payload(self) -> dict:
        poss = self.match_stats["possession"]
        total = max(1, poss["home"] + poss["away"])
        return {
            "possession": {"home": round(100 * poss["home"] / total),
                           "away": round(100 * poss["away"] / total)},
            "shots": dict(self.match_stats["shots"]),
            "on_target": dict(self.match_stats["on_target"]),
            "corners": dict(self.match_stats["corners"]),
            "fouls": dict(self.match_stats["fouls"]),
        }

    def ratings(self) -> List[dict]:
        """Post-match 1-10 ratings for every player of ours who played."""
        opp_goals = self.ag if self.us_home else self.hg
        rows: List[dict] = []
        for pid, mins in self.minutes_played.items():
            if mins <= 0:
                continue
            p = self.by_id.get(pid)
            if p is None:
                continue
            s = self.pstats.get(pid, {})
            role = self.roles.get(pid, "CM")
            cs_bonus = 0.5 if (opp_goals == 0 and role in ("GK", "CB")) else 0.0
            val = (6.0 + s.get("goals", 0) * 1.5 + s.get("assists", 0) * 0.8
                   + s.get("key_passes", 0) * 0.3 - s.get("errors", 0) * 0.5
                   + cs_bonus)
            rows.append({
                "player_id": pid, "name": p.name, "position": p.position,
                "role": role, "number": getattr(p, "number", 0),
                "minutes": mins, "goals": s.get("goals", 0),
                "assists": s.get("assists", 0),
                "rating": round(max(4.0, min(10.0, val)), 1),
            })
        rows.sort(key=lambda r: r["rating"], reverse=True)
        if rows:
            rows[0]["motm"] = True
        return rows

    def snapshot(self, new_events: Optional[List[dict]] = None) -> dict:
        snap = super().snapshot(new_events)
        snap["form"] = {pid: round(self.form.get(pid, DEFAULT_FORM), 2)
                        for pid in self.stamina}
        snap["stats"] = self.stats_payload()
        snap["minutes_played"] = dict(self.minutes_played)
        snap["injury_types"] = dict(self.injury_types)
        if self.done:
            snap["player_ratings"] = self.ratings()
        return snap

    def frame(self, new_events: Optional[List[dict]] = None) -> dict:
        """One server-push frame (the WebSocket payload)."""
        return {
            "minute": self.minute,
            "score": {"home": self.hg, "away": self.ag},
            "events": list(self.tick_events) + [
                {**e, "headline": True} for e in (new_events or [])],
            "player_positions": self.player_positions(),
            "ball_xy": [round(self.ball_xy[0], 1), round(self.ball_xy[1], 1)],
            "possession_team": self.possession_team,
            "match_phase": self.period(),
            "stats": self.stats_payload(),
            "snapshot": self.snapshot(new_events),
        }
