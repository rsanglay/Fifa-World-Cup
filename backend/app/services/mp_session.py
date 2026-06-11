"""In-memory store for multiplayer tournament rooms.

Rooms are ephemeral (process memory), addressed by a short shareable code
(e.g. "K3QF7") and authenticated per-manager with an opaque token issued at
create/join time. A cap bounds memory; the oldest rooms are evicted.
"""
from __future__ import annotations

import secrets
import uuid
from collections import OrderedDict
from typing import Dict, List, Optional

from app.core.data import load_squads, load_tournament
from app.engine.multiplayer import MultiplayerRoom

_ROOMS: "OrderedDict[str, MultiplayerRoom]" = OrderedDict()
_MAX_ROOMS = 100
# No ambiguous characters (0/O, 1/I/L) — codes get read out loud to friends.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _evict() -> None:
    while len(_ROOMS) > _MAX_ROOMS:
        _ROOMS.popitem(last=False)


def new_code(taken) -> str:
    for _ in range(50):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(5))
        if code not in taken:
            return code
    raise RuntimeError("Could not allocate a room code.")


def get_room(code: str) -> MultiplayerRoom:
    room = _ROOMS.get(code.upper())
    if room is None:
        raise KeyError("Room not found or expired — create a new tournament.")
    _ROOMS.move_to_end(code.upper())
    return room


def create(name: str, team: Optional[str], seed: Optional[int] = None,
           draft: bool = False, deadline_minutes: int = 0,
           live_h2h: bool = True) -> dict:
    code = new_code(_ROOMS)
    room = MultiplayerRoom(code, load_tournament(), load_squads(), seed,
                           draft=draft, deadline_minutes=deadline_minutes,
                           live_h2h=live_h2h)
    token = uuid.uuid4().hex[:16]
    room.join(token, name, team, host=True)
    _ROOMS[code] = room
    _evict()
    return {"code": code, "token": token, "state": room.state(token)}


def join(code: str, name: str, team: Optional[str]) -> dict:
    room = get_room(code)
    token = uuid.uuid4().hex[:16]
    room.join(token, name, team)
    return {"code": room.code, "token": token, "state": room.state(token)}


def switch_team(code: str, token: str, team: str) -> dict:
    room = get_room(code)
    room.switch_team(token, team)
    return {"code": room.code, "state": room.state(token)}


def start(code: str, token: str) -> dict:
    room = get_room(code)
    room.start(token)
    return {"code": room.code, "state": room.state(token)}


def draft_pick(code: str, token: str, team: str) -> dict:
    room = get_room(code)
    room.draft_pick(token, team)
    return {"code": room.code, "state": room.state(token)}


def submit(code: str, token: str, starting_xi: List[str],
           mentality: str = "balanced") -> dict:
    room = get_room(code)
    room.submit(token, starting_xi, mentality)
    return {"code": room.code, "state": room.state(token)}


def predict(code: str, token: str, picks: Dict[str, str]) -> dict:
    room = get_room(code)
    room.predict(token, picks)
    return {"code": room.code, "state": room.state(token)}


def chat(code: str, token: str, text: str) -> dict:
    room = get_room(code)
    room.post_chat(token, text)
    return {"code": room.code, "state": room.state(token)}


def state(code: str, token: str) -> dict:
    room = get_room(code)
    return {"code": room.code, "state": room.state(token)}


def preview(code: str) -> dict:
    return get_room(code).preview()
