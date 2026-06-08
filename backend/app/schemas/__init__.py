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
