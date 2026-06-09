"""In-memory session store for round-by-round managed tournaments.

Sessions are ephemeral (process memory) — fine for local / single-instance use.
A simple LRU-ish cap keeps memory bounded; the oldest sessions are evicted.
"""
from __future__ import annotations

import uuid
from collections import OrderedDict
from typing import List, Optional

from app.core.data import load_squads, load_tournament
from app.engine.managed import ManagedTournament

_SESSIONS: "OrderedDict[str, ManagedTournament]" = OrderedDict()
_MAX_SESSIONS = 200


def _evict_if_needed() -> None:
    while len(_SESSIONS) > _MAX_SESSIONS:
        _SESSIONS.popitem(last=False)


def start(team: str, seed: Optional[int] = None) -> dict:
    data = load_tournament()
    if team not in data.teams:
        raise KeyError(f"Unknown team code: {team}")
    squad = load_squads()[team]
    mt = ManagedTournament(data, team, squad, seed)
    sid = uuid.uuid4().hex[:12]
    _SESSIONS[sid] = mt
    _SESSIONS.move_to_end(sid)
    _evict_if_needed()
    return {"session_id": sid, "state": mt.state()}


def play(session_id: str, starting_xi: List[str]) -> dict:
    mt = _SESSIONS.get(session_id)
    if mt is None:
        raise KeyError("Session not found or expired — start a new managed run.")
    if mt.phase == "done":
        return {"session_id": session_id, "state": mt.state()}
    mt.play_round(starting_xi)
    _SESSIONS.move_to_end(session_id)
    return {"session_id": session_id, "state": mt.state()}


def get(session_id: str) -> dict:
    mt = _SESSIONS.get(session_id)
    if mt is None:
        raise KeyError("Session not found or expired.")
    return {"session_id": session_id, "state": mt.state()}
