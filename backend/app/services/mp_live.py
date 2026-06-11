"""WebSocket connection + ticker manager for live H2H grudge matches.

One asyncio ticker per live match: the SERVER owns the match clock. Every
connected socket (both managers + any spectating room member) receives every
snapshot; only the two managers' commands are applied, each to their own
side. Breaks (half-time / before extra time) pause the clock until both
managers ready-up, with a timeout so nobody can hold the room hostage.

The room engine stays synchronous and WS-agnostic — this layer only calls
`tick`, `set_tactics`, `substitute`, `set_ready` and `finalize_live_match`.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Dict, Set

from fastapi import WebSocket

# Real seconds per game-minute (env-tunable: ops pacing + fast e2e tests).
TICK_SECONDS = float(os.environ.get("MP_LIVE_TICK_SECONDS", "1.1"))
BREAK_TIMEOUT = float(os.environ.get("MP_LIVE_BREAK_TIMEOUT", "45"))
FINAL_LINGER = 2.0            # let the FT snapshot land before closing


class LiveMatchHub:
    """Connections + ticker for one (room code, match key) pair."""

    def __init__(self, room, key: str):
        self.room = room
        self.key = str(key)
        self.sockets: Set[WebSocket] = set()
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()

    # ------------------------------------------------------------- sockets
    async def attach(self, ws: WebSocket) -> None:
        self.sockets.add(ws)
        entry = self.room.live_entry(self.key)
        entry["started"] = True
        entry["last_tick"] = time.time()
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    def detach(self, ws: WebSocket) -> None:
        self.sockets.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)

    async def send_snapshot(self) -> None:
        entry = self.room.live_matches.get(self.key)
        if entry is None:
            return
        await self.broadcast({"kind": "snapshot",
                              "snapshot": entry["match"].snapshot()})

    # -------------------------------------------------------------- ticker
    async def _run(self) -> None:
        """Advance the match while anyone is connected; stop when FT/empty."""
        try:
            while self.sockets:
                entry = self.room.live_matches.get(self.key)
                if entry is None:
                    break
                lm = entry["match"]
                if lm.done:
                    break
                if lm.break_flag:
                    waited = 0.0
                    while (self.sockets and not lm.both_ready()
                           and waited < BREAK_TIMEOUT):
                        await asyncio.sleep(0.5)
                        waited += 0.5
                    lm.clear_ready()
                    await self.broadcast({"kind": "resume", "minute": lm.minute})
                async with self.lock:
                    lm.tick(1)
                    entry["last_tick"] = time.time()
                await self.send_snapshot()
                if lm.done:
                    async with self.lock:
                        self.room.finalize_live_match(self.key)
                    await self.broadcast({"kind": "final"})
                    await asyncio.sleep(FINAL_LINGER)
                    break
                await asyncio.sleep(TICK_SECONDS)
        finally:
            self.task = None

    # ------------------------------------------------------------ commands
    async def handle(self, ws: WebSocket, token: str, msg: dict) -> None:
        entry = self.room.live_matches.get(self.key)
        if entry is None:
            await ws.send_json({"kind": "error", "message": "Match is over."})
            return
        lm = entry["match"]
        side = self.room.live_side_for(self.key, token)
        action = msg.get("action")
        if action == "ready" and side:
            lm.set_ready(side)
            await self.broadcast({"kind": "ready", "side": side})
            return
        if side is None:
            await ws.send_json({"kind": "error",
                                "message": "Spectators can shout, not manage."})
            return
        async with self.lock:
            if action == "tactics":
                lm.set_tactics(side, mentality=msg.get("mentality"),
                               tempo=msg.get("tempo"), passing=msg.get("passing"),
                               pressing=msg.get("pressing"),
                               attack_style=msg.get("attack_style"),
                               time_wasting=msg.get("time_wasting"),
                               penalty_taker=msg.get("penalty_taker"))
            elif action == "sub":
                ok, why = lm.substitute(side, msg.get("out_id", ""), msg.get("in_id", ""))
                if not ok:
                    await ws.send_json({"kind": "error", "message": why})
                    return
        await self.send_snapshot()


_HUBS: Dict[str, LiveMatchHub] = {}


def hub_for(room, code: str, key: str) -> LiveMatchHub:
    hub_key = f"{code.upper()}:{key}"
    hub = _HUBS.get(hub_key)
    if hub is None or hub.room is not room:
        hub = LiveMatchHub(room, key)
        _HUBS[hub_key] = hub
    return hub


def cleanup_hub(code: str, key: str) -> None:
    hub_key = f"{code.upper()}:{key}"
    hub = _HUBS.get(hub_key)
    if hub and not hub.sockets:
        _HUBS.pop(hub_key, None)
