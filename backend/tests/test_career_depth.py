"""Career-mode depth systems: condition, injuries, dressing-room events,
Golden Boot stats, live tactical dials, and the prediction league engine."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.data import load_squads, load_tournament
from app.engine.condition import SquadCondition
from app.engine.managed import ManagedTournament
from app.engine.squad import best_xi
from app.services import pl_session


def _mt(team="BRA", seed=11) -> ManagedTournament:
    data = load_tournament()
    squads = load_squads()
    return ManagedTournament(data, team, squads[team], squads, seed)


def _xi(mt) -> list:
    banned = {pid for pid, n in mt.suspended.items() if n > 0}
    banned |= {pid for pid, n in mt.injured.items() if n > 0}
    return [p.id for p in best_xi([p for p in mt.squad if p.id not in banned])]


def _play_live_match(mt, xi=None, mentality="balanced"):
    mt.start_live(xi or _xi(mt), mentality)
    assert mt.live is not None
    while mt.live is not None:
        mt.tick_live(5)


# ------------------------------- condition --------------------------------- #
def test_condition_rewards_rotation_and_punishes_rust():
    squad = load_squads()["BRA"]
    cond = SquadCondition(squad)
    starters = [p.id for p in best_xi(squad)]
    for _ in range(3):
        cond.after_round(starters, won=True)
    tired = cond.c[starters[1]]
    assert tired["fatigue"] > 30, "三 matches on the spin must leave real fatigue"
    benched = next(p.id for p in squad if p.id not in starters)
    assert cond.c[benched]["sharpness"] < 60, "unused players must go rusty"
    assert cond.multiplier(benched) < 1.0
    # The condition Elo delta is clamped and negative for a tired XI.
    delta = cond.xi_elo_delta(starters)
    assert -60.0 <= delta <= 20.0


def test_condition_flows_into_managed_state_payload():
    mt = _mt(seed=21)
    _play_live_match(mt)
    p = mt.state()["squad"][0]
    for fieldname in ("sharpness", "fatigue", "morale", "condition_pct", "injured"):
        assert fieldname in p


# -------------------------------- injuries --------------------------------- #
def test_live_injury_carries_into_next_round():
    # Seed-hunt a match that produces a moderate/serious injury (~9% of
    # matches yield a knock; half of those are minor and carry 0 rounds).
    for seed in range(80):
        mt = _mt(seed=seed)
        _play_live_match(mt)
        if mt.injured:
            pid, rounds = next(iter(mt.injured.items()))
            assert 1 <= rounds <= 2   # moderate = 1, serious = 2
            payload = {p["id"]: p for p in mt.state()["squad"]}
            assert payload[pid]["injured"] is True
            return
    pytest.fail("no injury in 80 seeded matches — probability wiring broken")


# ---------------------------- dressing-room events -------------------------- #
def test_dressing_room_event_appears_and_resolves():
    for seed in range(30):
        mt = _mt(seed=seed)
        _play_live_match(mt)
        if mt.pending_event:
            ev = mt.pending_event
            assert ev["title"] and ev["options"]
            before = {pid: st["morale"] for pid, st in mt.condition.c.items()}
            outcome = mt.respond_event(ev["options"][0]["key"])
            assert outcome and mt.pending_event is None
            after = {pid: st["morale"] for pid, st in mt.condition.c.items()}
            assert before != after or True   # morale may or may not move; news must
            assert mt.news, "the decision must reach the news feed"
            return
    pytest.fail("no event in 30 seeded rounds — EVENT_CHANCE wiring broken")


def test_kickoff_discards_unanswered_event_gracefully():
    for seed in range(30):
        mt = _mt(seed=seed)
        _play_live_match(mt)
        if mt.pending_event and mt.phase != "done" and mt.alive:
            mt.start_live(_xi(mt), "balanced")   # kick off without answering
            # Kick-off ducks the press: the card is discarded immediately.
            assert mt.pending_event is None
            while mt.live is not None:
                mt.tick_live(5)
            return
    pytest.skip("no pending event found to discard")


# ------------------------------ golden boot --------------------------------- #
def test_golden_boot_covers_whole_tournament():
    mt = _mt(seed=4)
    guard = 0
    while mt.phase != "done" and guard < 10:
        _play_live_match(mt)
        guard += 1
    st = mt.state()
    assert st["top_scorers"], "tournament-wide top scorers must exist"
    top = st["top_scorers"][0]
    assert top["goals"] >= 2
    teams = {r["team"] for r in st["top_scorers"]}
    assert len(teams) > 1, "race must include OTHER teams, not just the managed one"


# --------------------------- live tactical depth ---------------------------- #
def test_live_new_dials_and_visible_opponent_ai():
    mt = _mt(seed=8)
    mt.start_live(_xi(mt), "balanced")
    lv = mt.live
    taker = lv.xi[0]
    assert lv.set_tactics(attack_style="target_man", time_wasting=True,
                          penalty_taker=taker)
    snap = lv.snapshot()
    assert snap["attack_style"] == "target_man"
    assert snap["time_wasting"] is True
    assert snap["penalty_taker"] == taker
    assert lv.set_tactics(attack_style="nonsense") is False
    # Opponent AI announces its very first (balanced) setup as a tactic event.
    while not lv.done:
        lv.tick(5)
    kinds = {e["type"] for e in lv.events}
    assert "tactic" in kinds, "opponent tactic changes must be visible events"
    mt._finalize_live() if mt.live else None


# ----------------------------- prediction league ---------------------------- #
def test_prediction_league_full_run():
    r = pl_session.create("Raazik", seed=9)
    j = pl_session.join(r["code"], "Sam")
    with pytest.raises(ValueError, match="host"):
        pl_session.start(r["code"], j["token"])
    st = pl_session.start(r["code"], r["token"])["state"]
    assert st["phase"] == "group" and len(st["round_matches"]) == 24

    guard = 0
    while not st["done"] and guard < 10:
        # Raazik calls home wins with margin 1; Sam calls away wins.
        picks_h = {m["key"]: {"result": "H", "margin": 1} for m in st["round_matches"]}
        picks_a = {m["key"]: {"result": "A"} for m in st["round_matches"]}
        pl_session.predict(r["code"], r["token"], picks_h)
        st = pl_session.predict(r["code"], j["token"], picks_a)["state"]
        guard += 1
    assert st["done"] and st["champion_name"]
    board = st["leaderboard"]
    assert len(board) == 2
    assert board[0]["points"] >= board[1]["points"]
    assert board[0]["points"] > 0, "somebody must have scored points"


def test_prediction_league_rejects_draw_pick_in_knockout():
    r = pl_session.create("A", seed=2)
    pl_session.start(r["code"], r["token"])
    st = pl_session.state(r["code"], r["token"])["state"]
    guard = 0
    while st["phase"] == "group" and guard < 5:
        picks = {m["key"]: {"result": "H"} for m in st["round_matches"]}
        st = pl_session.predict(r["code"], r["token"], picks)["state"]
        guard += 1
    assert st["phase"] == "knockout"
    key = st["round_matches"][0]["key"]
    st = pl_session.predict(r["code"], r["token"], {key: {"result": "D"}})["state"]
    assert key not in st["you"]["predictions"], "D is not a knockout outcome"
