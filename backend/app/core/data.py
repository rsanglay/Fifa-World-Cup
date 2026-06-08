"""Load the static tournament data files into engine-ready structures."""
from __future__ import annotations

import json
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Dict, List

from app.engine.simulator import TournamentData
from app.engine.squad import Player, generate_squad

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


def _load(name: str):
    path = DATA_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Data file missing: {path}")
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=1)
def load_teams() -> Dict[str, dict]:
    return {t["code"]: t for t in _load("teams.json")}


@lru_cache(maxsize=1)
def load_venues() -> List[dict]:
    return _load("venues.json")


@lru_cache(maxsize=1)
def load_historical() -> dict:
    try:
        return _load("historical.json")
    except FileNotFoundError:
        return {"champions": [], "most_titles": []}


@lru_cache(maxsize=1)
def load_fixtures() -> dict:
    return _load("fixtures.json")


@lru_cache(maxsize=1)
def load_squads() -> Dict[str, List[Player]]:
    """Real squads from squads.json if present, else procedural fallback."""
    teams = load_teams()
    squads: Dict[str, List[Player]] = {}
    raw: dict = {}
    try:
        raw = _load("squads.json")
    except FileNotFoundError:
        raw = {}
    for code, t in teams.items():
        entries = raw.get(code)
        if entries:
            squads[code] = [
                Player(
                    id=e.get("id", f"{code}-{i}"),
                    name=e["name"],
                    position=e["position"],
                    rating=int(e.get("rating") or _modelled_rating(t, e, i)),
                    club=e.get("club", ""),
                    number=int(e.get("number", i + 1)),
                )
                for i, e in enumerate(entries)
            ]
        else:
            squads[code] = generate_squad(code, float(t.get("elo", 1500)))
    return squads


# Importance tier -> rating bump above the team's average level.
_TIER_BUMP = {"star": 9.0, "starter": 3.5, "rotation": -2.5, "fringe": -6.5}


def _modelled_rating(team: dict, entry: dict, idx: int) -> int:
    """Derive a 50-94 rating from the player's importance tier + team strength.

    Real squad files carry a `tier` (star/starter/rotation/fringe) rather than a
    numeric rating; the team's Elo sets the average level and the tier spreads
    players around it so stars outrate fringe within every squad.
    """
    from app.engine.squad import elo_to_base_rating

    base = elo_to_base_rating(float(team.get("elo", 1500)))
    tier = str(entry.get("tier", "rotation")).lower()
    bump = _TIER_BUMP.get(tier, -2.5)
    # Tiny deterministic intra-tier spread so the "best XI" is well-defined.
    jitter = (hash(entry.get("name", "")) % 5) * 0.4
    return int(max(50, min(94, round(base + bump + jitter))))


@lru_cache(maxsize=1)
def group_stage_with_rest() -> List[dict]:
    """Group fixtures annotated with each team's days of rest before the match."""
    from datetime import date

    fixtures = load_fixtures().get("group_stage", [])
    # Per team, the ordered dates of its group matches.
    by_team: Dict[str, List[tuple]] = defaultdict(list)
    for fx in fixtures:
        for side in ("home", "away"):
            if fx.get(side) and fx.get("date"):
                by_team[fx[side]].append((fx["date"], fx["match_no"]))
    prev_date: Dict[str, str] = {}
    ordered_team_dates: Dict[str, List[str]] = {
        t: [d for d, _ in sorted(v)] for t, v in by_team.items()
    }
    # Map (team, date) -> rest days vs that team's previous fixture.
    rest_lookup: Dict[tuple, int] = {}
    for team, dates in ordered_team_dates.items():
        for i, d in enumerate(dates):
            if i == 0:
                continue
            try:
                rest_lookup[(team, d)] = (
                    date.fromisoformat(d) - date.fromisoformat(dates[i - 1])
                ).days
            except ValueError:
                pass

    annotated: List[dict] = []
    for fx in sorted(fixtures, key=lambda f: (f.get("date", ""), f.get("match_no", 0))):
        out = dict(fx)
        out["home_rest"] = rest_lookup.get((fx.get("home"), fx.get("date")))
        out["away_rest"] = rest_lookup.get((fx.get("away"), fx.get("date")))
        annotated.append(out)
    return annotated


@lru_cache(maxsize=1)
def load_tournament() -> TournamentData:
    teams = load_teams()
    fixtures = load_fixtures()

    group_fixtures: Dict[str, List[dict]] = defaultdict(list)
    venue_country: Dict[int, str] = {}
    for fx in fixtures.get("group_stage", []):
        group_fixtures[fx["group"]].append(fx)
        if fx.get("match_no") is not None:
            venue_country[fx["match_no"]] = fx.get("country", "")

    knockout_meta = fixtures.get("knockout", [])
    for km in knockout_meta:
        if km.get("match_no") is not None:
            venue_country[km["match_no"]] = km.get("country", "")

    return TournamentData(
        teams=teams,
        group_fixtures=dict(group_fixtures),
        knockout_meta=knockout_meta,
        venue_country=venue_country,
    )


def reset_caches() -> None:
    for fn in (load_teams, load_venues, load_historical, load_fixtures,
               load_squads, load_tournament, group_stage_with_rest):
        fn.cache_clear()
