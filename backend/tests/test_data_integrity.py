"""Data + bracket integrity — locks the tournament structure against silent rot.

Council finding #1 (flagged by 3 lenses): a silent mutation of the bracket or a
squad data edit can break the whole tournament with no signal. These tests are
the signal.
"""
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.data import load_fixtures, load_squads, load_teams
from app.engine.tournament import GROUPS, R32_PAIRINGS


# ---------------------------- bracket topology ---------------------------- #
def test_r32_pairings_shape():
    assert len(R32_PAIRINGS) == 16
    slots = [s for pair in R32_PAIRINGS for s in pair]
    assert len(slots) == 32


def test_r32_covers_every_qualifier_exactly_once():
    slots = [s for pair in R32_PAIRINGS for s in pair]
    counts = Counter(slots)
    # All 12 group winners and 12 runners-up appear exactly once.
    for g in GROUPS:
        assert counts[f"{g}1"] == 1, f"winner slot {g}1 used {counts[f'{g}1']}x"
        assert counts[f"{g}2"] == 1, f"runner slot {g}2 used {counts[f'{g}2']}x"
    # Exactly 8 best-third slots T1..T8, each once.
    for i in range(1, 9):
        assert counts[f"T{i}"] == 1, f"third slot T{i} used {counts[f'T{i}']}x"
    # Nothing else sneaked in.
    assert set(counts) == (
        {f"{g}1" for g in GROUPS} | {f"{g}2" for g in GROUPS} | {f"T{i}" for i in range(1, 9)}
    )


# ----------------------------- fixtures data ------------------------------ #
def test_group_fixtures_complete():
    fx = load_fixtures()["group_stage"]
    assert len(fx) == 72
    nos = sorted(f["match_no"] for f in fx)
    assert nos == list(range(1, 73)), "group match numbers must be 1..72 contiguous"
    by_group = Counter(f["group"] for f in fx)
    for g in GROUPS:
        assert by_group[g] == 6, f"group {g} has {by_group[g]} matches, expected 6"


def test_knockout_match_numbers_contiguous():
    ko = load_fixtures()["knockout"]
    assert len(ko) == 32
    nos = sorted(m["match_no"] for m in ko)
    assert nos == list(range(73, 105)), "knockout match numbers must be 73..104"


def test_every_team_plays_three_group_games():
    fx = load_fixtures()["group_stage"]
    appearances: Counter = Counter()
    for f in fx:
        appearances[f["home"]] += 1
        appearances[f["away"]] += 1
    teams = load_teams()
    assert len(teams) == 48
    for code in teams:
        assert appearances[code] == 3, f"{code} plays {appearances[code]} group games"


def test_fixture_team_codes_are_known():
    teams = set(load_teams())
    for f in load_fixtures()["group_stage"]:
        assert f["home"] in teams and f["away"] in teams, f"unknown code in match {f['match_no']}"


# ------------------------------- squad data ------------------------------- #
def test_squads_well_formed():
    squads = load_squads()
    teams = load_teams()
    assert set(squads) == set(teams), "every team must have a squad"
    valid_pos = {"GK", "DEF", "MID", "FWD"}
    for code, players in squads.items():
        assert len(players) == 26, f"{code}: {len(players)} players"
        ids = [p.id for p in players]
        assert len(ids) == len(set(ids)), f"{code}: duplicate player ids"
        assert sum(1 for p in players if p.position == "GK") >= 2, f"{code}: <2 GK"
        for p in players:
            assert p.position in valid_pos, f"{code}: bad position {p.position}"
            assert 1 <= p.rating <= 99, f"{code}/{p.name}: rating {p.rating}"


def test_suggested_xi_resolves_to_real_players():
    from app.engine.squad import best_xi
    squads = load_squads()
    for code, players in squads.items():
        ids = {p.id for p in players}
        xi = best_xi(players)
        assert len(xi) == 11, f"{code}: best XI has {len(xi)}"
        assert all(p.id in ids for p in xi), f"{code}: best XI references unknown id"
