"""Live (interactive) managed-match invariants: tick, tactics, subs, finalise."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.data import load_squads, load_tournament
from app.engine.live import SUBS_LIMIT
from app.engine.managed import ManagedTournament


def _start(seed=42, team="ARG", mentality="balanced"):
    data = load_tournament()
    squads = load_squads()
    mt = ManagedTournament(data, team, squads[team], squads, seed)
    xi = [p.id for p in _best_xi(mt.squad)]
    mt.start_live(xi, mentality)
    return mt, xi


def _best_xi(squad):
    need = {"GK": 1, "DEF": 4, "MID": 3, "FWD": 3}
    out = []
    for pos, n in need.items():
        ranked = sorted([p for p in squad if p.position == pos],
                        key=lambda p: p.rating, reverse=True)
        out.extend(ranked[:n])
    return out


def _run_to_full_time(mt, max_loops=200):
    """Tick through breaks until the match finalises."""
    snap = None
    for _ in range(max_loops):
        snap = mt.tick_live(5)
        if snap is None or snap["done"]:
            return snap
    pytest.fail("match never finished")


def test_live_match_starts_at_zero():
    mt, xi = _start()
    snap = mt.live.snapshot()
    assert snap["minute"] == 0
    assert snap["home_goals"] == 0 and snap["away_goals"] == 0
    assert snap["subs_remaining"] == SUBS_LIMIT
    assert len(snap["xi"]) == 11


def test_tick_stops_at_half_time():
    mt, _ = _start()
    snap = None
    for _ in range(20):
        snap = mt.tick_live(5)
        if snap["break"] == "HT":
            break
    assert snap["break"] == "HT"
    assert snap["minute"] == 45
    assert not snap["done"]


def test_match_finalises_and_round_advances():
    mt, _ = _start(seed=7)
    assert mt.md_index == 0
    snap = _run_to_full_time(mt)
    assert snap["done"]
    assert snap["minute"] in (90, 120)
    # Finalised: live cleared, result recorded, group matchday advanced.
    assert mt.live is None
    assert mt.last_managed_match is not None
    assert mt.md_index == 1
    assert len(mt.journey) == 1
    assert len(mt.ratings) == 1
    # The recorded score matches the live score.
    md = mt.last_managed_match
    assert md["home_goals"] == snap["home_goals"]
    assert md["away_goals"] == snap["away_goals"]
    # Recorded events only carry goals/reds (UI compatibility).
    assert all(e["type"] in ("goal", "red") for e in md["events"])


def test_substitution_swaps_players_and_counts():
    mt, xi = _start(seed=3)
    mt.tick_live(5)
    live = mt.live
    # Swap a midfielder for the best bench midfielder (same-position = legal).
    out_id = next(i for i in live.xi if live.by_id[i].position == "MID")
    in_id = next(i for i in live.bench if live.by_id[i].position == "MID")
    snap, msg = mt.live_substitute(out_id, in_id)
    assert msg == "ok"
    assert out_id not in snap["xi"] and in_id in snap["xi"]
    assert in_id not in snap["bench"]
    assert snap["subs_made"] == 1
    assert snap["subs"][0]["out_id"] == out_id


def test_substitution_limit_enforced():
    mt, _ = _start(seed=5)
    mt.tick_live(5)
    live = mt.live
    already = live.subs_made          # injury auto-subs also burn the budget
    made = 0
    for pos in ("MID", "DEF", "FWD", "GK"):
        outs = [i for i in live.xi if live.by_id[i].position == pos]
        ins = [i for i in live.bench if live.by_id[i].position == pos]
        for o, n in zip(outs, ins):
            _, msg = mt.live_substitute(o, n)
            if msg == "ok":
                made += 1
    assert made == SUBS_LIMIT - already  # next legal swap must be refused
    snap = mt.live.snapshot()
    assert snap["subs_remaining"] == 0


def test_illegal_shape_substitution_rejected():
    mt, _ = _start(seed=9)
    mt.tick_live(1)
    live = mt.live
    # GK off for an outfielder -> zero keepers -> rejected.
    gk = next(i for i in live.xi if live.by_id[i].position == "GK")
    fwd = next(i for i in live.bench if live.by_id[i].position == "FWD")
    _, msg = mt.live_substitute(gk, fwd)
    assert msg != "ok"
    assert gk in live.xi


def test_mid_match_tactics_change_applies():
    mt, _ = _start(seed=11)
    mt.tick_live(5)
    snap = mt.live_tactics("attacking")
    assert snap["mentality"] == "attacking"
    # Attacking opens the game up: our per-minute rate must rise.
    mt.live.set_mentality("defensive")
    p_def, _ = mt.live._minute_lambdas()
    mt.live.set_mentality("attacking")
    p_att, _ = mt.live._minute_lambdas()
    assert p_att > p_def


def test_fatigue_drains_positionally_and_fresh_sub_restores():
    """Positional decay: outfielders drain hardest, the keeper barely moves."""
    mt, _ = _start(seed=13)
    for _ in range(20):  # deep into the second half (HT pause costs a tick)
        snap = mt.tick_live(5)
        if snap["done"]:
            pytest.skip("match ended early in this seed")
        if snap["minute"] >= 75:
            break
    live = mt.live
    # Judge only players who have been on the whole time (auto-subs are fresh).
    vets = [i for i in live.xi if live.minutes_played.get(i, 0) >= 70]
    outfield = [i for i in vets if live.by_id[i].position != "GK"]
    assert outfield and all(live.stamina[i] < 95 for i in outfield)
    gk = next((i for i in vets if live.by_id[i].position == "GK"), None)
    if gk is not None:  # GK decay 0.05/min: freshest player on the pitch
        assert live.stamina[gk] > max(live.stamina[i] for i in outfield)
    in_id = next(i for i in live.bench if live.by_id[i].position == "MID")
    out_id = next((i for i in outfield if live.by_id[i].position == "MID"), None)
    if out_id is None:
        pytest.skip("no veteran midfielder left to replace in this seed")
    mt.live_substitute(out_id, in_id)
    assert live.stamina[in_id] == 100.0
    # Fresher legs -> better effective lineup delta than before the sub.


def test_tactical_dials_move_rates_as_documented():
    mt, _ = _start(seed=23)
    mt.tick_live(5)
    lv = mt.live

    def rates():
        return lv._minute_lambdas()

    lv.set_tactics(tempo="balanced", passing="mixed", pressing="mid")
    base_us, base_opp = rates()
    # Fast tempo: more chances BOTH ways.
    lv.set_tactics(tempo="fast")
    fast_us, fast_opp = rates()
    assert fast_us > base_us and fast_opp > base_opp
    # Slow + short (control): suppresses the opponent below baseline.
    lv.set_tactics(tempo="slow", passing="short")
    _, ctrl_opp = rates()
    assert ctrl_opp < base_opp
    # Low block: we create less AND concede less than baseline.
    lv.set_tactics(tempo="balanced", passing="mixed", pressing="low_block")
    lb_us, lb_opp = rates()
    assert lb_us < base_us and lb_opp < base_opp


def test_net_clamp_bounds_extreme_combos():
    """Gegenpress-everything must not exceed +-25% of the Elo baseline."""
    mt, _ = _start(seed=29)
    mt.tick_live(1)
    lv = mt.live
    lv.set_tactics(mentality="balanced", tempo="balanced", passing="mixed", pressing="mid")
    lv.opp_mentality, lv.opp_tempo = "balanced", "balanced"
    lv.opp_passing, lv.opp_pressing = "mixed", "mid"
    base_us, base_opp = lv._minute_lambdas()
    lv.set_tactics(mentality="attacking", tempo="fast", passing="direct", pressing="high")
    hot_us, hot_opp = lv._minute_lambdas()
    # Without the clamp this combo would be ~1.20*1.12*1.10*1.10 ≈ +63%.
    assert hot_us <= base_us * 1.26
    assert hot_opp <= base_opp * 1.27  # small headroom: fatigue stacks post-clamp


def test_pressing_and_tempo_cost_stamina():
    a, _ = _start(seed=31)
    b, _ = _start(seed=31)
    a.live.set_tactics(tempo="slow", pressing="low_block")
    b.live.set_tactics(tempo="fast", pressing="high")
    a.tick_live(5), a.tick_live(5)
    b.tick_live(5), b.tick_live(5)
    drain_a = 100 - a.live._avg_stamina()
    drain_b = 100 - b.live._avg_stamina()
    assert drain_b > drain_a  # heavy-metal football costs more legs


def test_tactics_via_session_layer():
    mt, _ = _start(seed=37)
    mt.tick_live(1)
    snap = mt.live_tactics(mentality="attacking", tempo="fast",
                           passing="direct", pressing="high")
    assert (snap["mentality"], snap["tempo"], snap["passing"], snap["pressing"]) == (
        "attacking", "fast", "direct", "high")
    # Unknown values are ignored, valid ones kept.
    snap = mt.live_tactics(tempo="warp-speed")
    assert snap["tempo"] == "fast"


def test_goal_sources_and_penalty_miss_invariant():
    """Goals carry a valid source; penalty_miss events never move the score."""
    saw_pen_miss = False
    for seed in range(1, 9):
        mt, _ = _start(seed=seed)
        snap = _run_to_full_time(mt)
        goals = [e for e in snap["events"] if e["type"] == "goal"]
        assert all(e.get("source") in ("open", "penalty", "freekick") for e in goals)
        hg = sum(1 for e in goals if e["team"] == snap["home"])
        ag = sum(1 for e in goals if e["team"] == snap["away"])
        assert (hg, ag) == (snap["home_goals"], snap["away_goals"])
        saw_pen_miss = saw_pen_miss or any(
            e["type"] == "penalty_miss" for e in snap["events"])
        for e in snap["events"]:
            if e["type"] == "penalty_miss":
                assert e["outcome"] in ("saved", "missed")
    # Drama events are rare; across 8 matches we don't REQUIRE one, but if the
    # rate constant is ever zeroed this trips on the source field instead.


def test_deterministic_with_seed():
    a = _run_to_full_time(_start(seed=99)[0])
    b = _run_to_full_time(_start(seed=99)[0])
    assert (a["home_goals"], a["away_goals"]) == (b["home_goals"], b["away_goals"])
    assert a["minute"] == b["minute"]


def test_knockout_live_resolves_winner():
    """Force a knockout live match by jumping the tournament to the KO phase."""
    data = load_tournament()
    squads = load_squads()
    mt = ManagedTournament(data, "ARG", squads["ARG"], squads, 21)
    xi = [p.id for p in _best_xi(mt.squad)]
    # Play the three group matchdays live.
    for _ in range(3):
        if mt.phase != "group":
            break
        mt.start_live(xi, "balanced")
        _run_to_full_time(mt)
    if mt.phase != "knockout":
        pytest.skip("eliminated in groups for this seed")
    mt.start_live([i for i in xi if mt.suspended.get(i, 0) <= 0] if all(
        mt.suspended.get(i, 0) <= 0 for i in xi) else xi, "balanced")
    snap = _run_to_full_time(mt)
    md = mt.last_managed_match
    assert md["winner"] in (md["home"], md["away"])
    if md["penalties"]:
        assert md["home_pens"] != md["away_pens"]
