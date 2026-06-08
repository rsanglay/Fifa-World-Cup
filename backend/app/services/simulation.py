"""Simulation service: caching, manage-a-team runs, single-match prediction."""
from __future__ import annotations

from functools import lru_cache
from typing import Dict, List, Optional

import numpy as np

from app.core.data import load_squads, load_tournament
from app.engine.match import TeamStrength, predict as predict_match
from app.engine.simulator import monte_carlo, simulate_once
from app.engine.squad import lineup_delta


@lru_cache(maxsize=8)
def cached_odds(simulations: int = 5000) -> dict:
    """Baseline tournament odds (full-strength teams). Cached by N."""
    data = load_tournament()
    return monte_carlo(data, n=simulations, seed=2026)


def predict_single(home: str, away: str, neutral: bool = True) -> dict:
    data = load_tournament()
    for c in (home, away):
        if c not in data.teams:
            raise KeyError(f"Unknown team code: {c}")
    h = TeamStrength(home, float(data.teams[home]["elo"]))
    a = TeamStrength(away, float(data.teams[away]["elo"]))
    from app.engine.match import HOST_HOME_ADVANTAGE
    adv = 0.0 if neutral else HOST_HOME_ADVANTAGE
    out = predict_match(h, a, home_advantage=adv)
    out.update({
        "home": home, "away": away,
        "home_name": data.teams[home]["name"],
        "away_name": data.teams[away]["name"],
    })
    return out


def compute_lineup(team: str, starting_xi: List[str]) -> dict:
    squads = load_squads()
    if team not in squads:
        raise KeyError(f"Unknown team code: {team}")
    res = lineup_delta(squads[team], starting_xi)
    res["team"] = team
    return res


def simulate_full(
    seed: Optional[int] = None,
    lineup_deltas: Optional[Dict[str, float]] = None,
) -> dict:
    """One narrative tournament run (for the cinematic playthrough)."""
    data = load_tournament()
    rng = np.random.default_rng(seed)
    result = simulate_once(data, rng, lineup_deltas)
    result["team_names"] = {c: t["name"] for c, t in data.teams.items()}
    return result


def manage_team_run(
    team: str,
    starting_xi: List[str],
    seed: Optional[int] = None,
) -> dict:
    """Run one tournament with `team` fielding the chosen XI.

    Returns the full run plus a focused summary of the managed team's journey.
    """
    data = load_tournament()
    if team not in data.teams:
        raise KeyError(f"Unknown team code: {team}")

    delta_info = compute_lineup(team, starting_xi) if starting_xi else {
        "elo_delta": 0.0, "valid": True, "strength_pct": 100.0,
        "formation": None, "message": "Full-strength (no XI submitted)",
    }
    deltas = {team: float(delta_info.get("elo_delta", 0.0))}
    result = simulate_full(seed=seed, lineup_deltas=deltas)
    result["managed_team"] = team
    result["lineup"] = delta_info
    result["journey"] = _team_journey(team, result)
    return result


def manage_team_odds(
    team: str,
    starting_xi: List[str],
    simulations: int = 3000,
) -> dict:
    """Title/round odds for the managed team with the chosen XI."""
    data = load_tournament()
    delta_info = compute_lineup(team, starting_xi) if starting_xi else {"elo_delta": 0.0}
    deltas = {team: float(delta_info.get("elo_delta", 0.0))}
    mc = monte_carlo(data, n=simulations, lineup_deltas=deltas, seed=7)
    team_row = next((t for t in mc["teams"] if t["code"] == team), None)
    return {"team": team, "lineup": delta_info, "odds": team_row,
            "simulations": simulations}


def _team_journey(team: str, result: dict) -> List[dict]:
    """Extract the managed team's match-by-match path through the tournament."""
    journey: List[dict] = []
    names = result.get("team_names", {})
    for m in result["group_matches"]:
        if team in (m["home"], m["away"]):
            journey.append({
                "stage": "Group stage", "round": "groups",
                "home": m["home"], "away": m["away"],
                "home_name": names.get(m["home"]), "away_name": names.get(m["away"]),
                "home_goals": m["home_goals"], "away_goals": m["away_goals"],
            })
    for m in result["knockout"]:
        if team in (m["home"], m["away"]):
            journey.append({
                "stage": m["round"], "round": m["round"],
                "home": m["home"], "away": m["away"],
                "home_name": names.get(m["home"]), "away_name": names.get(m["away"]),
                "home_goals": m["home_goals"], "away_goals": m["away_goals"],
                "penalties": m.get("penalties"),
                "home_pens": m.get("home_pens"), "away_pens": m.get("away_pens"),
                "winner": m.get("winner"),
            })
    return journey
