"""Server-side live match sessions.

A MatchSession binds one in-progress ChainMatch (which itself owns the full
match state: both XIs, stamina, form, card state, sub count, both mentalities)
to its parent tournament (the outer ManageSession) and the asyncio tick task
pushing frames to connected sockets.

Sessions live in a module-level dict keyed by a UUID. On WebSocket disconnect
the tick task is cancelled but the session stays resident for 30 minutes so a
refreshed browser can reconnect and resume from the same minute.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

RECONNECT_GRACE_SECONDS = 30 * 60


@dataclass
class MatchSession:
    session_id: str
    manage_sid: str                  # outer tournament session id
    tournament: object               # ManagedTournament (owns .live = ChainMatch)
    paused: bool = True
    speed: float = 1.0               # 1x = 500ms per game-minute
    tick_task: Optional[object] = None   # asyncio.Task while a socket is live
    expires_at: float = 0.0          # 0 = pinned (socket attached)
    final_state: Optional[dict] = None   # tournament state captured at FT
    created_at: float = field(default_factory=time.time)
    # Ticks run in a worker thread (asyncio.to_thread) while tactics/sub
    # commands arrive on the event loop — every engine mutation takes this.
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def engine(self):
        """The ChainMatch (None once the match has been finalised)."""
        return getattr(self.tournament, "live", None)

    @property
    def done(self) -> bool:
        eng = self.engine
        return eng is None or eng.done


_SESSIONS: Dict[str, MatchSession] = {}
_BY_MANAGE: Dict[str, str] = {}      # manage_sid -> live match session id


def _purge_expired() -> None:
    now = time.time()
    for sid in [s for s, ms in _SESSIONS.items()
                if ms.expires_at and now > ms.expires_at]:
        ms = _SESSIONS.pop(sid, None)
        if ms and _BY_MANAGE.get(ms.manage_sid) == sid:
            _BY_MANAGE.pop(ms.manage_sid, None)


def create(manage_sid: str, tournament) -> MatchSession:
    """New live match session (reuses an existing one for the same career)."""
    _purge_expired()
    existing = _BY_MANAGE.get(manage_sid)
    if existing and existing in _SESSIONS and not _SESSIONS[existing].done:
        return _SESSIONS[existing]
    sid = uuid.uuid4().hex
    ms = MatchSession(session_id=sid, manage_sid=manage_sid, tournament=tournament,
                      expires_at=time.time() + RECONNECT_GRACE_SECONDS)
    _SESSIONS[sid] = ms
    _BY_MANAGE[manage_sid] = sid
    return ms


def get(session_id: str) -> Optional[MatchSession]:
    _purge_expired()
    return _SESSIONS.get(session_id)


def pin(ms: MatchSession) -> None:
    """A socket is attached: the session cannot expire."""
    ms.expires_at = 0.0


def release(ms: MatchSession) -> None:
    """Last socket detached: keep alive for the reconnect grace window."""
    ms.expires_at = time.time() + RECONNECT_GRACE_SECONDS


def drop(session_id: str) -> None:
    ms = _SESSIONS.pop(session_id, None)
    if ms and _BY_MANAGE.get(ms.manage_sid) == session_id:
        _BY_MANAGE.pop(ms.manage_sid, None)
