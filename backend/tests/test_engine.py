"""Core engine invariants — guard against regressions in the model."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.data import load_squads, load_tournament
from app.engine.match import TeamStrength, predict, simulate
from app.engine.simulator import monte_carlo, simulate_once
from app.engine.squad import best_xi, generate_squad, lineup_delta


def test_match_probabilities_sum_to_one():
    a = TeamStrength("A", 1800)
    b = TeamStrength("B", 1600)
    p = predict(a, b)
    assert abs(p["home_win"] + p["draw"] + p["away_win"] - 1.0) < 1e-6


def test_stronger_team_favoured():
    strong = TeamStrength("S", 2100)
    weak = TeamStrength("W", 1450)
    p = predict(strong, weak)
    assert p["home_win"] > p["away_win"]
    assert p["home_win"] > 0.6  # clear favourite


def test_knockout_always_resolves():
    rng = np.random.default_rng(0)
    a = TeamStrength("A", 1700)
    b = TeamStrength("B", 1700)  # evenly matched -> draws common
    for _ in range(200):
        res = simulate(a, b, rng, knockout=True)
        assert res.winner in ("home", "away")  # never None in a knockout


def test_full_tournament_produces_champion():
    data = load_tournament()
    rng = np.random.default_rng(7)
    res = simulate_once(data, rng)
    assert res["champion"] in data.teams
    assert res["runner_up"] in data.teams
    assert res["champion"] != res["runner_up"]
    # 12 groups each fully played (6 matches).
    assert len(res["group_matches"]) == 72
    # 32 knockout matches (R32..F + 3rd place).
    assert len(res["knockout"]) == 32


def test_monte_carlo_probabilities_bounded():
    data = load_tournament()
    mc = monte_carlo(data, n=300, seed=1)
    assert len(mc["teams"]) == 48
    total_title = sum(t["p_title"] for t in mc["teams"])
    assert 0.95 < total_title < 1.05  # exactly one champion per sim
    for t in mc["teams"]:
        # Reaching a later round implies reaching earlier ones.
        assert t["p_round_of_16"] <= t["p_round_of_32"] + 1e-9
        assert t["p_final"] <= t["p_semi"] + 1e-9
        assert t["p_title"] <= t["p_final"] + 1e-9


def test_lineup_delta_monotonic():
    """A weaker XI must never score better than the optimal XI."""
    squad = generate_squad("TST", 1800)
    best = best_xi(squad, "4-3-3")
    best_delta = lineup_delta(squad, [p.id for p in best])
    assert best_delta["valid"]
    assert best_delta["elo_delta"] <= 0.5  # optimum ~ 0

    # Deliberately weak: worst valid 4-3-3.
    by_pos = {pos: sorted([p for p in squad if p.position == pos], key=lambda p: p.rating)
              for pos in ("GK", "DEF", "MID", "FWD")}
    weak = (by_pos["GK"][:1] + by_pos["DEF"][:4] + by_pos["MID"][:3] + by_pos["FWD"][:3])
    weak_delta = lineup_delta(squad, [p.id for p in weak])
    assert weak_delta["valid"]
    assert weak_delta["elo_delta"] < best_delta["elo_delta"]


def test_invalid_xi_rejected():
    squad = generate_squad("TST", 1700)
    bad = lineup_delta(squad, [p.id for p in squad[:5]])  # only 5 players
    assert not bad["valid"]


def test_real_squads_loaded():
    squads = load_squads()
    assert len(squads) == 48
    for code, players in squads.items():
        assert len(players) == 26, f"{code} has {len(players)} players"
        assert sum(1 for p in players if p.position == "GK") >= 2


def test_player_stats_present():
    squads = load_squads()
    p = squads["ARG"][0]
    assert p.age and p.caps >= 0 and p.market_value >= 0
    # No negative-base complex values leaked through.
    assert isinstance(p.market_value, float)


def test_awards_attribution():
    from app.engine.playerstats import attribute
    from app.services.simulation import simulate_full

    res = simulate_full(seed=11)
    awards = res["awards"]
    # Total goals attributed to players == total goals scored in the sim.
    sim_goals = sum(m["home_goals"] + m["away_goals"] for m in res["group_matches"])
    sim_goals += sum((m["home_goals"] or 0) + (m["away_goals"] or 0)
                     for m in res["knockout"] if m["home_goals"] is not None)
    # Golden boot leader should have scored at least one goal.
    assert awards["golden_boot"][0]["goals"] >= 1
    # Clean-sheet and saves leaders are goalkeepers.
    if awards["clean_sheets"]:
        assert awards["clean_sheets"][0]["position"] == "GK"
    if awards["most_saves"]:
        assert awards["most_saves"][0]["position"] == "GK"
    # Every leaderboard has rows.
    for key in ("golden_boot", "top_assists", "golden_ball", "chances_created"):
        assert len(awards[key]) > 0
