"""All HTTP routes for the World Cup 2026 predictor."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

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
    ManagePlayRequest,
    ManageSecondHalfRequest,
    ManageSimRequest,
    ManageStartRequest,
    MatchPredictRequest,
    RealityRequest,
    TournamentSimRequest,
)
from app.services import manage_session
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
def tournament_odds(simulations: int = Query(5000, ge=500, le=20000)):
    return sim.cached_odds(simulations)


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
    """Kick off an interactive match: tick it forward, pause, manage, substitute."""
    try:
        return manage_session.live_start(req.session_id, req.starting_xi, req.mentality)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/live/tick")
def manage_live_tick(req: LiveTickRequest):
    """Advance the live match by 1-5 game minutes (stops at HT / ET / FT)."""
    try:
        return manage_session.live_tick(req.session_id, req.minutes)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/manage/live/tactics")
def manage_live_tactics(req: LiveTacticsRequest):
    """Change any tactical dial mid-match — mentality, tempo, passing, pressing."""
    try:
        return manage_session.live_tactics(
            req.session_id, mentality=req.mentality, tempo=req.tempo,
            passing=req.passing, pressing=req.pressing)
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


# --------------------------- continue-from-reality ------------------------ #
@router.post("/reality/odds")
def reality_odds(req: RealityRequest):
    sims = max(500, min(8000, req.simulations))
    return sim.reality_odds(req.results, sims)
