"""Headless possession-chain live match engine (Manage a Nation).

Pure Python — zero FastAPI imports. Mirrors the Football Manager split between
the match engine and its viewers: the server simulates, every client is a
renderer of the pushed frame stream.

Modules
-------
events.py     EventType enum + MatchEvent dataclass
stamina.py    positional decay rates + effective-rating model
simulator.py  ChainMatch: possession chains, positions, stats, ratings
ai.py         OppAI: reactive opposition tactical brain
session.py    MatchSession dataclass + module-level session store
ws_handler.py duck-typed WebSocket hub + 500ms broadcast loop
"""
from app.engine.livesim.simulator import ChainMatch  # noqa: F401
from app.engine.livesim.session import MatchSession  # noqa: F401
