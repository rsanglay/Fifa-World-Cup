"""Event vocabulary for the possession-chain engine.

Two layers of events coexist:

* **Headline events** (lowercase legacy types: ``goal``, ``chance``,
  ``yellow``, ``red``, ``sub``, ``injury``, ``tactic``, ``pens``) — the
  permanent match record. These drive the event-feed sidebar, the tournament
  journey and cross-match discipline, and they keep every existing consumer
  (multiplayer views, share cards, tests) working unchanged.
* **Chain events** (uppercase :class:`EventType`: PASS / DRIBBLE / PRESS /
  SHOT / SAVE / CORNER / FOUL / GOAL / INJURY / OPP_TACTICAL_CHANGE) — the
  per-tick micro narration emitted inside each frame's ``events[]`` array so
  the 2D/3D renderers can choreograph the ball and the involved players.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum


class EventType(str, Enum):
    PASS = "PASS"
    DRIBBLE = "DRIBBLE"
    PRESS = "PRESS"
    SHOT = "SHOT"
    SAVE = "SAVE"
    CORNER = "CORNER"
    FOUL = "FOUL"
    GOAL = "GOAL"
    YELLOW = "YELLOW"
    RED = "RED"
    SUB = "SUB"
    INJURY = "INJURY"
    PENALTY = "PENALTY"
    OPP_TACTICAL_CHANGE = "OPP_TACTICAL_CHANGE"
    WHISTLE = "WHISTLE"


@dataclass
class MatchEvent:
    """One frame-level chain event.

    ``x``/``y`` are pitch-relative (0-100 × 0-100), home always attacking
    left→right, so renderers never need to re-derive orientation.
    """

    type: str
    minute: int
    team: str               # 3-letter code of the acting team
    side: str               # "home" | "away"
    player_id: str = ""
    player: str = ""
    x: float = 50.0
    y: float = 50.0
    detail: str = ""
    outcome: str = ""       # SHOT: "goal"|"saved"|"woodwork"|"off_target"
    new_mentality: str = ""  # OPP_TACTICAL_CHANGE only
    reason: str = ""         # OPP_TACTICAL_CHANGE / INJURY severity

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v not in ("", None)}
