"""Pydantic request/response models for the API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class MatchPredictRequest(BaseModel):
    home: str = Field(..., description="Home team 3-letter code")
    away: str = Field(..., description="Away team 3-letter code")
    neutral: bool = True


class LineupRequest(BaseModel):
    team: str
    starting_xi: List[str] = Field(..., description="11 player ids")


class ManageSimRequest(BaseModel):
    team: str
    starting_xi: List[str] = Field(default_factory=list)
    seed: Optional[int] = None


class OddsQuery(BaseModel):
    simulations: int = 5000


class TournamentSimRequest(BaseModel):
    seed: Optional[int] = None
    # Optional manual Elo nudges per team code (advanced / what-if).
    elo_overrides: Optional[dict] = None


class ManageStartRequest(BaseModel):
    team: str
    seed: Optional[int] = None


class ManagePlayRequest(BaseModel):
    session_id: str
    starting_xi: List[str] = Field(default_factory=list)
    mentality: str = "balanced"


class ManageSecondHalfRequest(BaseModel):
    session_id: str
    mentality: str = "balanced"


class LiveStartRequest(BaseModel):
    session_id: str
    starting_xi: List[str] = Field(default_factory=list)
    mentality: str = "balanced"


class LiveTickRequest(BaseModel):
    session_id: str
    minutes: int = Field(1, ge=1, le=5)


class LiveTacticsRequest(BaseModel):
    session_id: str
    mentality: Optional[str] = None
    tempo: Optional[str] = None          # slow | balanced | fast
    passing: Optional[str] = None        # short | mixed | direct
    pressing: Optional[str] = None       # low_block | mid | high
    attack_style: Optional[str] = None   # balanced | target_man | false_nine
    time_wasting: Optional[bool] = None
    penalty_taker: Optional[str] = None  # player id ("" clears)


class ManageEventRequest(BaseModel):
    session_id: str
    choice: str


class LiveSubRequest(BaseModel):
    session_id: str
    out_id: str
    in_id: str


class RealityRequest(BaseModel):
    # match_no (as string key) -> [home_goals, away_goals]
    results: dict = Field(default_factory=dict)
    simulations: int = 2000


# ------------------------------ multiplayer -------------------------------- #
class MPCreateRequest(BaseModel):
    name: str = Field(..., description="Your display name")
    team: Optional[str] = Field(None, description="3-letter team code (omit in draft rooms)")
    seed: Optional[int] = None
    draft: bool = False
    deadline_minutes: int = Field(0, ge=0, le=10080)  # up to a week per round
    live_h2h: bool = True


class MPJoinRequest(BaseModel):
    code: str = Field(..., description="5-character room code")
    name: str
    team: Optional[str] = None


class MPTokenRequest(BaseModel):
    code: str
    token: str


class MPSwitchTeamRequest(BaseModel):
    code: str
    token: str
    team: str


class MPSubmitRequest(BaseModel):
    code: str
    token: str
    starting_xi: List[str] = Field(default_factory=list)
    mentality: str = "balanced"


class MPDraftPickRequest(BaseModel):
    code: str
    token: str
    team: str


class MPPredictRequest(BaseModel):
    code: str
    token: str
    picks: dict = Field(default_factory=dict)   # match_key -> "H"|"D"|"A"


class MPChatRequest(BaseModel):
    code: str
    token: str
    text: str


class PLCreateRequest(BaseModel):
    name: str
    seed: Optional[int] = None
    deadline_minutes: int = 0


class PLJoinRequest(BaseModel):
    code: str
    name: str


class PLPredictRequest(BaseModel):
    code: str
    token: str
    picks: dict = Field(default_factory=dict)   # match_key -> {"result", "margin"?}
