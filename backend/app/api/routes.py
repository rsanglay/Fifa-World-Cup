"""All HTTP routes for the World Cup 2026 predictor."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.engine.livesim import session as live_sessions
from app.engine.livesim import ws_handler

from app.core.data import (
    group_stage_with_rest,
    load_historical,
    load_squads,
    load_teams,
    load_tournament,
    load_venues,
)
from app.engine.squad import FORMATIONS, best_xi
from app.schemas import (
    LineupRequest,
    LiveStartRequest,
    LiveSubRequest,
    LiveTacticsRequest,
    LiveTickRequest,
    ManageEventRequest,
    ManagePlayRequest,
    ManageSecondHalfRequest,
    ManageSimRequest,
    ManageStartRequest,
    MatchPredictRequest,
    MPChatRequest,
    MPCreateRequest,
    MPDraftPickRequest,
    MPJoinRequest,
    MPPredictRequest,
    MPSubmitRequest,
    MPSwitchTeamRequest,
    MPTokenRequest,
    PLCreateRequest,
    PLJoinRequest,
    PLPredictRequest,
    RealityRequest,
    TournamentSimRequest,
)
from app.services import manage_session
from app.services import mp_live
from app.services import mp_session
from app.services import pl_session
from app.services import simulation as sim

router = APIRouter()


# ----------------------------- reference data ----------------------------- #
@router.get("/teams")
def get_teams():
    teams = load_teams()
    return sorted(teams.values(), key=lambda t: t.get("fifa_ranking", 999))


@router.get("/teams/{code}")
def get_team(code: str):
    teams = load_teams()
    code = code.upper()
    if code not in teams:
        raise HTTPException(404, f"Unknown team: {code}")
    squads = load_squads()
    squad = [p.to_dict() for p in squads.get(code, [])]
    xi = [p.id for p in best_xi(squads.get(code, []))]
    return {**teams[code], "squad": squad, "suggested_xi": xi}


@router.get("/teams/{code}/squad")
def get_team_squad(code: str, session_id: Optional[str] = Query(None)):
    """Squad with per-player form for the lineup builder.

    Form defaults to 0.70 (neutral). Pass the career `session_id` to overlay
    the live tournament form, injury and suspension state.
    """
    teams = load_teams()
    code = code.upper()
    if code not in teams:
        raise HTTPException(404, f"Unknown team: {code}")
    squads = load_squads()
    overlay = manage_session.squad_overlay(session_id, code) or {}
    form = overlay.get("form", {})
    cards = overlay.get("card_state", {})
    injured = overlay.get("injured", {})
    out = []
    for p in squads.get(code, []):
        d = p.to_dict()
        d["form"] = form.get(p.id, 0.7)
        d["yellows"] = cards.get(p.id, {}).get("yellows", 0)
        d["suspended"] = cards.get(p.id, {}).get("suspended_next", False)
        d["injured"] = p.id in injured
        d["injured_rounds"] = injured.get(p.id, 0)
        out.append(d)
    return {"team": code, "squad": out}


@router.get("/groups")
def get_groups():
    teams = load_teams()
    groups: dict = {}
    for t in teams.values():
        groups.setdefault(t["group"], []).append(t)
    for g in groups:
        groups[g].sort(key=lambda t: t.get("pot", 9))
    return dict(sorted(groups.items()))


@router.get("/fixtures")
def get_fixtures():
    data = load_tournament()
    return {
        "group_stage": group_stage_with_rest(),
        "knockout": data.knockout_meta,
    }


@router.get("/venues")
def get_venues():
    return load_venues()


@router.get("/historical")
def get_historical():
    return load_historical()


@router.get("/formations")
def get_formations():
    return {name: {"def": d, "mid": m, "fwd": f}
            for name, (d, m, f) in FORMATIONS.items()}


# ------------------------------- prediction ------------------------------- #
@router.post("/predict/match")
def predict_match(req: MatchPredictRequest):
    try:
        return sim.predict_single(req.home.upper(), req.away.upper(), req.neutral)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.get("/odds")
async def tournament_odds(simulations: int = Query(5000, ge=500, le=20000)):
    """Tournament odds. Cached for 10 minutes; a cache miss runs the Monte
    Carlo in a worker thread so the event loop stays responsive."""
    return await sim.cached_odds_async(simulations)


@router.get("/model/diagnostics")
def model_diagnostics():
    return sim.model_diagnostics()


# ------------------------------- simulation ------------------------------- #
@router.post("/simulate/tournament")
def simulate_tournament(req: TournamentSimRequest):
    deltas = req.elo_overrides or None
    return sim.simulate_full(seed=req.seed, lineup_deltas=deltas)


# ----------------------------- manage-a-team ------------------------------ #
@router.post("/manage/lineup")
def manage_lineup(req: LineupRequest):
    try:
        return sim.compute_lineup(req.team.upper(), req.starting_xi)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/simulate")
def manage_simulate(req: ManageSimRequest):
    try:
        return sim.manage_team_run(req.team.upper(), req.starting_xi, req.seed)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/odds")
def manage_odds(req: ManageSimRequest):
    try:
        return sim.manage_team_odds(req.team.upper(), req.starting_xi)
    except KeyError as e:
        raise HTTPException(404, str(e))


# ------------------------- round-by-round manage -------------------------- #
@router.post("/manage/start")
def manage_start(req: ManageStartRequest):
    try:
        return manage_session.start(req.team.upper(), req.seed)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/preview")
def manage_preview(req: ManagePlayRequest):
    try:
        return manage_session.preview(req.session_id, req.starting_xi, req.mentality)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/play")
def manage_play(req: ManagePlayRequest):
    """Play the first half of the managed match (then await the half-time switch)."""
    try:
        return manage_session.first_half(req.session_id, req.starting_xi, req.mentality)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/second-half")
def manage_second_half(req: ManageSecondHalfRequest):
    try:
        return manage_session.second_half(req.session_id, req.mentality)
    except KeyError as e:
        raise HTTPException(404, str(e))


# --------------------------- live in-game management ---------------------- #
@router.post("/manage/live/start")
def manage_live_start(req: LiveStartRequest):
    """Kick off an interactive live match.

    Returns the WebSocket match `session_id` for `/ws/manage/live/{id}`.
    Rejects XIs naming suspended or injured players with a 422.
    """
    try:
        return manage_session.live_start(req.session_id, req.starting_xi, req.mentality)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        detail = e.args[0] if e.args else "Invalid starting XI."
        raise HTTPException(422, detail)


@router.post("/manage/live/tick")
def manage_live_tick(req: LiveTickRequest):
    """DEPRECATED: HTTP fallback. Live matches stream over
    `GET /ws/manage/live/{session_id}` — clients should not poll this."""
    try:
        return manage_session.live_tick(req.session_id, req.minutes)
    except KeyError as e:
        raise HTTPException(404, str(e))


async def manage_live_ws(ws: WebSocket, session_id: str):
    """Live match stream: the server ticks one game-minute every 500ms and
    pushes a frame { minute, score, events[], player_positions[], ball_xy,
    possession_team, match_phase, stats }. Clients send commands:
    {"action": "pause"|"resume"|"speed"|"tactics"|"sub", ...}.

    On disconnect the tick task is cancelled but the session survives for 30
    minutes, so a reconnect resumes from the same game minute.
    """
    ms = manage_session.get_match_session(session_id)
    if ms is None:
        await ws.close(code=4004)
        return
    await ws.accept()
    live_sessions.pin(ms)
    ws_handler.hub.attach(session_id, ws)
    try:
        await ws.send_json(manage_session.current_frame(ms))
        ws_handler.ensure_tick_loop(ms, lambda: manage_session.ws_tick(ms))
        while True:
            msg = await ws.receive_json()
            out = manage_session.ws_command(ms, msg)
            # Re-arm the clock on every command: idempotent, and covers a
            # loop that was cancelled by a racing disconnect (e.g. React
            # StrictMode's ghost socket) or stopped by a tick error.
            if not ms.done:
                ws_handler.ensure_tick_loop(ms, lambda: manage_session.ws_tick(ms))
            if out is not None:
                await ws.send_json(out)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ws_handler.hub.detach(session_id, ws)
        if ws_handler.hub.empty(session_id):
            ws_handler.suspend(ms)


# Registered on the router (=> /api/ws/manage/live/{id}); main.py also mounts
# it at the documented root path /ws/manage/live/{id}.
router.add_api_websocket_route("/ws/manage/live/{session_id}", manage_live_ws)


@router.post("/manage/live/tactics")
def manage_live_tactics(req: LiveTacticsRequest):
    """Change any tactical dial mid-match — mentality, tempo, passing, pressing,
    attack style, time-wasting, penalty taker."""
    try:
        return manage_session.live_tactics(
            req.session_id, mentality=req.mentality, tempo=req.tempo,
            passing=req.passing, pressing=req.pressing,
            attack_style=req.attack_style, time_wasting=req.time_wasting,
            penalty_taker=req.penalty_taker)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/event")
def manage_event(req: ManageEventRequest):
    """Answer the pending dressing-room / press-conference card."""
    try:
        return manage_session.event_respond(req.session_id, req.choice)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/live/sub")
def manage_live_sub(req: LiveSubRequest):
    """Make a substitution (max 5 per match, shape must stay legal)."""
    try:
        return manage_session.live_sub(req.session_id, req.out_id, req.in_id)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.get("/manage/session/{session_id}")
def manage_get(session_id: str):
    try:
        return manage_session.get(session_id)
    except KeyError as e:
        raise HTTPException(404, str(e))


# ------------------------------- multiplayer ------------------------------ #
def _mp(call, *args, **kwargs):
    """Map engine errors onto HTTP: KeyError -> 404, ValueError -> 400."""
    try:
        return call(*args, **kwargs)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/mp/create")
def mp_create(req: MPCreateRequest):
    """Create a multiplayer tournament room; returns code + your manager token.

    Options: draft=true (nations picked in a randomized draft), deadline_minutes
    (rounds auto-advance with best-XI auto-picks for no-shows), live_h2h=false
    (instant-sim grudge matches instead of the live WebSocket experience).
    """
    return _mp(mp_session.create, req.name,
               req.team.upper() if req.team else None, req.seed,
               draft=req.draft, deadline_minutes=req.deadline_minutes,
               live_h2h=req.live_h2h)


@router.post("/mp/join")
def mp_join(req: MPJoinRequest):
    """Join an open room with a display name and a free team."""
    return _mp(mp_session.join, req.code.upper(), req.name,
               req.team.upper() if req.team else None)


@router.post("/mp/draft-pick")
def mp_draft_pick(req: MPDraftPickRequest):
    """Make your pick when you are on the clock in a draft room."""
    return _mp(mp_session.draft_pick, req.code.upper(), req.token, req.team.upper())


@router.post("/mp/predict")
def mp_predict(req: MPPredictRequest):
    """Spectator predictions: call results for matches you are not playing in."""
    return _mp(mp_session.predict, req.code.upper(), req.token, req.picks)


@router.post("/mp/chat")
def mp_chat(req: MPChatRequest):
    """Post to the room's trash-talk feed."""
    return _mp(mp_session.chat, req.code.upper(), req.token, req.text)


@router.post("/mp/switch-team")
def mp_switch_team(req: MPSwitchTeamRequest):
    """Change your team while the room is still in the lobby."""
    return _mp(mp_session.switch_team, req.code.upper(), req.token, req.team.upper())


@router.post("/mp/start")
def mp_start(req: MPTokenRequest):
    """Host locks the lobby and kicks off the tournament."""
    return _mp(mp_session.start, req.code.upper(), req.token)


@router.post("/mp/submit")
def mp_submit(req: MPSubmitRequest):
    """Submit your XI + mentality; the round plays once everyone is in."""
    return _mp(mp_session.submit, req.code.upper(), req.token,
               req.starting_xi, req.mentality)


@router.get("/mp/state/{code}")
def mp_state(code: str, token: str):
    """Full room state for one manager (poll this)."""
    return _mp(mp_session.state, code.upper(), token)


@router.get("/mp/preview/{code}")
def mp_preview(code: str):
    """Public lobby preview — players + taken teams (no token needed)."""
    return _mp(mp_session.preview, code.upper())


@router.websocket("/mp/live/{code}/{match_key}")
async def mp_live_ws(ws: WebSocket, code: str, match_key: str, token: str):
    """Live H2H grudge match feed. Managers send commands, everyone gets
    snapshots. Messages in: {"action": "tactics"|"sub"|"ready", ...}."""
    try:
        room = mp_session.get_room(code)
        room.live_entry(match_key)          # 404 before accepting
        room._mgr(token)                    # must be a room member
    except KeyError:
        await ws.close(code=4004)
        return
    await ws.accept()
    hub = mp_live.hub_for(room, code, match_key)
    await hub.attach(ws)
    await hub.send_snapshot()
    try:
        while True:
            msg = await ws.receive_json()
            await hub.handle(ws, token, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.detach(ws)
        mp_live.cleanup_hub(code, match_key)


# ----------------------------- prediction league --------------------------- #
@router.post("/pl/create")
def pl_create(req: PLCreateRequest):
    """Create a prediction league: friends predict a simulated World Cup."""
    return _mp(pl_session.create, req.name, req.seed, req.deadline_minutes)


@router.post("/pl/join")
def pl_join(req: PLJoinRequest):
    return _mp(pl_session.join, req.code.upper(), req.name)


@router.post("/pl/start")
def pl_start(req: MPTokenRequest):
    return _mp(pl_session.start, req.code.upper(), req.token)


@router.post("/pl/predict")
def pl_predict(req: PLPredictRequest):
    """Lock in predictions; the round simulates when everyone is in."""
    return _mp(pl_session.predict, req.code.upper(), req.token, req.picks)


@router.get("/pl/state/{code}")
def pl_state(code: str, token: str):
    return _mp(pl_session.state, code.upper(), token)


@router.get("/pl/preview/{code}")
def pl_preview(code: str):
    return _mp(pl_session.preview, code.upper())


# --------------------------- continue-from-reality ------------------------ #
@router.post("/reality/odds")
def reality_odds(req: RealityRequest):
    sims = max(500, min(8000, req.simulations))
    return sim.reality_odds(req.results, sims)
