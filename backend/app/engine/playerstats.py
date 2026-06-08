"""Player-level attribution for a single narrative tournament.

The match engine produces team goals; this layer attributes those goals (and
assists, clean sheets, saves, chances created) to individual players, records
per-match events (scorer + minute + assist) and the XI each team fielded, and
rolls everything up into tournament award leaderboards. Run only on single
narrative sims (full-sim playthrough + manage-a-team), never on the hot
Monte-Carlo path.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional

import numpy as np

SCORE_WEIGHT = {"FWD": 6.0, "MID": 3.0, "DEF": 1.0, "GK": 0.02}
ASSIST_WEIGHT = {"FWD": 3.0, "MID": 4.0, "DEF": 1.2, "GK": 0.05}


class _Tally:
    __slots__ = ("goals", "assists", "chances", "clean_sheets", "saves", "apps")

    def __init__(self):
        self.goals = self.assists = self.chances = 0
        self.clean_sheets = self.saves = self.apps = 0


def _xi_for(team, squad, managed_team, managed_xi):
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
    return pool[int(rng.choice(len(pool), p=ws))][0]


def _minutes(rng, n, extra_time):
    cap = 120 if extra_time else 90
    if n == 0:
        return []
    mins = sorted(int(m) for m in rng.integers(1, cap + 1, size=n))
    # Nudge duplicates apart so two goals don't share a minute.
    for i in range(1, len(mins)):
        if mins[i] <= mins[i - 1]:
            mins[i] = min(cap, mins[i - 1] + 1)
    return mins


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
    xi_cache: Dict[str, list] = {}

    def xi(team: str):
        if team not in xi_cache:
            line = _xi_for(team, squads.get(team, []), managed_team, managed_xi)
            for p in line:
                player_team.setdefault(p.id, team)
                player_obj.setdefault(p.id, p)
            xi_cache[team] = line
        return xi_cache[team]

    def xi_payload(line):
        return [{
            "id": p.id, "name": p.name, "position": p.position,
            "number": p.number, "rating": p.rating, "photo_url": getattr(p, "photo_url", ""),
        } for p in line]

    # Gather every played match with its metadata.
    matches = []
    for m in result.get("group_matches", []):
        matches.append((m["match_no"], m["home"], m["away"], m["home_goals"],
                        m["away_goals"], False, None, None,
                        m.get("red_home"), m.get("red_away")))
    for m in result.get("knockout", []):
        if m.get("home") and m.get("away") and m.get("home_goals") is not None:
            matches.append((m["match_no"], m["home"], m["away"], m["home_goals"],
                            m["away_goals"], bool(m.get("extra_time")),
                            m.get("home_pens"), m.get("away_pens"),
                            m.get("red_home"), m.get("red_away")))

    match_events: Dict[int, dict] = {}
    lineups: Dict[int, dict] = {}

    for no, home, away, hg, ag, et, hp, ap, red_h, red_a in matches:
        home_xi, away_xi = xi(home), xi(away)
        lineups[no] = {"home": xi_payload(home_xi), "away": xi_payload(away_xi)}
        events = []
        for team, line, scored, conceded in (
            (home, home_xi, hg, ag), (away, away_xi, ag, hg)
        ):
            for p in line:
                tally[p.id].apps += 1
            sweights = [SCORE_WEIGHT.get(p.position, 1.0) * (p.rating / 80.0) for p in line]
            aweights = [ASSIST_WEIGHT.get(p.position, 1.0) * (p.rating / 80.0) for p in line]
            mins = _minutes(rng, int(scored), et)
            for k in range(int(scored)):
                scorer = _weighted_pick(rng, line, sweights)
                if scorer is None:
                    continue
                tally[scorer.id].goals += 1
                assist = None
                if rng.random() < 0.72:
                    assister = _weighted_pick(rng, line, aweights, exclude=scorer)
                    if assister is not None:
                        tally[assister.id].assists += 1
                        tally[assister.id].chances += 1
                        assist = assister.name
                events.append({
                    "type": "goal",
                    "minute": mins[k] if k < len(mins) else 90,
                    "team": team, "scorer": scorer.name,
                    "scorer_id": scorer.id, "position": scorer.position,
                    "assist": assist,
                })
            for p in line:
                if p.position in ("MID", "FWD"):
                    tally[p.id].chances += int(rng.poisson(0.6))
            gk = next((p for p in line if p.position == "GK"), None)
            if gk is not None:
                if conceded == 0:
                    tally[gk.id].clean_sheets += 1
                shots = conceded + int(rng.poisson(2.6))
                tally[gk.id].saves += max(0, shots - conceded)
        # Red cards: attribute to a defender/midfielder on the carded side.
        for team, line, red_min in ((home, home_xi, red_h), (away, away_xi, red_a)):
            if red_min:
                cand = [p for p in line if p.position in ("DEF", "MID")] or line
                carded = cand[int(rng.integers(len(cand)))]
                events.append({
                    "type": "red", "minute": int(red_min), "team": team,
                    "scorer": carded.name, "scorer_id": carded.id,
                    "position": carded.position, "assist": None,
                })
        events.sort(key=lambda e: e["minute"])
        match_events[no] = {
            "events": events, "penalties": hp is not None,
            "home_pens": hp, "away_pens": ap,
        }

    out = _leaderboards(tally, player_team, player_obj, result.get("team_names", {}))
    out["match_events"] = match_events
    out["lineups"] = lineups
    return out


def _row(pid, t, player_team, player_obj, team_names):
    p = player_obj[pid]
    team = player_team[pid]
    return {
        "id": pid, "name": p.name, "position": p.position,
        "team": team, "team_name": team_names.get(team, team),
        "photo_url": getattr(p, "photo_url", ""),
        "goals": t.goals, "assists": t.assists, "chances": t.chances,
        "clean_sheets": t.clean_sheets, "saves": t.saves, "apps": t.apps,
    }


def _leaderboards(tally, player_team, player_obj, team_names) -> dict:
    rows = [_row(pid, t, player_team, player_obj, team_names) for pid, t in tally.items()]

    def top(key, secondary, n=10, filt=None):
        pool = [r for r in rows if (filt is None or filt(r))]
        return sorted(pool, key=lambda r: (r[key], r.get(secondary, 0)), reverse=True)[:n]

    is_gk = lambda r: r["position"] == "GK"

    def composite(r):
        return (r["goals"] * 4 + r["assists"] * 3 + r["chances"] * 0.4
                + r["clean_sheets"] * 2.5 + r["saves"] * 0.25
                + player_obj[r["id"]].rating * 0.1)

    golden_ball = sorted(rows, key=composite, reverse=True)[:5]
    for r in golden_ball:
        r["rating_score"] = round(composite(r), 1)
    young = sorted(
        [r for r in rows if getattr(player_obj[r["id"]], "age", 99) <= 21],
        key=composite, reverse=True,
    )[:5]

    return {
        "golden_boot": top("goals", "assists"),
        "top_assists": top("assists", "goals"),
        "chances_created": top("chances", "assists"),
        "clean_sheets": top("clean_sheets", "saves", filt=is_gk),
        "most_saves": top("saves", "clean_sheets", filt=is_gk),
        "golden_ball": golden_ball,
        "young_player": young,
    }
