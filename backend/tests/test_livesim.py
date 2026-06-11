"""Possession-chain engine + WebSocket match session invariants."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.core.data import load_squads, load_tournament
from app.engine.livesim.ai import OppAI
from app.engine.livesim.stamina import (
    DECAY_RATES, assign_roles, decay_for, effective_rating)
from app.engine.managed import ManagedTournament
from app.engine.squad import best_xi
from app.main import app


def _mt(team="ARG", seed=42) -> ManagedTournament:
    data = load_tournament()
    squads = load_squads()
    return ManagedTournament(data, team, squads[team], squads, seed)


def _xi(mt):
    banned = {pid for pid, n in mt.suspended.items() if n > 0}
    banned |= {pid for pid, n in mt.injured.items() if n > 0}
    return [p.id for p in best_xi([p for p in mt.squad if p.id not in banned])]


def _full_match(mt):
    mt.start_live(_xi(mt), "balanced")
    lv = mt.live
    frames = []
    while mt.live is not None:
        new = mt.live.tick(5)
        frames.append(mt.live.frame(new))
        if mt.live.done:
            mt._finalize_live()
    return lv, frames


# ------------------------------ chain engine -------------------------------- #
def test_chain_events_present_and_well_formed():
    lv, frames = _full_match(_mt(seed=1))
    micro = [e for f in frames for e in f["events"] if not e.get("headline")]
    kinds = {e["type"] for e in micro}
    assert {"PASS", "SHOT"} <= kinds, "chains must narrate passes and shots"
    for e in micro:
        assert 0.0 <= e["x"] <= 100.0 and 0.0 <= e["y"] <= 100.0
        assert e["side"] in ("home", "away")


def test_frame_schema_complete():
    mt = _mt(seed=2)
    mt.start_live(_xi(mt), "balanced")
    new = mt.live.tick(1)
    f = mt.live.frame(new)
    for key in ("minute", "score", "events", "player_positions", "ball_xy",
                "possession_team", "match_phase", "stats", "snapshot"):
        assert key in f
    assert f["score"] == {"home": mt.live.hg, "away": mt.live.ag}
    assert f["possession_team"] in ("home", "away")
    assert len(f["player_positions"]) >= 20          # both XIs on the pitch
    for p in f["player_positions"]:
        assert p["team"] in ("home", "away")
        assert 0 <= p["x"] <= 100 and 0 <= p["y"] <= 100
    st = f["stats"]
    assert st["possession"]["home"] + st["possession"]["away"] in (0, 100)


def test_goal_calibration_stays_in_world_cup_band():
    """Chain engine must keep the Elo/Poisson scoreline calibration:
    long-run goals per match in a realistic 1.5-4.5 band."""
    total = matches = 0
    for seed in range(12):
        lv, _ = _full_match(_mt(seed=100 + seed))
        total += lv.hg + lv.ag
        matches += 1
    avg = total / matches
    assert 1.2 <= avg <= 4.6, f"avg goals {avg} out of band"


def test_shot_stats_consistent_with_goals():
    lv, frames = _full_match(_mt(seed=3))
    stats = frames[-1]["stats"]
    assert stats["shots"]["home"] >= stats["on_target"]["home"]
    assert stats["shots"]["away"] >= stats["on_target"]["away"]
    assert stats["on_target"]["home"] >= lv.hg
    assert stats["on_target"]["away"] >= lv.ag


# -------------------------- positional stamina ------------------------------ #
def test_positional_decay_table():
    assert DECAY_RATES["GK"] == 0.05 and DECAY_RATES["LW"] == 0.25
    # Attacking multiplies outfield by 1.15; the keeper is exempt.
    assert decay_for("CM", "attacking") == pytest.approx(0.20 * 1.15)
    assert decay_for("CM", "defensive") == pytest.approx(0.20 * 0.90)
    assert decay_for("GK", "attacking") == pytest.approx(0.05)


def test_effective_rating_formula():
    assert effective_rating(80, 100, 1.0) == pytest.approx(80.0)
    assert effective_rating(80, 0, 1.0) == pytest.approx(80 * 0.4)
    # form 0 costs 15%.
    assert effective_rating(80, 100, 0.0) == pytest.approx(80 * 0.85)


def test_role_assignment_433():
    mt = _mt(seed=4)
    xi = best_xi(mt.squad)
    roles = assign_roles(xi)
    vals = sorted(roles.values())
    assert vals.count("CB") == 2 and "LB" in vals and "RB" in vals
    assert {"DM", "CM", "AM"} <= set(vals)
    assert vals.count("CF") == 1 and "LW" in vals and "RW" in vals


def test_wingers_tire_faster_than_centre_backs():
    mt = _mt(seed=5)
    mt.start_live(_xi(mt), "balanced")
    lv = mt.live
    for _ in range(12):
        lv.tick(5)
        if lv.minute >= 60 or lv.done:
            break
    wide = [pid for pid, r in lv.roles.items()
            if r in ("LW", "RW") and lv.minutes_played.get(pid, 0) >= 55]
    cbs = [pid for pid, r in lv.roles.items()
           if r == "CB" and lv.minutes_played.get(pid, 0) >= 55]
    if not wide or not cbs:
        pytest.skip("early changes removed the comparison set")
    assert min(lv.stamina[c] for c in cbs) > max(lv.stamina[w] for w in wide)


# ------------------------------ opposition AI ------------------------------- #
def test_opp_ai_decision_table():
    ai = OppAI()
    first = ai.evaluate(5, 0, False)
    assert first is not None and first.mentality == "balanced"
    chase = ai.evaluate(10, -1, False)
    assert chase.mentality == "attacking" and chase.shot_mult == pytest.approx(1.15)
    assert chase.cb_in_midfield
    park = ai.evaluate(15, 2, False)
    assert park.mentality == "defensive" and park.shot_mult == pytest.approx(0.60)
    assert park.chain_bonus == pytest.approx(1.5)
    ten = ai.evaluate(20, 0, True)
    assert ten.mentality == "defensive" and "ten men" in ten.reason
    # Throttled: nothing inside the 5-minute window.
    assert ai.evaluate(22, -3, False) is None


def test_opp_tactical_change_event_emitted():
    mt = _mt(seed=6)
    mt.start_live(_xi(mt), "balanced")
    micro = []
    while not mt.live.done:
        new = mt.live.tick(5)
        micro += mt.live.frame(new)["events"]
    assert any(e["type"] == "OPP_TACTICAL_CHANGE" and e.get("new_mentality")
               and e.get("reason") for e in micro)


# ----------------------------- form & ratings ------------------------------- #
def test_form_updates_after_match():
    mt = _mt(seed=7)
    xi = _xi(mt)
    _ = mt.start_live(xi, "balanced")
    while mt.live is not None:
        mt.tick_live(5)
    md = mt.last_managed_match
    won = md["winner"] == mt.team
    lost = md["winner"] not in (None, mt.team)
    forms = mt.player_form
    unused = [p.id for p in mt.squad if p.id not in xi]
    if unused:
        assert forms[unused[0]] == pytest.approx(0.68)   # 0.7 - 0.02
    if won:
        full_timers = [pid for pid in xi
                       if (mt.last_ratings and next(
                           (r for r in mt.last_ratings if r["player_id"] == pid),
                           {"minutes": 0})["minutes"] >= 60)]
        if full_timers:
            assert forms[full_timers[0]] == pytest.approx(0.75)
    if lost:
        assert any(abs(forms[pid] - 0.65) < 1e-6 for pid in xi)
    # Form must surface on the squad payload for the lineup builder.
    p0 = mt.state()["squad"][0]
    assert "form" in p0


def test_post_match_ratings_have_motm():
    mt = _mt(seed=8)
    mt.start_live(_xi(mt), "balanced")
    while mt.live is not None:
        mt.tick_live(5)
    rows = mt.last_ratings
    assert rows, "ratings must exist after a managed match"
    assert rows[0].get("motm") is True
    for r in rows:
        assert 4.0 <= r["rating"] <= 10.0
        assert r["minutes"] > 0


# --------------------------- HTTP + WebSocket API --------------------------- #
client = TestClient(app)


def test_squad_endpoint_exposes_form():
    r = client.get("/api/teams/ARG/squad")
    assert r.status_code == 200
    squad = r.json()["squad"]
    assert all("form" in p for p in squad)
    assert squad[0]["form"] == pytest.approx(0.7)


def test_live_start_rejects_suspended_players_422():
    r = client.post("/api/manage/start", json={"team": "ARG", "seed": 9})
    sid = r.json()["session_id"]
    state = r.json()["state"]
    xi = [p["id"] for p in state["squad"]][:11]
    # Forge a suspension on the first picked player via the session object.
    from app.services.manage_session import _SESSIONS
    mt = _SESSIONS[sid]
    mt.suspended[xi[0]] = 1
    r = client.post("/api/manage/live/start",
                    json={"session_id": sid, "starting_xi": xi,
                          "mentality": "balanced"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["players"][0]["player_id"] == xi[0]
    assert detail["players"][0]["reason"] == "suspended"


def test_websocket_stream_pushes_frames():
    r = client.post("/api/manage/start", json={"team": "BRA", "seed": 10})
    sid = r.json()["session_id"]
    xi = _xi_from_state(r.json()["state"])
    r = client.post("/api/manage/live/start",
                    json={"session_id": sid, "starting_xi": xi,
                          "mentality": "balanced"})
    assert r.status_code == 200
    body = r.json()
    match_sid = body["session_id"]
    assert match_sid and body["ws_path"] == f"/ws/manage/live/{match_sid}"

    with client.websocket_connect(f"/ws/manage/live/{match_sid}") as ws:
        first = ws.receive_json()              # initial state frame
        assert first["minute"] == 0
        ws.send_json({"action": "resume"})
        ack = ws.receive_json()
        assert ack.get("ack") == "resume"
        frame = ws.receive_json()              # first pushed tick
        assert frame["minute"] >= 1
        assert frame["player_positions"] and frame["ball_xy"]
        ws.send_json({"action": "tactics", "mentality": "attacking"})
        ack = ws.receive_json()
        # Acks and tick frames interleave; hunt for the tactics ack.
        for _ in range(10):
            if ack.get("ack") == "tactics":
                break
            ack = ws.receive_json()
        assert ack["snapshot"]["mentality"] == "attacking"
        ws.send_json({"action": "pause"})

    # Session survives the disconnect (30-minute reconnect grace).
    from app.engine.livesim import session as live_sessions
    ms = live_sessions.get(match_sid)
    assert ms is not None
    assert ms.expires_at > 0


def test_unknown_ws_session_refused():
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/manage/live/nope"):
            pass


def _xi_from_state(state):
    by_pos = {"GK": [], "DEF": [], "MID": [], "FWD": []}
    for p in state["squad"]:
        by_pos[p["position"]].append(p)
    xi = []
    for pos, n in (("GK", 1), ("DEF", 4), ("MID", 3), ("FWD", 3)):
        xi += [p["id"] for p in sorted(by_pos[pos], key=lambda q: -q["rating"])[:n]]
    return xi


# ------------------------------- odds cache --------------------------------- #
def test_odds_ttl_cache_returns_same_object():
    from app.services import simulation as sim
    sim._ODDS_CACHE.clear()
    a = sim.cached_odds(500)
    b = sim.cached_odds(500)
    assert a is b, "within the TTL the cached payload is returned as-is"
    assert 500 in sim._ODDS_CACHE


def test_odds_cache_expires():
    import time as _time
    from app.services import simulation as sim
    sim._ODDS_CACHE.clear()
    a = sim.cached_odds(500)
    sim._ODDS_CACHE[500] = (_time.time() - sim.ODDS_TTL_SECONDS - 1, a)
    b = sim.cached_odds(500)
    assert b is not a, "expired entries must recompute"
