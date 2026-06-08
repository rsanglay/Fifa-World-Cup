"""All HTTP routes for the World Cup 2026 predictor."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.core.data import (
    load_historical,
    load_squads,
    load_teams,
    load_tournament,
    load_venues,
)
from app.engine.squad import FORMATIONS, best_xi
from app.schemas import (
    LineupRequest,
    ManageSimRequest,
    MatchPredictRequest,
    TournamentSimRequest,
)
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
        "group_stage": [fx for g in data.group_fixtures.values() for fx in g],
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
