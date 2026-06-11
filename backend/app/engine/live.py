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
# How a goal came about (real-WC-ish split: ~10% pens, ~5% direct free kicks).
# Sources decorate goals AFTER the Poisson draw — scoring rates are untouched.
PENALTY_GOAL_SHARE = 0.10
FREEKICK_GOAL_SHARE = 0.06
# A penalty is won but NOT scored (saved/missed): pure drama, never a goal.
PEN_MISS_PER_MIN = 0.0009         # ≈ 0.08 per team per match
FREEKICK_CHANCE_SHARE = 0.18      # share of chances that are free kicks
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
ASSIST_W = {"FWD": 2.5, "MID": 4.0, "DEF": 1.2, "GK": 0.05}
ASSIST_PROB = 0.72
# Injuries: a knock leaves the player limping (stamina slashed -> effective
# rating drops via the fatigue slope). The manager decides: sub him off or
# gamble on heart. Carried knocks rule players out of following rounds.
INJURY_PROB_MATCH = 0.09          # per team, per match
INJURY_STAMINA = 22.0             # limping legs
# Attack style: reshapes WHO scores; small rate nudge only when the style is
# coherent with the passing instruction (route-one to the big man / overloads
# through midfield for the false nine).
ATTACK_STYLE = ("balanced", "target_man", "false_nine")
STYLE_RATE_BONUS = 1.04
STYLE_SCORER_BOOST = 1.8
# Time-wasting (game management): kills the game at both ends, saves legs,
# and referees increasingly punish it with stoppage-time pressure late on.
WASTE_OWN, WASTE_OPP, WASTE_DRAIN = 0.86, 0.90, 0.94

# --- Tactical dials (compose multiplicatively with mentality) ---------------
# Each setting: (own-rate mult, opponent-rate mult, stamina-drain mult).
# Values are research-directed (FM team-instruction trade-offs + real-football
# evidence: PPDA/high-turnover studies, possession-suppression research,
# pressing fatigue literature). The NET of mentality x all dials is clamped to
# [0.75, 1.25] per side so no combo breaks the Poisson calibration.
TEMPO = {
    "slow":     (0.90, 0.92, 0.95),   # patient build-up: low-event control
    "balanced": (1.00, 1.00, 1.00),
    "fast":     (1.12, 1.10, 1.15),   # end-to-end: chances both ways, tiring
}
PASSING = {
    "short":  (0.94, 0.90, 0.98),     # retention: starves BOTH attacks
    "mixed":  (1.00, 1.00, 1.00),
    "direct": (1.10, 1.06, 1.02),     # vertical: faster penetration, more turnovers
}
PRESSING = {
    "low_block": (0.92, 0.88, 0.90),  # sit deep: concede little, create little
    "mid":       (1.00, 1.00, 1.00),
    "high":      (1.10, 1.08, 1.28),  # high turnovers BOTH ways + heavy legs
}
NET_CLAMP = (0.75, 1.25)
# Identity synergies (small, asymmetric — reward coherent tactical setups).
COUNTER_BONUS = 1.06        # fast + direct vs an attacking opponent
CONTROL_OPP_SUPPRESS = 0.95 # slow + short additionally smothers the opponent
# High press on tired legs: documented late-game collapse — the opponent's
# rate climbs progressively as average stamina falls below the threshold.
PRESS_TIRED_STAMINA = 70.0
PRESS_TIRED_RATE = 0.005    # +0.5% opponent rate per stamina point below
PRESS_TIRED_CAP = 1.20


class LiveMatch:
    """One in-progress managed match, advanced a minute at a time."""

    def __init__(self, rng, team, home, away, knockout, sh, sa, h_adv,
                 squad, opp_players, xi_ids, mentality, date, cond_mult=None):
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
        # Per-player condition multipliers (sharpness/fatigue/morale), 1.0 = nominal.
        self.cond_mult: Dict[str, float] = cond_mult or {}

        # Suspended players are excluded from `squad`; silently drop any of
        # their ids from the requested XI rather than crashing mid-career.
        self.xi: List[str] = [i for i in xi_ids if i in self.by_id]
        self.bench: List[str] = [p.id for p in squad if p.id not in self.xi]
        self.played_ids: List[str] = list(self.xi)   # starters + subs used
        self.stamina: Dict[str, float] = {p.id: 100.0 for p in squad}
        self.mentality = mentality
        self.tempo = "balanced"
        self.passing = "mixed"
        self.pressing = "mid"
        self.attack_style = "balanced"
        self.time_wasting = False
        self.penalty_taker_id: Optional[str] = None
        self.injured_ids: List[str] = []           # knocks picked up this match
        self.opp_mentality = "balanced"
        self.opp_tempo = "balanced"
        self.opp_passing = "mixed"
        self.opp_pressing = "mid"
        self._opp_setup = ("balanced", "balanced", "mixed", "mid")

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
            tot += (p.rating * self.cond_mult.get(p.id, 1.0) - fatigue) * w
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
        base_us, base_opp = l_us, l_opp          # pre-tactics calibration anchor

        own, opp = MENTALITY.get(self.mentality, (1.0, 1.0))
        l_us, l_opp = l_us * own, l_opp * opp
        o_own, o_opp = MENTALITY.get(self.opp_mentality, (1.0, 1.0))
        l_opp, l_us = l_opp * o_own, l_us * o_opp

        # Tactical dials, ours then the opponent AI's.
        l_us, l_opp = self._apply_dials(l_us, l_opp, self.tempo, self.passing,
                                        self.pressing, self.opp_mentality)
        l_opp, l_us = self._apply_dials(l_opp, l_us, self.opp_tempo,
                                        self.opp_passing, self.opp_pressing,
                                        self.mentality)
        # Net clamp: mentality x dials may never move either side beyond ±25%
        # of the Elo-derived baseline — archetypes stay expressive, the
        # tournament-level goal calibration stays intact.
        # Coherent attack styles earn a small rate nudge (route-one with direct
        # passing; false-nine overloads with a short game).
        if ((self.attack_style == "target_man" and self.passing == "direct")
                or (self.attack_style == "false_nine" and self.passing == "short")):
            l_us *= STYLE_RATE_BONUS
        lo, hi = NET_CLAMP
        l_us = min(max(l_us, base_us * lo), base_us * hi)
        l_opp = min(max(l_opp, base_opp * lo), base_opp * hi)
        # Time-wasting stacks after the clamp: it is game management, not setup.
        if self.time_wasting:
            l_us *= WASTE_OWN
            l_opp *= WASTE_OPP
        # Fatigue collapse stacks AFTER the clamp (it is game state, not setup):
        # a high press on tired legs progressively opens space in behind.
        if self.pressing == "high":
            avg = self._avg_stamina()
            if avg < PRESS_TIRED_STAMINA:
                l_opp *= min(PRESS_TIRED_CAP,
                             1.0 + PRESS_TIRED_RATE * (PRESS_TIRED_STAMINA - avg))

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

    def _avg_stamina(self) -> float:
        if not self.xi:
            return 100.0
        return sum(self.stamina[i] for i in self.xi) / len(self.xi)

    @staticmethod
    def _apply_dials(l_own, l_other, tempo, passing, pressing, other_mentality):
        """Apply one side's tactical dials to (their rate, the opponent's rate)."""
        for table, key in ((TEMPO, tempo), (PASSING, passing), (PRESSING, pressing)):
            own_m, opp_m, _ = table.get(key, (1.0, 1.0, 1.0))
            l_own *= own_m
            l_other *= opp_m
        # Coherent identities get a nudge.
        if tempo == "fast" and passing == "direct" and other_mentality == "attacking":
            l_own *= COUNTER_BONUS                      # hit them on the break
        if tempo == "slow" and passing == "short":
            l_other *= CONTROL_OPP_SUPPRESS             # starve them of the ball
        return l_own, l_other

    # ------------------------------------------------------------ opponent AI
    def _opp_ai(self) -> None:
        diff = (self.ag - self.hg) if self.us_home else (self.hg - self.ag)
        if self.minute >= 75 and diff > 0:
            # Protect the lead: park the bus.
            self.opp_mentality, self.opp_tempo = "defensive", "slow"
            self.opp_passing, self.opp_pressing = "direct", "low_block"
            detail = "park the bus to protect the lead"
        elif self.minute >= 60 and diff < 0:
            # Chase the game: throw everything at it.
            self.opp_mentality, self.opp_tempo = "attacking", "fast"
            self.opp_passing, self.opp_pressing = "direct", "high"
            detail = "go all-out attack to chase the game"
        else:
            self.opp_mentality, self.opp_tempo = "balanced", "balanced"
            self.opp_passing, self.opp_pressing = "mixed", "mid"
            detail = "reset to a balanced shape"
        setup = (self.opp_mentality, self.opp_tempo, self.opp_passing, self.opp_pressing)
        if setup != self._opp_setup:
            # Make the bench react VISIBLY — the manager can counter it.
            self._opp_setup = setup
            opp_side = self.away if self.us_home else self.home
            self._emit({"type": "tactic", "minute": self.minute, "team": opp_side,
                        "scorer": "", "scorer_id": "", "position": "",
                        "assist": None, "detail": detail,
                        "mentality": self.opp_mentality, "tempo": self.opp_tempo,
                        "passing": self.opp_passing, "pressing": self.opp_pressing})

    # --------------------------------------------------------------- events
    def _on_pitch(self, ours: bool):
        if ours:
            return [self.by_id[i] for i in self.xi if i in self.by_id]
        return self.opp_players

    def _pick(self, players, attacking=True, ours=False):
        if not players:
            return None
        if attacking:
            w = [SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players]
            if ours and self.attack_style != "balanced":
                boosted = "FWD" if self.attack_style == "target_man" else "MID"
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

    def _emit(self, ev: dict) -> dict:
        self.events.append(ev)
        return ev

    def _goal_source(self) -> str:
        r = self.rng.random()
        if r < PENALTY_GOAL_SHARE:
            return "penalty"
        if r < PENALTY_GOAL_SHARE + FREEKICK_GOAL_SHARE:
            return "freekick"
        return "open"

    def _goal(self, our_side: bool) -> dict:
        side = self.team if our_side else (self.away if self.us_home else self.home)
        on_pitch = self._on_pitch(our_side)
        source = self._goal_source()
        scorer = None
        if source == "penalty" and our_side and self.penalty_taker_id in self.xi:
            scorer = self.by_id.get(self.penalty_taker_id)
        if scorer is None:
            scorer = self._pick(on_pitch, attacking=True, ours=our_side)
        if (our_side and self.us_home) or (not our_side and not self.us_home):
            self.hg += 1
        else:
            self.ag += 1
        ev = {
            "type": "goal", "minute": self.minute, "team": side,
            "scorer": scorer.name if scorer else side,
            "scorer_id": scorer.id if scorer else "",
            "position": scorer.position if scorer else "", "assist": None,
            "source": source,
        }
        # Credit an assist for open-play goals (set pieces and pens excluded).
        if source == "open" and scorer and self.rng.random() < ASSIST_PROB:
            mates = [p for p in on_pitch if p.id != scorer.id]
            if mates:
                w = [ASSIST_W.get(p.position, 1.0) * (p.rating / 80.0) for p in mates]
                tot = sum(w)
                r = self.rng.random() * tot
                for p, x in zip(mates, w):
                    r -= x
                    if r <= 0:
                        ev["assist"], ev["assist_id"] = p.name, p.id
                        ev["assist_position"] = p.position
                        break
        return self._emit(ev)

    def _chance(self, our_side: bool) -> dict:
        side = self.team if our_side else (self.away if self.us_home else self.home)
        player = self._pick(self._on_pitch(our_side), attacking=True)
        outcome = ["saved", "missed", "woodwork"][int(self.rng.random() * 3) % 3]
        ev = {
            "type": "chance", "minute": self.minute, "team": side,
            "scorer": player.name if player else side,
            "scorer_id": player.id if player else "",
            "position": player.position if player else "",
            "assist": None, "outcome": outcome,
        }
        if self.rng.random() < FREEKICK_CHANCE_SHARE:
            ev["set_piece"] = "freekick"
        return self._emit(ev)

    def _penalty_miss(self, our_side: bool) -> dict:
        """A penalty is won but squandered — drama only, the score never moves."""
        side = self.team if our_side else (self.away if self.us_home else self.home)
        player = self._pick(self._on_pitch(our_side), attacking=True)
        return self._emit({
            "type": "penalty_miss", "minute": self.minute, "team": side,
            "scorer": player.name if player else side,
            "scorer_id": player.id if player else "",
            "position": player.position if player else "", "assist": None,
            "outcome": "saved" if self.rng.random() < 0.72 else "missed",
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

    def _injury_roll(self) -> None:
        """One of ours may pick up a knock: he limps on until YOU decide.

        The injured player's stamina is slashed (his effective rating drops
        through the fatigue slope), so the manager faces the classic call —
        burn a substitution or gamble on heart. The knock also carries into
        the next round(s) via ManagedTournament.injured.
        """
        if self.rng.random() >= INJURY_PROB_MATCH / 90.0:
            return
        candidates = [self.by_id[i] for i in self.xi
                      if i in self.by_id and i not in self.injured_ids]
        if not candidates:
            return
        p = candidates[int(self.rng.random() * len(candidates))]
        self.injured_ids.append(p.id)
        self.stamina[p.id] = min(self.stamina[p.id], INJURY_STAMINA)
        self._emit({"type": "injury", "minute": self.minute, "team": self.team,
                    "scorer": p.name, "scorer_id": p.id, "position": p.position,
                    "assist": None,
                    "detail": "is down injured — sub him or gamble on heart"})

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

    def set_tactics(self, mentality=None, tempo=None, passing=None, pressing=None,
                    attack_style=None, time_wasting=None, penalty_taker=None) -> bool:
        """Update any subset of the tactical dials; unknown values are ignored."""
        changed = False
        if mentality in MENTALITY:
            self.mentality = mentality
            changed = True
        if tempo in TEMPO:
            self.tempo = tempo
            changed = True
        if passing in PASSING:
            self.passing = passing
            changed = True
        if pressing in PRESSING:
            self.pressing = pressing
            changed = True
        if attack_style in ATTACK_STYLE:
            self.attack_style = attack_style
            changed = True
        if time_wasting is not None:
            self.time_wasting = bool(time_wasting)
            changed = True
        if penalty_taker is not None:
            if penalty_taker in self.by_id:
                self.penalty_taker_id = penalty_taker
                changed = True
            elif penalty_taker == "":
                self.penalty_taker_id = None
                changed = True
        return changed

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
        self.played_ids.append(in_id)
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
            drain = (STAMINA_DRAIN.get(self.mentality, 0.57)
                     * TEMPO.get(self.tempo, (1, 1, 1))[2]
                     * PRESSING.get(self.pressing, (1, 1, 1))[2]
                     * (WASTE_DRAIN if self.time_wasting else 1.0))
            for pid in self.xi:
                self.stamina[pid] = max(0.0, self.stamina[pid] - drain)
            self._injury_roll()
            self._opp_ai()
            p_us, p_opp = self._minute_lambdas()
            if self.rng.random() < p_us:
                self._goal(True)
            elif self.rng.random() < p_us * CHANCE_RATE:
                self._chance(True)
            elif self.rng.random() < PEN_MISS_PER_MIN:
                self._penalty_miss(True)
            if self.rng.random() < p_opp:
                self._goal(False)
            elif self.rng.random() < p_opp * CHANCE_RATE:
                self._chance(False)
            elif self.rng.random() < PEN_MISS_PER_MIN:
                self._penalty_miss(False)
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
            "tempo": self.tempo, "passing": self.passing, "pressing": self.pressing,
            "attack_style": self.attack_style, "time_wasting": self.time_wasting,
            "penalty_taker": self.penalty_taker_id,
            "injured": list(self.injured_ids),
            "opp_mentality": self.opp_mentality,
            "opp_tempo": self.opp_tempo, "opp_passing": self.opp_passing,
            "opp_pressing": self.opp_pressing,
            "avg_stamina": round(self._avg_stamina()),
            "our_red": self.our_red_minute, "opp_red": self.opp_red_minute,
            "break": self.break_flag, "done": self.done,
            "penalties": self.penalties,
            "home_pens": self.home_pens, "away_pens": self.away_pens,
            "knockout": self.knockout,
        }
