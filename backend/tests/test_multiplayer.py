"""Multiplayer rooms: lobby rules, round flow, human-vs-human, full tournament,
draft lobby, deadlines, chat, spectator predictions and live H2H grudge matches.

Drives the real service layer (mp_session) end to end with two managers in
group A (MEX + KOR) — same group, so they are guaranteed to meet and the
head-to-head paths are always exercised.
"""
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.data import load_squads
from app.engine.squad import best_xi
from app.services import mp_session


def _xi(team: str) -> list:
    return [p.id for p in best_xi(load_squads()[team])]


def _xi_avoiding(team: str, squad_payload: list) -> list:
    """Best XI that respects suspensions + injuries (mirrors the frontend)."""
    banned = {p["id"] for p in squad_payload if p["suspended"] or p.get("injured")}
    players = [p for p in load_squads()[team] if p.id not in banned]
    return [p.id for p in best_xi(players)]


@pytest.fixture()
def room():
    """Instant-sim room (live H2H off) for fast full-tournament tests."""
    r = mp_session.create("Raazik", "MEX", seed=42, live_h2h=False)
    j = mp_session.join(r["code"], "Sam", "KOR")
    return {"code": r["code"], "host": r["token"], "guest": j["token"]}


@pytest.fixture()
def live_room():
    """Live-H2H room: the MEX-KOR group meeting holds the round."""
    r = mp_session.create("Raazik", "MEX", seed=42, live_h2h=True)
    j = mp_session.join(r["code"], "Sam", "KOR")
    return {"code": r["code"], "host": r["token"], "guest": j["token"]}


# --------------------------------- lobby ---------------------------------- #
def test_create_returns_code_token_and_lobby_state():
    r = mp_session.create("Raazik", "MEX", seed=1)
    assert len(r["code"]) == 5 and r["token"]
    st = r["state"]
    assert st["phase"] == "lobby"
    assert st["you"]["team"] == "MEX" and st["you"]["host"] is True


def test_join_rejects_taken_team_and_taken_name(room):
    with pytest.raises(ValueError, match="already managed"):
        mp_session.join(room["code"], "Third", "MEX")
    with pytest.raises(ValueError, match="taken"):
        mp_session.join(room["code"], "Raazik", "BRA")


def test_only_host_can_start_and_lobby_locks(room):
    with pytest.raises(ValueError, match="host"):
        mp_session.start(room["code"], room["guest"])
    st = mp_session.start(room["code"], room["host"])["state"]
    assert st["phase"] == "group" and st["matchday"] == 1
    with pytest.raises(ValueError, match="kicked off"):
        mp_session.join(room["code"], "Late", "BRA")


# ------------------------------- round flow -------------------------------- #
def test_round_waits_for_all_lineups_then_plays(room):
    mp_session.start(room["code"], room["host"])
    st = mp_session.submit(room["code"], room["host"], _xi("MEX"))["state"]
    assert st["matchday"] == 1 and st["you"]["submitted"] is True
    assert st["waiting_on"] == ["Sam"]
    st = mp_session.submit(room["code"], room["guest"], _xi("KOR"))["state"]
    assert st["matchday"] == 2 and st["round_no"] == 1
    assert len(st["you"]["form"]) == 1


def test_submit_rejects_injured_players(room):
    mp_session.start(room["code"], room["host"])
    r = mp_session.get_room(room["code"])
    xi = _xi("MEX")
    r.injured["MEX"][xi[5]] = 1
    with pytest.raises(ValueError, match="Injured"):
        mp_session.submit(room["code"], room["host"], xi)


# --------------------------- full tournament ------------------------------- #
def _play_until_done(code, tokens, max_rounds=10):
    for _ in range(max_rounds):
        states = {t: mp_session.state(code, t)["state"] for t in tokens}
        if all(s["done"] for s in states.values()):
            return states
        progressed = False
        for t, s in states.items():
            if s["you"]["needs_lineup"]:
                xi = _xi_avoiding(s["you"]["team"], s["you"]["squad"])
                mp_session.submit(code, t, xi, "balanced")
                progressed = True
        assert progressed, "Deadlock: nobody needs a lineup"
    return {t: mp_session.state(code, t)["state"] for t in tokens}


def test_full_tournament_two_humans_same_group(room):
    mp_session.start(room["code"], room["host"])
    states = _play_until_done(room["code"], [room["host"], room["guest"]])
    st = states[room["host"]]
    assert st["done"] and st["champion"] in st["team_names"]
    assert any({m["home"], m["away"]} == {"MEX", "KOR"} for m in st["h2h"])
    assert len(st["group_table"]) == 4
    assert all(r["played"] == 3 for r in st["group_table"])
    assert st["bracket"] and st["bracket"][0]["round"] == "F"
    # Golden Boot covers the whole tournament (AI matches included).
    assert st["top_scorers"], "top scorers must be populated"
    assert st["top_scorers"][0]["goals"] >= 2
    # Condition payload present on squad players.
    p0 = st["you"]["squad"][0]
    assert "sharpness" in p0 and "fatigue" in p0 and "condition_pct" in p0


def test_full_tournament_is_seed_deterministic():
    def run(seed):
        r = mp_session.create("A", "BRA", seed=seed, live_h2h=False)
        j = mp_session.join(r["code"], "B", "GER")
        mp_session.start(r["code"], r["token"])
        states = _play_until_done(r["code"], [r["token"], j["token"]])
        return states[r["token"]]["champion"]
    assert run(7) == run(7)


# --------------------------------- draft ----------------------------------- #
def test_draft_room_assigns_teams_in_order():
    r = mp_session.create("A", None, seed=3, draft=True, live_h2h=False)
    j = mp_session.join(r["code"], "B", None)
    st = mp_session.start(r["code"], r["token"])["state"]
    assert st["phase"] == "draft" and st["draft"]["active"]
    order = st["draft"]["order"]
    assert set(order) == {"A", "B"}
    tok = {"A": r["token"], "B": j["token"]}
    first, second = tok[order[0]], tok[order[1]]
    with pytest.raises(ValueError, match="pick"):
        mp_session.draft_pick(r["code"], second, "BRA")
    mp_session.draft_pick(r["code"], first, "BRA")
    with pytest.raises(ValueError, match="drafted"):
        mp_session.draft_pick(r["code"], second, "BRA")
    st = mp_session.draft_pick(r["code"], second, "ARG")["state"]
    assert st["phase"] == "group"
    teams = {p["name"]: p["team"] for p in st["players"]}
    assert set(teams.values()) == {"BRA", "ARG"}


# ------------------------------- deadlines --------------------------------- #
def test_deadline_auto_picks_for_no_shows():
    r = mp_session.create("A", "BRA", seed=5, deadline_minutes=1, live_h2h=False)
    j = mp_session.join(r["code"], "B", "GER")
    mp_session.start(r["code"], r["token"])
    mp_session.submit(r["code"], r["token"], _xi("BRA"))
    room = mp_session.get_room(r["code"])
    room.round_deadline = time.time() - 1          # force the deadline past
    st = mp_session.state(r["code"], j["token"])["state"]
    assert st["matchday"] == 2, "round must auto-advance after the deadline"
    assert any("auto-picked" in m["text"] for m in st["chat"])


# ---------------------------------- chat ------------------------------------ #
def test_chat_round_trip(room):
    st = mp_session.chat(room["code"], room["host"], "Bring your boots, Sam.")["state"]
    assert any(m["text"] == "Bring your boots, Sam." and m["name"] == "Raazik"
               for m in st["chat"])
    with pytest.raises(ValueError):
        mp_session.chat(room["code"], room["host"], "   ")


# ---------------------------- spectator predictions ------------------------- #
def test_predictions_score_points(room):
    mp_session.start(room["code"], room["host"])
    st = mp_session.state(room["code"], room["host"])["state"]
    # Host predicts HOME for every match he's not in.
    picks = {m["key"]: "H" for m in st["predictable"]}
    assert picks and all("MEX" not in (m["home"], m["away"]) for m in st["predictable"])
    mp_session.predict(room["code"], room["host"], picks)
    mp_session.submit(room["code"], room["host"], _xi("MEX"))
    mp_session.submit(room["code"], room["guest"], _xi("KOR"))
    home_wins = sum(1 for md in mp_session.get_room(room["code"]).last_round_results
                    if md["winner"] == md["home"] and md["round"] == "groups"
                    and "MEX" not in (md["home"], md["away"]))
    st = mp_session.state(room["code"], room["host"])["state"]
    you = next(p for p in st["players"] if p["is_you"])
    assert you["pred_points"] == home_wins
    assert home_wins > 0, "a 23-match matchday with zero home wins is implausible"


# ------------------------------ live H2H ----------------------------------- #
def test_grudge_match_holds_round_and_plays_live(live_room):
    code = live_room["code"]
    mp_session.start(code, live_room["host"])
    room = mp_session.get_room(code)
    # Advance matchdays until MEX meets KOR (round robin guarantees it).
    for _ in range(3):
        for tok in (live_room["host"], live_room["guest"]):
            s = mp_session.state(code, tok)["state"]
            if s["you"]["needs_lineup"]:
                mp_session.submit(code, tok, _xi_avoiding(s["you"]["team"], s["you"]["squad"]))
        s = mp_session.state(code, live_room["host"])["state"]
        if s["awaiting_live"]:
            break
    assert s["awaiting_live"], "MEX vs KOR must hold the round for live play"
    assert len(s["live_h2h"]) == 1
    lv = s["live_h2h"][0]
    assert {lv["home"], lv["away"]} == {"MEX", "KOR"}
    assert lv["your_side"] in ("home", "away")
    # Submissions are rejected while the match is live.
    with pytest.raises(ValueError, match="live"):
        mp_session.submit(code, live_room["host"], _xi("MEX"))

    key = lv["key"]
    entry = room.live_entry(key)
    lm = entry["match"]
    # Both managers manage mid-match: tactics + a sub after the hour.
    side = lv["your_side"]
    lm.set_tactics(side, mentality="attacking", pressing="high")
    while not lm.done:
        lm.tick(5)
        if lm.break_flag:
            lm.set_ready("home")
            lm.set_ready("away")
    room.finalize_live_match(key)

    s = mp_session.state(code, live_room["host"])["state"]
    assert not s["awaiting_live"]
    grudge = next(m for m in s["h2h"] if {m["home"], m["away"]} == {"MEX", "KOR"})
    assert grudge.get("was_live") is True
    assert grudge["home_manager"] and grudge["away_manager"]
    # The round completed: every group has moved on together.
    assert all(r["played"] == s["round_no"] or s["phase"] != "group"
               for r in s["group_table"])


def test_stale_live_match_auto_resolves(live_room):
    code = live_room["code"]
    mp_session.start(code, live_room["host"])
    room = mp_session.get_room(code)
    for _ in range(3):
        for tok in (live_room["host"], live_room["guest"]):
            s = mp_session.state(code, tok)["state"]
            if s["you"]["needs_lineup"]:
                mp_session.submit(code, tok, _xi_avoiding(s["you"]["team"], s["you"]["squad"]))
        if mp_session.state(code, live_room["host"])["state"]["awaiting_live"]:
            break
    # Nobody ever connects: backdate creation past the stale window.
    for entry in room.live_matches.values():
        entry["created"] -= 1000
    s = mp_session.state(code, live_room["host"])["state"]
    assert not s["awaiting_live"], "stale live match must auto-resolve on poll"
