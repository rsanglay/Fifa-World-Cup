"""In-memory session store for round-by-round managed (career) tournaments.

Sessions are ephemeral (process memory). A simple cap bounds memory; the oldest
sessions are evicted. The managed match is two-phase (first half -> half-time
tactical switch -> second half).
"""
from __future__ import annotations

import uuid
from collections import OrderedDict
from typing import List, Optional

from app.core.data import load_squads, load_tournament
from app.engine.managed import ManagedTournament

_SESSIONS: "OrderedDict[str, ManagedTournament]" = OrderedDict()
_MAX_SESSIONS = 200


def _evict() -> None:
    while len(_SESSIONS) > _MAX_SESSIONS:
        _SESSIONS.popitem(last=False)


def _get(session_id: str) -> ManagedTournament:
    mt = _SESSIONS.get(session_id)
    if mt is None:
        raise KeyError("Session not found or expired — start a new career.")
    _SESSIONS.move_to_end(session_id)
    return mt


def start(team: str, seed: Optional[int] = None) -> dict:
    data = load_tournament()
    if team not in data.teams:
        raise KeyError(f"Unknown team code: {team}")
    squads = load_squads()
    mt = ManagedTournament(data, team, squads[team], squads, seed)
    sid = uuid.uuid4().hex[:12]
    _SESSIONS[sid] = mt
    _SESSIONS.move_to_end(sid)
    _evict()
    return {"session_id": sid, "state": mt.state()}


def preview(session_id: str, starting_xi: List[str], mentality: str = "balanced") -> dict:
    mt = _get(session_id)
    return {"preview": mt.preview(starting_xi, mentality)}


def first_half(session_id: str, starting_xi: List[str], mentality: str = "balanced") -> dict:
    mt = _get(session_id)
    if mt.phase != "done" and mt.pending is None:
        mt.play_first_half(starting_xi, mentality)
    return {"session_id": session_id, "state": mt.state()}


def second_half(session_id: str, mentality: str = "balanced") -> dict:
    mt = _get(session_id)
    if mt.pending is not None:
        mt.play_second_half(mentality)
    return {"session_id": session_id, "state": mt.state()}


def get(session_id: str) -> dict:
    mt = _get(session_id)
    return {"session_id": session_id, "state": mt.state()}


# ------------------------- live (interactive) match ------------------------ #
def live_start(session_id: str, starting_xi: List[str], mentality: str = "balanced") -> dict:
    mt = _get(session_id)
    if mt.phase != "done" and mt.live is None and mt.pending is None:
        mt.start_live(starting_xi, mentality)
    live = mt.live.snapshot() if mt.live else None
    return {"session_id": session_id, "live": live}


def live_tick(session_id: str, minutes: int = 1) -> dict:
    mt = _get(session_id)
    snap = mt.tick_live(minutes)
    if snap is None:
        raise KeyError("No live match in progress.")
    out = {"session_id": session_id, "live": snap}
    if snap["done"]:
        out["state"] = mt.state()
    return out


def live_tactics(session_id: str, mentality: str = "balanced") -> dict:
    mt = _get(session_id)
    snap = mt.live_tactics(mentality)
    if snap is None:
        raise KeyError("No live match in progress.")
    return {"session_id": session_id, "live": snap}


def live_sub(session_id: str, out_id: str, in_id: str) -> dict:
    mt = _get(session_id)
    snap, msg = mt.live_substitute(out_id, in_id)
    if snap is None:
        raise KeyError(msg)
    return {"session_id": session_id, "live": snap, "message": msg}
