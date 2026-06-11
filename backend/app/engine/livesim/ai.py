"""Reactive opposition AI.

Every 5 game-minutes the (un-managed) opponent re-evaluates the match state
and may switch its tactical setup. Each switch is announced via an
OPP_TACTICAL_CHANGE event so the manager can see — and counter — it.

Decision table (in priority order):
  * red-carded            -> 10-man defensive shape (shot rate -25%)
  * losing by 1+          -> "attacking": a CB steps into midfield, +15% shot rate
  * winning by 2+         -> "defensive" park-the-bus: chains get longer
                             (slow keep-ball), shot rate -40%
  * otherwise             -> balanced reset
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

EVAL_EVERY = 5  # game-minutes


@dataclass
class OppState:
    mentality: str = "balanced"
    tempo: str = "balanced"
    passing: str = "mixed"
    pressing: str = "mid"
    shot_mult: float = 1.0       # multiplies the opposition's shot frequency
    chain_bonus: float = 0.0     # extra Poisson lambda on their chain length
    cb_in_midfield: bool = False
    reason: str = ""


@dataclass
class OppAI:
    state: OppState = field(default_factory=OppState)
    _last_minute: int = -1
    _announced: bool = False

    def evaluate(self, minute: int, goal_diff: int, red_carded: bool) -> Optional[OppState]:
        """Re-evaluate; returns the new state when the setup changed (the very
        first evaluation is always announced, so the manager sees how the
        opponent set up).

        ``goal_diff`` is from the opposition's perspective (their goals minus
        ours). Runs at most once per EVAL_EVERY minutes.
        """
        if minute - self._last_minute < EVAL_EVERY:
            return None
        self._last_minute = minute
        first = not self._announced
        self._announced = True

        if red_carded:
            nxt = OppState("defensive", "slow", "direct", "low_block",
                           shot_mult=0.75, chain_bonus=0.5,
                           reason="down to ten men — dropping into a low defensive shape")
        elif goal_diff <= -1:
            nxt = OppState("attacking", "fast", "direct", "high",
                           shot_mult=1.15, cb_in_midfield=True,
                           reason="losing — pushing a centre-back into midfield and going for it")
        elif goal_diff >= 2:
            nxt = OppState("defensive", "slow", "short", "low_block",
                           shot_mult=0.60, chain_bonus=1.5,
                           reason="protecting a two-goal lead — parking the bus")
        else:
            nxt = OppState(reason="setting up in a balanced shape" if first
                           else "resetting to a balanced shape")

        cur = self.state
        if not first and (
                nxt.mentality, nxt.tempo, nxt.passing, nxt.pressing,
                nxt.cb_in_midfield) == (cur.mentality, cur.tempo, cur.passing,
                                        cur.pressing, cur.cb_in_midfield):
            return None
        self.state = nxt
        return nxt
