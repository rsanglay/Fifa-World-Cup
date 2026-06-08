"""Top-level tournament orchestration: single run + Monte Carlo aggregation."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

from app.engine.match import TeamStrength
from app.engine.tournament import (
    GROUPS,
    ROUND_ORDER,
    KnockoutMatch,
    TeamRecord,
    build_knockout,
    play_group,
)


@dataclass
class TournamentData:
    """Static, pre-loaded tournament definition."""

    teams: Dict[str, dict]                 # code -> team info (name, elo, group...)
    group_fixtures: Dict[str, List[dict]]  # group -> 6 fixtures
    knockout_meta: List[dict]              # 32 knockout slots w/ dates/venues
    venue_country: Dict[int, str]          # match_no -> host country

    def group_members(self) -> Dict[str, List[str]]:
        members: Dict[str, List[str]] = defaultdict(list)
        for code, t in self.teams.items():
            members[t["group"]].append(code)
        return members


def _strengths(
    data: TournamentData,
    lineup_deltas: Optional[Dict[str, float]] = None,
) -> Dict[str, TeamStrength]:
    lineup_deltas = lineup_deltas or {}
    return {
        code: TeamStrength(
            code=code,
            elo=float(t.get("elo", 1500)),
            lineup_delta=float(lineup_deltas.get(code, 0.0)),
        )
        for code, t in data.teams.items()
    }


def simulate_once(
    data: TournamentData,
    rng: np.random.Generator,
    lineup_deltas: Optional[Dict[str, float]] = None,
) -> dict:
    """One full tournament. Returns a JSON-friendly result tree."""
    strengths = _strengths(data, lineup_deltas)
    members = data.group_members()

    group_tables: Dict[str, List[TeamRecord]] = {}
    group_logs: List[dict] = []
    for g in GROUPS:
        if g not in members:
            continue
        table, log = play_group(
            g, members[g], strengths, data.group_fixtures.get(g, []),
            rng, data.venue_country,
        )
        group_tables[g] = table
        group_logs.extend(log)

    ko_matches, champion = build_knockout(
        group_tables, strengths, rng, data.knockout_meta,
    )

    return {
        "groups": {
            g: [r.as_dict() for r in table] for g, table in group_tables.items()
        },
        "group_matches": group_logs,
        "knockout": [_ko_dict(km) for km in ko_matches],
        "champion": champion,
        "runner_up": _final_runner_up(ko_matches),
        "third": _third_place(ko_matches),
    }


def _ko_dict(km: KnockoutMatch) -> dict:
    res = km.result
    return {
        "match_no": km.match_no, "round": km.round,
        "home": km.home, "away": km.away,
        "home_goals": res.home_goals if res else None,
        "away_goals": res.away_goals if res else None,
        "extra_time": res.went_extra_time if res else False,
        "penalties": res.went_penalties if res else False,
        "home_pens": res.home_pens if res else None,
        "away_pens": res.away_pens if res else None,
        "winner": km.winner_code,
        "venue": km.meta.get("venue"), "city": km.meta.get("city"),
        "date": km.meta.get("date"),
    }


def _final_runner_up(ko: List[KnockoutMatch]) -> Optional[str]:
    for km in ko:
        if km.round == "F":
            return km.loser_code
    return None


def _third_place(ko: List[KnockoutMatch]) -> Optional[str]:
    for km in ko:
        if km.round == "3P":
            return km.winner_code
    return None


# --------------------------------------------------------------------------- #
# Monte Carlo
# --------------------------------------------------------------------------- #
def _reached_rounds(result: dict) -> Dict[str, str]:
    """Map each team -> the furthest round it reached in this run."""
    reached: Dict[str, str] = {}
    for g, table in result["groups"].items():
        for r in table:
            reached[r["code"]] = "groups"
    rank = {r: i for i, r in enumerate(["groups"] + ROUND_ORDER + ["3P", "W"])}
    # 3P sits between SF and F conceptually; treat reaching a KO match as that round.
    for km in result["knockout"]:
        for code in (km["home"], km["away"]):
            if code and rank.get(km["round"], 0) > rank.get(reached.get(code, "groups"), 0):
                reached[code] = km["round"]
    if result["champion"]:
        reached[result["champion"]] = "W"
    return reached


def monte_carlo(
    data: TournamentData,
    n: int = 5000,
    lineup_deltas: Optional[Dict[str, float]] = None,
    seed: Optional[int] = None,
) -> dict:
    """Run N tournaments; aggregate per-team round-reach + title probabilities."""
    rng = np.random.default_rng(seed)
    counts: Dict[str, Dict[str, int]] = {
        code: defaultdict(int) for code in data.teams
    }
    title = defaultdict(int)
    final = defaultdict(int)
    champ_scores = []

    for _ in range(n):
        result = simulate_once(data, rng, lineup_deltas)
        for code, rnd in _reached_rounds(result).items():
            # Credit a team with every round up to and including its best.
            counts[code][rnd] += 1
        if result["champion"]:
            title[result["champion"]] += 1
        if result["runner_up"]:
            final[result["runner_up"]] += 1

    summary = []
    for code, t in data.teams.items():
        c = counts[code]
        # Reaching round R implies reaching all earlier rounds.
        ladder = ["R32", "R16", "QF", "SF", "F", "W"]
        cumulative = {}
        running = 0
        for rnd in reversed(ladder):
            running += c.get(rnd, 0)
            cumulative[rnd] = running
        summary.append({
            "code": code,
            "name": t.get("name", code),
            "group": t.get("group"),
            "elo": t.get("elo"),
            "fifa_ranking": t.get("fifa_ranking"),
            "p_round_of_32": round(cumulative["R32"] / n, 4),
            "p_round_of_16": round(cumulative["R16"] / n, 4),
            "p_quarter": round(cumulative["QF"] / n, 4),
            "p_semi": round(cumulative["SF"] / n, 4),
            "p_final": round(cumulative["F"] / n, 4),
            "p_title": round(title[code] / n, 4),
        })
    summary.sort(key=lambda s: s["p_title"], reverse=True)
    return {"simulations": n, "teams": summary}
