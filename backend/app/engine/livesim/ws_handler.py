"""WebSocket connection manager + 500ms broadcast loop.

Engine-side only: sockets are duck-typed (anything with an async
``send_json``), so this module never imports FastAPI/Starlette — the route
layer adapts. The simulation tick itself runs in ``asyncio.to_thread`` so the
numpy-heavy engine never blocks the event loop.
"""
from __future__ import annotations

import asyncio
from typing import Callable, Dict, List, Optional

from app.engine.livesim import session as live_sessions
from app.engine.livesim.session import MatchSession

TICK_SECONDS = 0.5      # 1 game-minute per real 500ms at 1x speed
PAUSE_POLL = 0.1


class LiveSocketHub:
    """Tracks the sockets attached to each live match session."""

    def __init__(self) -> None:
        self._sockets: Dict[str, List] = {}

    def attach(self, sid: str, ws) -> None:
        self._sockets.setdefault(sid, []).append(ws)

    def detach(self, sid: str, ws) -> None:
        socks = self._sockets.get(sid, [])
        if ws in socks:
            socks.remove(ws)
        if not socks:
            self._sockets.pop(sid, None)

    def empty(self, sid: str) -> bool:
        return not self._sockets.get(sid)

    async def broadcast(self, sid: str, payload: dict) -> None:
        dead = []
        for ws in list(self._sockets.get(sid, [])):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.detach(sid, ws)


hub = LiveSocketHub()


def ensure_tick_loop(ms: MatchSession, tick_fn: Callable[[], Optional[dict]]) -> None:
    """Start (or keep) the per-session tick task. ``tick_fn`` advances the
    match one game-minute and returns the frame to push (sync, run in a
    worker thread)."""
    task = ms.tick_task
    if task is not None and not task.done():
        return
    ms.tick_task = asyncio.create_task(_run_loop(ms, tick_fn))


def cancel_tick_loop(ms: MatchSession) -> None:
    task = ms.tick_task
    if task is not None and not task.done():
        task.cancel()
    ms.tick_task = None


async def _run_loop(ms: MatchSession, tick_fn: Callable[[], Optional[dict]]) -> None:
    try:
        while True:
            if ms.done:
                return
            if ms.paused:
                await asyncio.sleep(PAUSE_POLL)
                continue
            frame = await asyncio.to_thread(tick_fn)
            if frame is None:
                return
            snap = frame.get("snapshot") or {}
            if snap.get("break") or snap.get("done"):
                ms.paused = True
            await hub.broadcast(ms.session_id, frame)
            if snap.get("done"):
                return
            await asyncio.sleep(TICK_SECONDS / max(0.25, min(4.0, ms.speed)))
    except asyncio.CancelledError:
        pass
    finally:
        ms.tick_task = None


def suspend(ms: MatchSession) -> None:
    """Last socket gone: cancel ticking, pause, start the 30-minute clock."""
    cancel_tick_loop(ms)
    ms.paused = True
    live_sessions.release(ms)
