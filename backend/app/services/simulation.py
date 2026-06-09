"""Simulation service: caching, manage-a-team runs, single-match prediction."""
from __future__ import annotations

from functools import lru_cache
from typing import Dict, List, Optional

import numpy as np

from app.core.data import load_squads, load_tournament
from app.engine.match import TeamStrength, predict as predict_match
from app.engine.fast_odds import monte_carlo_fast
from app.engine.playerstats import attribute
from app.engine.simulator import monte_carlo, simulate_once
from app.engine.squad import lineup_delta


@lru_cache(maxsize=8)
def cached_odds(simulations: int = 5000) -> dict:
    """Live tournament odds via the vectorised fast engine.

    Computes fresh each (uncached) call — even 10k sims run in well under a
    second — so the numbers are genuinely live, not a static file. lru_cache only
    de-dupes identical back-to-back requests.
    """
    data = load_tournament()
    return monte_carlo_fast(data, n=simulations, seed=2026)


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
    awards = attribute(result, load_squads(), seed=(seed or 0))
    _merge_events(result, awards)
    result["awards"] = awards
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
    # Re-attribute so the managed team's stats reflect the chosen XI.
    awards = attribute(
        result, load_squads(), seed=(seed or 0),
        managed_team=team, managed_xi=starting_xi or None,
    )
    _merge_events(result, awards)
    result["awards"] = awards
    result["managed_team"] = team
    result["lineup"] = delta_info
    result["journey"] = _team_journey(team, result)
    # Trim payload (#17): the manage UI shows only the journey + awards, not the
    # full 104-match tree with every lineup. Drop the heavy arrays (~50-80KB).
    result.pop("group_matches", None)
    result.pop("knockout", None)
    result.pop("groups", None)
    return result


def manage_team_odds(
    team: str,
    starting_xi: List[str],
    simulations: int = 3000,
) -> dict:
    """Title/round odds for the managed team with the chosen XI."""
    data = load_tournament()
    if team not in data.teams:
        raise KeyError(f"Unknown team code: {team}")
    delta_info = compute_lineup(team, starting_xi) if starting_xi else {"elo_delta": 0.0}
    deltas = {team: float(delta_info.get("elo_delta", 0.0))}
    mc = monte_carlo_fast(data, n=max(simulations, 8000), seed=7, elo_overrides=deltas)
    team_row = next((t for t in mc["teams"] if t["code"] == team), None)
    return {"team": team, "lineup": delta_info, "odds": team_row,
            "simulations": mc["simulations"]}


def model_diagnostics() -> dict:
    """Aggregate model properties vs real World Cup reference averages.

    Computed analytically over all 72 group fixtures (neutral venue) — fast and
    deterministic. Proves the model sits in a realistic band rather than being
    asserted to. Reference figures are long-run men's World Cup norms.
    """
    data = load_tournament()
    preds = []
    for fx in (f for g in data.group_fixtures.values() for f in g):
        h, a = fx["home"], fx["away"]
        preds.append(predict_single(h, a, neutral=True))
    n = len(preds)
    avg_goals = sum(p["expected_goals_home"] + p["expected_goals_away"] for p in preds) / n
    draw_rate = sum(p["draw"] for p in preds) / n
    over25 = sum(p["over_2_5"] for p in preds) / n
    mc = cached_odds(2000)
    fav = mc["teams"][0]
    ref = {"goals_per_match": 2.6, "draw_rate": 0.24, "over_2_5": 0.50,
           "note": "Long-run men's World Cup group-stage norms."}
    def verdict(val, target, tol):
        return "on-target" if abs(val - target) <= tol else "off"
    return {
        "sample": f"{n} group fixtures (neutral, analytic)",
        "model": {
            "goals_per_match": round(avg_goals, 2),
            "draw_rate": round(draw_rate, 3),
            "over_2_5": round(over25, 3),
            "favourite": {"name": fav["name"], "p_title": fav["p_title"]},
        },
        "reference": ref,
        "checks": {
            "goals_per_match": verdict(avg_goals, ref["goals_per_match"], 0.3),
            "draw_rate": verdict(draw_rate, ref["draw_rate"], 0.06),
            "favourite_concentration": "on-target" if 0.15 <= fav["p_title"] <= 0.32 else "off",
        },
    }


def reality_odds(results: dict, simulations: int = 2000) -> dict:
    """Title/round odds conditioned on a set of known group results.

    `results`: {match_no(str|int): [home_goals, away_goals]}. Also returns the
    deterministic group standings implied by the pinned results so far.
    """
    data = load_tournament()
    fixed: Dict[int, tuple] = {}
    for k, v in (results or {}).items():
        try:
            fixed[int(k)] = (int(v[0]), int(v[1]))
        except (ValueError, TypeError, IndexError):
            continue
    mc = monte_carlo_fast(data, n=max(simulations, 8000), seed=2026, fixed_results=fixed)
    return {
        "simulations": mc["simulations"],
        "fixed_count": len(fixed),
        "teams": mc["teams"],
        "standings": _standings_from_results(data, fixed),
    }


def _standings_from_results(data, fixed: Dict[int, tuple]) -> dict:
    """Deterministic group tables from only the pinned results (played so far)."""
    from app.engine.tournament import TeamRecord, _sort_group

    by_group: Dict[str, Dict[str, TeamRecord]] = {}
    for g, fixtures in data.group_fixtures.items():
        recs = {}
        for fx in fixtures:
            for c in (fx["home"], fx["away"]):
                recs.setdefault(c, TeamRecord(c, g))
        for fx in fixtures:
            pin = fixed.get(fx.get("match_no"))
            if pin is None:
                continue
            h, a = fx["home"], fx["away"]
            recs[h].apply(a, int(pin[0]), int(pin[1]))
            recs[a].apply(h, int(pin[1]), int(pin[0]))
        by_group[g] = [r.as_dict() for r in _sort_group(list(recs.values()))]
    return by_group


def _merge_events(result: dict, awards: dict) -> None:
    """Attach per-match scorers + fielded XIs onto each match in the result."""
    events = awards.pop("match_events", {})
    lineups = awards.pop("lineups", {})
    for m in result.get("group_matches", []):
        no = m.get("match_no")
        m["events"] = events.get(no, {}).get("events", [])
        m["lineups"] = lineups.get(no)
    for m in result.get("knockout", []):
        no = m.get("match_no")
        m["events"] = events.get(no, {}).get("events", [])
        m["lineups"] = lineups.get(no)


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
                "events": m.get("events", []),
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
                "winner": m.get("winner"), "events": m.get("events", []),
            })
    return journey
