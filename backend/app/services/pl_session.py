"""In-memory store for prediction leagues (same plumbing as mp_session)."""
from __future__ import annotations

import uuid
from collections import OrderedDict
from typing import Dict, Optional

from app.core.data import load_tournament
from app.engine.prediction_league import PredictionLeague
from app.services.mp_session import new_code

_LEAGUES: "OrderedDict[str, PredictionLeague]" = OrderedDict()
_MAX = 100


def _evict() -> None:
    while len(_LEAGUES) > _MAX:
        _LEAGUES.popitem(last=False)


def _get(code: str) -> PredictionLeague:
    league = _LEAGUES.get(code.upper())
    if league is None:
        raise KeyError("League not found or expired — create a new one.")
    _LEAGUES.move_to_end(code.upper())
    return league


def create(name: str, seed: Optional[int] = None, deadline_minutes: int = 0) -> dict:
    code = new_code(_LEAGUES)
    league = PredictionLeague(code, load_tournament(), seed,
                              deadline_minutes=deadline_minutes)
    token = uuid.uuid4().hex[:16]
    league.join(token, name, host=True)
    _LEAGUES[code] = league
    _evict()
    return {"code": code, "token": token, "state": league.state(token)}


def join(code: str, name: str) -> dict:
    league = _get(code)
    token = uuid.uuid4().hex[:16]
    league.join(token, name)
    return {"code": league.code, "token": token, "state": league.state(token)}


def start(code: str, token: str) -> dict:
    league = _get(code)
    league.start(token)
    return {"code": league.code, "state": league.state(token)}


def predict(code: str, token: str, picks: Dict[str, dict]) -> dict:
    league = _get(code)
    league.predict(token, picks)
    return {"code": league.code, "state": league.state(token)}


def state(code: str, token: str) -> dict:
    league = _get(code)
    return {"code": league.code, "state": league.state(token)}


def preview(code: str) -> dict:
    return _get(code).preview()
