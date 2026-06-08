"""Full World Cup 2026 tournament simulation.

Format (48 teams, new for 2026):
  * 12 groups of 4 -> round robin (3 pts win / 1 draw).
  * Top 2 of each group (24) + 8 best third-placed teams -> Round of 32.
  * Single-elimination R32 -> R16 -> QF -> SF -> Final (+ 3rd-place play-off).

Two public entry points:
  * `simulate_once()`     -> one full random tournament (used by the
                             cinematic front-end and manage-a-team mode).
  * `monte_carlo()`       -> N tournaments, aggregated per-team round
                             probabilities and title odds.

The knockout bracket TOPOLOGY (which group slots feed which R32 match, the
dates and venues) is real and data-driven; the participants are whatever the
simulated group stage produces — exactly as in the real tournament, where the
bracket structure is fixed before any team is known.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np

from app.engine.match import MatchResult, TeamStrength, simulate

GROUPS = list("ABCDEFGHIJKL")  # 12 groups
HOST_COUNTRIES = {"USA", "MEX", "CAN"}
# Rest / fatigue: a team turning around on short rest carries an Elo penalty.
# What matters in a match is the rest *differential* between the two sides.
NORMAL_REST_DAYS = 4          # a standard gap between fixtures
FATIGUE_ELO_PER_DAY = 16.0    # Elo penalty per day short of normal
FATIGUE_CAP = 48.0            # max penalty for an exhausted side


def _days_between(date_a: str, date_b: str) -> Optional[int]:
    """Whole days from date_b -> date_a (both 'YYYY-MM-DD'); None if unknown."""
    from datetime import date
    try:
        return (date.fromisoformat(date_a) - date.fromisoformat(date_b)).days
    except (ValueError, TypeError):
        return None


def fatigue_penalty(rest_days: Optional[int]) -> float:
    """Elo penalty (>=0) for a side playing on `rest_days` days' rest."""
    if rest_days is None:
        return 0.0
    short = max(0, NORMAL_REST_DAYS - rest_days)
    return min(FATIGUE_CAP, short * FATIGUE_ELO_PER_DAY)


def _net_fatigue_adv(
    home: str, away: str, match_date: Optional[str], last_played: Dict[str, str]
) -> float:
    """Home-side Elo adjustment from the rest differential (home minus away)."""
    if not match_date:
        return 0.0
    rest_h = _days_between(match_date, last_played[home]) if home in last_played else None
    rest_a = _days_between(match_date, last_played[away]) if away in last_played else None
    # A tired opponent helps the home side; a tired home side hurts it.
    return fatigue_penalty(rest_a) - fatigue_penalty(rest_h)
ROUND_ORDER = ["R32", "R16", "QF", "SF", "F"]
ROUND_LABEL = {
    "groups": "Group stage",
    "R32": "Round of 32",
    "R16": "Round of 16",
    "QF": "Quarter-final",
    "SF": "Semi-final",
    "F": "Final",
    "W": "Champion",
}


# --------------------------------------------------------------------------- #
# Group stage
# --------------------------------------------------------------------------- #
@dataclass
class TeamRecord:
    code: str
    group: str
    played: int = 0
    won: int = 0
    drawn: int = 0
    lost: int = 0
    gf: int = 0
    ga: int = 0
    points: int = 0
    # head-to-head results keyed by opponent code -> (gf, ga, pts)
    h2h: Dict[str, tuple] = field(default_factory=dict)

    @property
    def gd(self) -> int:
        return self.gf - self.ga

    def apply(self, opp: str, gf: int, ga: int) -> None:
        self.played += 1
        self.gf += gf
        self.ga += ga
        if gf > ga:
            self.won += 1
            self.points += 3
            pts = 3
        elif gf == ga:
            self.drawn += 1
            self.points += 1
            pts = 1
        else:
            self.lost += 1
            pts = 0
        self.h2h[opp] = (gf, ga, pts)

    def as_dict(self) -> dict:
        return {
            "code": self.code, "group": self.group, "played": self.played,
            "won": self.won, "drawn": self.drawn, "lost": self.lost,
            "gf": self.gf, "ga": self.ga, "gd": self.gd, "points": self.points,
        }


def _sort_group(records: List[TeamRecord]) -> List[TeamRecord]:
    """FIFA tiebreakers: points, GD, GF, then head-to-head among tied teams."""
    def overall_key(r: TeamRecord):
        return (r.points, r.gd, r.gf)

    ordered = sorted(records, key=overall_key, reverse=True)
    # Resolve ties with mini-league head-to-head among equal (pts, gd, gf).
    result: List[TeamRecord] = []
    i = 0
    while i < len(ordered):
        j = i + 1
        while j < len(ordered) and overall_key(ordered[j]) == overall_key(ordered[i]):
            j += 1
        block = ordered[i:j]
        if len(block) > 1:
            block = _break_h2h(block)
        result.extend(block)
        i = j
    return result


def _break_h2h(block: List[TeamRecord]) -> List[TeamRecord]:
    codes = {r.code for r in block}
    h2h_pts: Dict[str, tuple] = {}
    for r in block:
        pts = gf = ga = 0
        for opp, (g_for, g_against, p) in r.h2h.items():
            if opp in codes:
                pts += p
                gf += g_for
                ga += g_against
        h2h_pts[r.code] = (pts, gf - ga, gf)
    return sorted(block, key=lambda r: h2h_pts[r.code], reverse=True)


def play_group(
    group: str,
    team_codes: Sequence[str],
    strengths: Dict[str, TeamStrength],
    fixtures: List[dict],
    rng: np.random.Generator,
    venue_country: Dict[int, str],
    last_played: Optional[Dict[str, str]] = None,
) -> tuple[List[TeamRecord], List[dict]]:
    """Simulate one group's 6 matches; return sorted table + match log.

    Matches are played in date order so each team's rest (days since its
    previous fixture) is tracked correctly via `last_played`.
    """
    if last_played is None:
        last_played = {}
    records = {c: TeamRecord(c, group) for c in team_codes}
    log: List[dict] = []
    ordered = sorted(fixtures, key=lambda f: (f.get("date", ""), f.get("match_no", 0)))
    for fx in ordered:
        home, away = fx["home"], fx["away"]
        country = fx.get("country", "")
        date = fx.get("date")
        h_adv = _home_adv(home, away, country)
        h_adv += _net_fatigue_adv(home, away, date, last_played)
        res = simulate(strengths[home], strengths[away], rng, home_advantage=h_adv)
        records[home].apply(away, res.home_goals, res.away_goals)
        records[away].apply(home, res.away_goals, res.home_goals)
        if date:
            last_played[home] = date
            last_played[away] = date
        log.append({
            "match_no": fx.get("match_no"), "group": group,
            "home": home, "away": away,
            "home_goals": res.home_goals, "away_goals": res.away_goals,
            "date": date, "city": fx.get("city"), "venue": fx.get("venue"),
        })
    return _sort_group(list(records.values())), log


def _home_adv(home: str, away: str, country: str) -> float:
    from app.engine.match import HOST_HOME_ADVANTAGE
    code_for_country = {"USA": "USA", "United States": "USA",
                        "Mexico": "MEX", "Canada": "CAN"}
    host_code = code_for_country.get(country)
    if host_code == home:
        return HOST_HOME_ADVANTAGE
    if host_code == away:
        return -HOST_HOME_ADVANTAGE * 0.4  # away host disadvantage is partial
    return 0.0


def rank_third_placed(third_records: List[TeamRecord]) -> List[TeamRecord]:
    """Rank the 12 third-placed teams; the top 8 advance."""
    return sorted(third_records, key=lambda r: (r.points, r.gd, r.gf), reverse=True)


# --------------------------------------------------------------------------- #
# Knockout bracket
# --------------------------------------------------------------------------- #
# R32 pairings. Each entry: (slot_home, slot_away).
#   "A1" = winner group A, "B2" = runner-up group B, "T1".."T8" = ranked thirds.
# This is a balanced, official-style bracket: group winners are seeded to meet
# runners-up / thirds first and kept apart from other winners until later.
R32_PAIRINGS = [
    ("A1", "T1"), ("C1", "D2"),   # 73, 74
    ("E1", "T2"), ("G1", "H2"),   # 75, 76
    ("I1", "T3"), ("K1", "L2"),   # 77, 78
    ("B1", "T4"), ("D1", "C2"),   # 79, 80
    ("F1", "T5"), ("H1", "G2"),   # 81, 82
    ("J1", "T6"), ("L1", "K2"),   # 83, 84
    ("A2", "B2"), ("E2", "T7"),   # 85, 86
    ("F2", "I2"), ("J2", "T8"),   # 87, 88
]


@dataclass
class KnockoutMatch:
    match_no: int
    round: str
    home: Optional[str] = None
    away: Optional[str] = None
    result: Optional[MatchResult] = None
    winner_code: Optional[str] = None
    loser_code: Optional[str] = None
    meta: dict = field(default_factory=dict)


def _resolve_qualifiers(
    group_tables: Dict[str, List[TeamRecord]],
) -> tuple[Dict[str, str], List[str]]:
    """Return slot->code map for A1/A2.. plus ordered thirds T1..T8."""
    slot_map: Dict[str, str] = {}
    thirds: List[TeamRecord] = []
    for g, table in group_tables.items():
        slot_map[f"{g}1"] = table[0].code
        slot_map[f"{g}2"] = table[1].code
        if len(table) >= 3:
            thirds.append(table[2])
    best_thirds = rank_third_placed(thirds)[:8]
    for idx, rec in enumerate(best_thirds, start=1):
        slot_map[f"T{idx}"] = rec.code
    return slot_map, [r.code for r in best_thirds]


def build_knockout(
    group_tables: Dict[str, List[TeamRecord]],
    strengths: Dict[str, TeamStrength],
    rng: np.random.Generator,
    knockout_meta: Optional[List[dict]] = None,
    last_played: Optional[Dict[str, str]] = None,
) -> tuple[List[KnockoutMatch], str]:
    """Simulate the entire knockout phase; return all matches + champion."""
    if last_played is None:
        last_played = {}
    slot_map, _ = _resolve_qualifiers(group_tables)
    meta_by_no = {m["match_no"]: m for m in (knockout_meta or [])}

    matches: List[KnockoutMatch] = []

    # ---- Round of 32 ----
    r32: List[KnockoutMatch] = []
    for i, (sh, sa) in enumerate(R32_PAIRINGS):
        no = 73 + i
        km = KnockoutMatch(no, "R32",
                           home=slot_map.get(sh), away=slot_map.get(sa),
                           meta=meta_by_no.get(no, {}))
        _play_ko(km, strengths, rng, last_played)
        r32.append(km)
    matches.extend(r32)

    # ---- Subsequent rounds: pair winners sequentially. ----
    prev = r32
    start_no = 89
    for rnd, count in (("R16", 8), ("QF", 4), ("SF", 2), ("F", 1)):
        cur: List[KnockoutMatch] = []
        for k in range(count):
            no = start_no + k
            home = prev[2 * k].winner_code
            away = prev[2 * k + 1].winner_code
            km = KnockoutMatch(no, rnd, home=home, away=away,
                               meta=meta_by_no.get(no, {}))
            _play_ko(km, strengths, rng, last_played)
            cur.append(km)
        matches.extend(cur)
        if rnd == "SF":  # third-place play-off contested by the two SF losers
            tp = KnockoutMatch(start_no + count, "3P",
                               home=cur[0].loser_code, away=cur[1].loser_code,
                               meta=meta_by_no.get(start_no + count, {}))
            _play_ko(tp, strengths, rng, last_played)
            matches.append(tp)
            start_no = start_no + count + 1
        else:
            start_no += count
        prev = cur

    champion = prev[0].winner_code
    return matches, champion


def _play_ko(
    km: KnockoutMatch,
    strengths: Dict[str, TeamStrength],
    rng: np.random.Generator,
    last_played: Optional[Dict[str, str]] = None,
) -> None:
    if not km.home or not km.away:
        return
    if last_played is None:
        last_played = {}
    country = km.meta.get("country", "")
    date = km.meta.get("date")
    h_adv = _home_adv(km.home, km.away, country)
    h_adv += _net_fatigue_adv(km.home, km.away, date, last_played)
    res = simulate(strengths[km.home], strengths[km.away], rng,
                   home_advantage=h_adv, knockout=True)
    km.result = res
    if res.winner == "home":
        km.winner_code, km.loser_code = km.home, km.away
    else:
        km.winner_code, km.loser_code = km.away, km.home
    if date:
        last_played[km.home] = date
        last_played[km.away] = date
