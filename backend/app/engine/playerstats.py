"""Player-level attribution for a single narrative tournament.

The match engine produces team goals; this layer attributes those goals (and
assists, clean sheets, saves, chances created) to individual players so the
tournament can crown a Golden Boot, Golden Glove, Golden Ball, etc. Run only on
single narrative sims (full-sim playthrough + manage-a-team), never on the hot
Monte-Carlo path.

Attribution is weighted by position and rating: forwards score most, keepers
keep clean sheets and make saves. A seeded RNG keeps a given simulation stable.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional

import numpy as np

# Relative weight for being the scorer of a goal, by position.
SCORE_WEIGHT = {"FWD": 6.0, "MID": 3.0, "DEF": 1.0, "GK": 0.02}
ASSIST_WEIGHT = {"FWD": 3.0, "MID": 4.0, "DEF": 1.2, "GK": 0.05}


class _Tally:
    __slots__ = ("goals", "assists", "chances", "clean_sheets", "saves", "apps")

    def __init__(self):
        self.goals = self.assists = self.chances = 0
        self.clean_sheets = self.saves = self.apps = 0


def _xi_for(team: str, squad: List, managed_team: Optional[str],
            managed_xi: Optional[List[str]]):
    from app.engine.squad import best_xi
    if managed_team and team == managed_team and managed_xi:
        by_id = {p.id: p for p in squad}
        xi = [by_id[i] for i in managed_xi if i in by_id]
        if len(xi) == 11:
            return xi
    return best_xi(squad)


def _weighted_pick(rng, players, weights, exclude=None):
    pool = [(p, w) for p, w in zip(players, weights) if p is not exclude and w > 0]
    if not pool:
        return None
    ws = np.array([w for _, w in pool], dtype=float)
    ws /= ws.sum()
    idx = rng.choice(len(pool), p=ws)
    return pool[idx][0]


def attribute(
    result: dict,
    squads: Dict[str, List],
    seed: int = 0,
    managed_team: Optional[str] = None,
    managed_xi: Optional[List[str]] = None,
) -> dict:
    rng = np.random.default_rng(seed)
    tally: Dict[str, _Tally] = defaultdict(_Tally)
    player_team: Dict[str, str] = {}
    player_obj: Dict[str, object] = {}

    def xi(team: str):
        squad = squads.get(team, [])
        line = _xi_for(team, squad, managed_team, managed_xi)
        for p in line:
            player_team.setdefault(p.id, team)
            player_obj.setdefault(p.id, p)
        return line

    # Collect every played match as (home, away, hg, ag).
    matches = []
    for m in result.get("group_matches", []):
        matches.append((m["home"], m["away"], m["home_goals"], m["away_goals"]))
    for m in result.get("knockout", []):
        if m.get("home") and m.get("away") and m.get("home_goals") is not None:
            matches.append((m["home"], m["away"], m["home_goals"], m["away_goals"]))

    for home, away, hg, ag in matches:
        for team, scored, conceded, opp in (
            (home, hg, ag, away), (away, ag, hg, home)
        ):
            line = xi(team)
            if not line:
                continue
            for p in line:
                tally[p.id].apps += 1
            scorers = [p for p in line]
            sweights = [SCORE_WEIGHT.get(p.position, 1.0) * (p.rating / 80.0) for p in line]
            aweights = [ASSIST_WEIGHT.get(p.position, 1.0) * (p.rating / 80.0) for p in line]
            for _ in range(int(scored)):
                scorer = _weighted_pick(rng, scorers, sweights)
                if scorer is None:
                    continue
                tally[scorer.id].goals += 1
                if rng.random() < 0.72:  # ~72% of goals are assisted
                    assister = _weighted_pick(rng, scorers, aweights, exclude=scorer)
                    if assister is not None:
                        tally[assister.id].assists += 1
                        tally[assister.id].chances += 1
            # Extra chances created (key passes that didn't lead to goals).
            for p in line:
                if p.position in ("MID", "FWD"):
                    tally[p.id].chances += int(rng.poisson(0.6))
            # Goalkeeper: clean sheet + saves.
            gk = next((p for p in line if p.position == "GK"), None)
            if gk is not None:
                if conceded == 0:
                    tally[gk.id].clean_sheets += 1
                shots_faced = conceded + int(rng.poisson(2.6))
                tally[gk.id].saves += max(0, shots_faced - conceded)

    return _leaderboards(tally, player_team, player_obj, result.get("team_names", {}))


def _row(pid, t, player_team, player_obj, team_names, value_keys):
    p = player_obj[pid]
    team = player_team[pid]
    row = {
        "id": pid, "name": p.name, "position": p.position,
        "team": team, "team_name": team_names.get(team, team),
        "photo_url": getattr(p, "photo_url", ""),
        "goals": t.goals, "assists": t.assists, "chances": t.chances,
        "clean_sheets": t.clean_sheets, "saves": t.saves, "apps": t.apps,
    }
    return row


def _leaderboards(tally, player_team, player_obj, team_names) -> dict:
    rows = [
        _row(pid, t, player_team, player_obj, team_names, None)
        for pid, t in tally.items()
    ]

    def top(key, secondary, n=10, filt=None):
        pool = [r for r in rows if (filt is None or filt(r))]
        return sorted(pool, key=lambda r: (r[key], r.get(secondary, 0)), reverse=True)[:n]

    golden_boot = top("goals", "assists")
    top_assists = top("assists", "goals")
    chances = top("chances", "assists")
    is_gk = lambda r: r["position"] == "GK"
    clean_sheets = top("clean_sheets", "saves", filt=is_gk)
    saves = top("saves", "clean_sheets", filt=is_gk)

    # Golden Ball: best overall player by a weighted composite.
    def composite(r):
        return (r["goals"] * 4 + r["assists"] * 3 + r["chances"] * 0.4
                + r["clean_sheets"] * 2.5 + r["saves"] * 0.25
                + player_obj[r["id"]].rating * 0.1)
    golden_ball = sorted(rows, key=composite, reverse=True)[:5]
    for r in golden_ball:
        r["rating_score"] = round(composite(r), 1)

    young = [r for r in rows if getattr(player_obj[r["id"]], "age", 99) <= 21]
    young_player = sorted(young, key=composite, reverse=True)[:5]

    return {
        "golden_boot": golden_boot,
        "top_assists": top_assists,
        "chances_created": chances,
        "clean_sheets": clean_sheets,
        "most_saves": saves,
        "golden_ball": golden_ball,
        "young_player": young_player,
    }
