"""Per-player condition: match sharpness, fatigue and morale.

Shared by career mode and multiplayer. Players who do not play go rusty
(sharpness falls), players who play every match accumulate fatigue, and
morale moves with selection, results and dressing-room decisions. The three
combine into a per-player rating multiplier, and a chosen XI's average
condition becomes an extra Elo delta on top of the lineup-quality delta —
so rotating the squad through the group stage is a genuine decision.

Tuning intent (group stage = 3 matches):
  * An ever-present starter ends the groups around 55-60 fatigue (~5% rating
    penalty) — playable, but a tired XI in the R32 against fresh legs hurts.
  * A never-used sub drops to ~50 sharpness (~6% penalty) — match-rusty.
  * Morale swings are smaller (±2-3%) but stack with events and results.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional

from app.engine.squad import RATING_TO_ELO

SHARP_START, SHARP_MIN, SHARP_MAX = 75.0, 30.0, 100.0
SHARP_GAIN_PLAYED, SHARP_LOSS_BENCHED = 12.0, 8.0
FATIGUE_MATCH, FATIGUE_RECOVERY, FATIGUE_MAX = 34.0, 16.0, 100.0
MORALE_START, MORALE_MIN, MORALE_MAX = 70.0, 20.0, 100.0
MORALE_PLAYED, MORALE_BENCHED = 4.0, -3.0
MORALE_WIN, MORALE_LOSS = 5.0, -6.0
# Multiplier shaping: penalties/bonuses per condition point.
SHARP_PEN = 0.0012      # up to ~-8.4% at sharpness 30
FATIGUE_PEN = 0.0010    # up to -10% at fatigue 100
MORALE_ADJ = 0.0006     # ±~1.8% across the morale range
MULT_MIN, MULT_MAX = 0.80, 1.05
# XI condition -> Elo: average rating-point swing, damped, clamped.
COND_ELO_FACTOR = 0.6
COND_ELO_MIN, COND_ELO_MAX = -60.0, 20.0


class SquadCondition:
    """Tracks sharpness / fatigue / morale for one squad across a tournament."""

    def __init__(self, squad: Iterable) -> None:
        self.players = list(squad)
        self.c: Dict[str, dict] = {
            p.id: {"sharpness": SHARP_START, "fatigue": 0.0, "morale": MORALE_START}
            for p in self.players
        }

    # ----------------------------------------------------------- progression
    def after_round(self, played_ids: Iterable[str], won: Optional[bool]) -> None:
        """Update everyone after a round: minutes, rest, and the result mood."""
        played = set(played_ids)
        result_morale = MORALE_WIN if won else MORALE_LOSS if won is not None else 0.0
        for pid, st in self.c.items():
            if pid in played:
                st["sharpness"] = min(SHARP_MAX, st["sharpness"] + SHARP_GAIN_PLAYED)
                st["fatigue"] = min(FATIGUE_MAX, st["fatigue"] + FATIGUE_MATCH)
                st["morale"] = _clamp_morale(st["morale"] + MORALE_PLAYED + result_morale)
            else:
                st["sharpness"] = max(SHARP_MIN, st["sharpness"] - SHARP_LOSS_BENCHED)
                st["morale"] = _clamp_morale(st["morale"] + MORALE_BENCHED + result_morale * 0.5)
            st["fatigue"] = max(0.0, st["fatigue"] - FATIGUE_RECOVERY)

    def nudge_morale(self, player_ids: Iterable[str], delta: float) -> None:
        for pid in player_ids:
            if pid in self.c:
                self.c[pid]["morale"] = _clamp_morale(self.c[pid]["morale"] + delta)

    def nudge_all_morale(self, delta: float) -> None:
        self.nudge_morale(list(self.c), delta)

    # ------------------------------------------------------------- strength
    def multiplier(self, pid: str) -> float:
        """Effective-rating multiplier for one player (1.0 = nominal)."""
        st = self.c.get(pid)
        if st is None:
            return 1.0
        m = (1.0
             - (SHARP_MAX - st["sharpness"]) * SHARP_PEN
             - st["fatigue"] * FATIGUE_PEN
             + (st["morale"] - MORALE_START) * MORALE_ADJ)
        return max(MULT_MIN, min(MULT_MAX, m))

    def multipliers(self) -> Dict[str, float]:
        return {pid: self.multiplier(pid) for pid in self.c}

    def xi_elo_delta(self, xi_ids: List[str]) -> float:
        """Extra Elo from the chosen XI's average condition (damped, clamped)."""
        by = {p.id: p for p in self.players}
        picked = [by[i] for i in xi_ids if i in by]
        if not picked:
            return 0.0
        swing = sum(p.rating * (self.multiplier(p.id) - 1.0) for p in picked) / len(picked)
        delta = swing * RATING_TO_ELO * COND_ELO_FACTOR
        return max(COND_ELO_MIN, min(COND_ELO_MAX, delta))

    # --------------------------------------------------------------- payload
    def payload(self, pid: str) -> dict:
        st = self.c.get(pid)
        if st is None:
            return {"sharpness": 100, "fatigue": 0, "morale": 70, "condition_pct": 100}
        return {
            "sharpness": round(st["sharpness"]),
            "fatigue": round(st["fatigue"]),
            "morale": round(st["morale"]),
            "condition_pct": round(self.multiplier(pid) * 100),
        }


def _clamp_morale(v: float) -> float:
    return max(MORALE_MIN, min(MORALE_MAX, v))
