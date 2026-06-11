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
    made = 0
    for pos in ("MID", "DEF", "FWD", "GK"):
        outs = [i for i in live.xi if live.by_id[i].position == pos]
        ins = [i for i in live.bench if live.by_id[i].position == pos]
        for o, n in zip(outs, ins):
            _, msg = mt.live_substitute(o, n)
            if msg == "ok":
                made += 1
    assert made == SUBS_LIMIT  # 6th legal swap must have been refused
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


def test_fatigue_drains_and_fresh_sub_restores():
    mt, _ = _start(seed=13)
    for _ in range(12):  # past half-time, deep into the second half
        snap = mt.tick_live(5)
        if snap["done"]:
            pytest.skip("match ended early in this seed")
        if snap["minute"] >= 75:
            break
    live = mt.live
    starters = [i for i in live.xi]
    assert all(live.stamina[i] < 70 for i in starters)
    in_id = next(i for i in live.bench if live.by_id[i].position == "MID")
    out_id = next(i for i in starters if live.by_id[i].position == "MID")
    mt.live_substitute(out_id, in_id)
    assert live.stamina[in_id] == 100.0
    # Fresher legs -> better effective lineup delta than before the sub.


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
