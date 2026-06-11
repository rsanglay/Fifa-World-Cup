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
from app.engine.livesim import session as live_sessions
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


def squad_overlay(session_id: Optional[str], team: str) -> Optional[dict]:
    """Per-player form/injury/suspension overlay for a career session, used to
    enrich the public squad endpoint for the lineup builder."""
    if not session_id:
        return None
    mt = _SESSIONS.get(session_id)
    if mt is None or mt.team != team.upper():
        return None
    return {
        "form": {pid: round(v, 2) for pid, v in mt.player_form.items()},
        "card_state": mt.card_state(),
        "injured": {pid: r for pid, r in mt.injured.items() if r > 0},
    }


# ------------------------- live (interactive) match ------------------------ #
def live_start(session_id: str, starting_xi: List[str], mentality: str = "balanced") -> dict:
    """Kick off (or resume) a live match and open a WebSocket match session.

    Returns the MATCH session id (`session_id`) used by
    `GET /ws/manage/live/{session_id}`, plus the legacy fields. Raises
    ValueError when the XI names suspended or injured players (mapped to a
    422 by the route layer).
    """
    mt = _get(session_id)
    problems = mt.xi_eligibility_problems(starting_xi)
    if problems:
        raise ValueError({"message": "Ineligible players in the starting XI.",
                          "players": problems})
    if mt.phase != "done" and mt.live is None and mt.pending is None:
        mt.start_live(starting_xi, mentality)
    if mt.live is None:
        return {"session_id": None, "manage_session_id": session_id, "live": None}
    ms = live_sessions.create(session_id, mt)
    return {
        "session_id": ms.session_id,
        "manage_session_id": session_id,
        "live": mt.live.snapshot(),
        "frame": mt.live.frame(),
        "ws_path": f"/ws/manage/live/{ms.session_id}",
    }


# ----------------------- WebSocket match-session glue ---------------------- #
def get_match_session(match_session_id: str):
    return live_sessions.get(match_session_id)


def current_frame(ms) -> dict:
    """Frame of the CURRENT state without advancing the clock (reconnects)."""
    mt = ms.tournament
    if mt.live is None:
        out = {"minute": 90, "match_phase": "FT", "snapshot": {"done": True},
               "events": [], "player_positions": [], "ball_xy": [50, 50],
               "possession_team": "home", "score": {}, "stats": {}}
        if ms.final_state:
            out["state"] = ms.final_state
        return out
    return mt.live.frame()


def ws_tick(ms) -> Optional[dict]:
    """Advance one game-minute and build the push frame (worker thread)."""
    with ms.lock:
        mt = ms.tournament
        lv = mt.live
        if lv is None:
            return None
        new = lv.tick(1)
        frame = lv.frame(new)
        if lv.done:
            mt._finalize_live()
            ms.final_state = mt.state()
            frame["state"] = ms.final_state
        return frame


def ws_command(ms, msg: dict) -> Optional[dict]:
    """Apply one client command; returns an ack frame (no clock advance)."""
    mt = ms.tournament
    action = (msg or {}).get("action")
    with ms.lock:
        if action == "pause":
            ms.paused = True
        elif action == "resume":
            if not ms.done:
                ms.paused = False
        elif action == "speed":
            try:
                ms.speed = max(0.25, min(4.0, float(msg.get("speed", 1))))
            except (TypeError, ValueError):
                pass
        elif action == "tactics" and mt.live is not None:
            mt.live.set_tactics(
                mentality=msg.get("mentality"), tempo=msg.get("tempo"),
                passing=msg.get("passing"), pressing=msg.get("pressing"),
                attack_style=msg.get("attack_style"),
                time_wasting=msg.get("time_wasting"),
                penalty_taker=msg.get("penalty_taker"))
        elif action == "sub" and mt.live is not None:
            ok, m = mt.live.substitute(msg.get("out_id", ""), msg.get("in_id", ""))
            if not ok:
                return {"type": "error", "message": m}
        if mt.live is None:
            return current_frame(ms)
        frame = mt.live.frame()
    frame["ack"] = action
    return frame


def live_tick(session_id: str, minutes: int = 1) -> dict:
    mt = _get(session_id)
    snap = mt.tick_live(minutes)
    if snap is None:
        raise KeyError("No live match in progress.")
    out = {"session_id": session_id, "live": snap}
    if snap["done"]:
        out["state"] = mt.state()
    return out


def live_tactics(session_id: str, mentality=None, tempo=None,
                 passing=None, pressing=None, attack_style=None,
                 time_wasting=None, penalty_taker=None) -> dict:
    mt = _get(session_id)
    snap = mt.live_tactics(mentality=mentality, tempo=tempo,
                           passing=passing, pressing=pressing,
                           attack_style=attack_style, time_wasting=time_wasting,
                           penalty_taker=penalty_taker)
    if snap is None:
        raise KeyError("No live match in progress.")
    return {"session_id": session_id, "live": snap}


def event_respond(session_id: str, choice: str) -> dict:
    """Answer the pending dressing-room card."""
    mt = _get(session_id)
    outcome = mt.respond_event(choice)
    return {"session_id": session_id, "state": mt.state(),
            "outcome": outcome or "No event was waiting."}


def live_sub(session_id: str, out_id: str, in_id: str) -> dict:
    mt = _get(session_id)
    snap, msg = mt.live_substitute(out_id, in_id)
    if snap is None:
        raise KeyError(msg)
    return {"session_id": session_id, "live": snap, "message": msg}
