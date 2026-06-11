"""Prediction league: friends predict a simulated World Cup, round by round.

Nobody manages a team here — the server simulates the tournament one round
at a time (all 12 groups per matchday, then each knockout round), and the
round only plays once EVERY member has locked in predictions. Scoring:

  * group match:   correct result (H/D/A)        -> 2 pts
  * knockout:      correct winner                -> 2 pts
  * exact margin bonus (you also called the goal difference) -> +1 pt

A private leaderboard, a room code to share, and the same in-memory room
plumbing as multiplayer. The simulation core mirrors `multiplayer.py` with
zero human teams (no lineups, no mentality — pure engine).
"""
from __future__ import annotations

import time
from collections import OrderedDict, defaultdict
from typing import Dict, List, Optional

import numpy as np

from app.engine.managed import KO_LABEL, KO_ROUNDS
from app.engine.match import TeamStrength, simulate
from app.engine.tournament import (
    R32_PAIRINGS,
    KnockoutMatch,
    MOMENTUM_WIN,
    TeamRecord,
    _apply_result_momentum,
    _home_adv,
    _momentum_adv,
    _net_fatigue_adv,
    _resolve_qualifiers,
    _sort_group,
    update_momentum,
)

MAX_MEMBERS = 20
POINTS_RESULT = 2
POINTS_MARGIN_BONUS = 1


class PredictionLeague:
    def __init__(self, code: str, data, seed: Optional[int] = None,
                 deadline_minutes: int = 0):
        self.code = code
        self.data = data
        self.rng = np.random.default_rng(seed)
        self.base_elo = {c: float(t["elo"]) for c, t in data.teams.items()}
        self.names = {c: t["name"] for c, t in data.teams.items()}
        self.phase = "lobby"  # lobby | group | knockout | done
        self.members: "OrderedDict[str, dict]" = OrderedDict()
        self.momentum: Dict[str, float] = {}
        self.last_played: Dict[str, str] = {}

        self.group_members: Dict[str, List[str]] = defaultdict(list)
        for c, t in data.teams.items():
            self.group_members[t["group"]].append(c)
        self.group_records = {c: TeamRecord(c, data.teams[c]["group"]) for c in data.teams}
        self.matchdays: Dict[str, List[List[dict]]] = {}
        for g, fixtures in data.group_fixtures.items():
            gf = sorted(fixtures, key=lambda f: (f.get("date", ""), f.get("match_no", 0)))
            self.matchdays[g] = [gf[0:2], gf[2:4], gf[4:6]]
        self.md_index = 0
        self.round_no = 0
        self.group_tables: Optional[Dict[str, List[TeamRecord]]] = None
        self.ko_round_idx = 0
        self.cur_round: List[KnockoutMatch] = []
        self.champion: Optional[str] = None

        self.round_matches: List[dict] = []
        self.predictions: Dict[str, Dict[str, dict]] = defaultdict(dict)
        self.last_round_results: List[dict] = []
        self.last_round_points: Dict[str, int] = {}
        self.deadline_minutes = max(0, int(deadline_minutes or 0))
        self.round_deadline: Optional[float] = None

    # ------------------------------------------------------------------ lobby
    def join(self, token: str, name: str, host: bool = False) -> None:
        if self.phase != "lobby":
            raise ValueError("This league has already kicked off.")
        if len(self.members) >= MAX_MEMBERS:
            raise ValueError(f"League is full ({MAX_MEMBERS} members max).")
        name = (name or "").strip()[:24] or f"Player {len(self.members) + 1}"
        if any(m["name"].lower() == name.lower() for m in self.members.values()):
            raise ValueError(f"The name “{name}” is taken in this league.")
        self.members[token] = {"token": token, "name": name, "host": host,
                               "points": 0, "exact": 0, "rounds_played": 0}

    def start(self, token: str) -> None:
        m = self._member(token)
        if not m["host"]:
            raise ValueError("Only the host can start the league.")
        if self.phase != "lobby":
            raise ValueError("Already started.")
        self.phase = "group"
        self._open_round()

    def _member(self, token: str) -> dict:
        m = self.members.get(token)
        if m is None:
            raise KeyError("You are not in this league (bad or expired token).")
        return m

    # ------------------------------------------------------------- round flow
    def _matches_this_round(self) -> List[dict]:
        out = []
        if self.phase == "group":
            for g in sorted(self.matchdays):
                for fx in self.matchdays[g][self.md_index]:
                    out.append({"kind": "group", "home": fx["home"], "away": fx["away"],
                                "date": fx.get("date"), "country": fx.get("country", ""),
                                "knockout": False, "label": "groups",
                                "match_no": fx.get("match_no"), "ref": fx,
                                "group": g})
        elif self.phase == "knockout":
            rnd = KO_ROUNDS[self.ko_round_idx]
            for km in self.cur_round:
                out.append({"kind": "ko", "home": km.home, "away": km.away,
                            "date": km.meta.get("date"),
                            "country": km.meta.get("country", ""),
                            "knockout": True, "label": rnd,
                            "match_no": km.match_no, "ref": km})
        return out

    def _open_round(self) -> None:
        stage = (f"Matchday {self.md_index + 1}" if self.phase == "group"
                 else KO_LABEL[KO_ROUNDS[self.ko_round_idx]])
        self.round_matches = [
            {"key": str(m["match_no"]), "home": m["home"], "away": m["away"],
             "stage": stage, "knockout": m["knockout"],
             "group": m.get("group")}
            for m in self._matches_this_round()]
        self.predictions = defaultdict(dict)
        self.round_deadline = (time.time() + self.deadline_minutes * 60
                               if self.deadline_minutes else None)

    def pending_members(self) -> List[str]:
        if self.phase not in ("group", "knockout"):
            return []
        need = len(self.round_matches)
        return [m["name"] for t, m in self.members.items()
                if len(self.predictions.get(t, {})) < need]

    def check_deadline(self) -> None:
        if (self.round_deadline is None or time.time() < self.round_deadline
                or self.phase not in ("group", "knockout")):
            return
        # Deadline passed: whoever has not predicted simply scores nothing.
        if self.pending_members():
            self._play_round()

    def predict(self, token: str, picks: Dict[str, dict]) -> None:
        """picks: match_key -> {"result": "H"/"D"/"A", "margin": int?}"""
        self.check_deadline()
        self._member(token)
        if self.phase not in ("group", "knockout"):
            raise ValueError("Nothing to predict right now.")
        valid = {m["key"]: m for m in self.round_matches}
        for key, pick in picks.items():
            m = valid.get(str(key))
            if m is None or not isinstance(pick, dict):
                continue
            res = pick.get("result")
            allowed = ("H", "A") if m["knockout"] else ("H", "D", "A")
            if res not in allowed:
                continue
            entry = {"result": res}
            margin = pick.get("margin")
            if isinstance(margin, int) and 0 <= margin <= 9:
                entry["margin"] = margin
            self.predictions[token][str(key)] = entry
        if not self.pending_members():
            self._play_round()

    # ------------------------------------------------------------ simulation
    def _sim(self, m: dict) -> dict:
        home, away = m["home"], m["away"]
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        h_adv = (_home_adv(home, away, m["country"])
                 + _net_fatigue_adv(home, away, m["date"], self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        res = simulate(sh, sa, self.rng, home_advantage=h_adv, knockout=m["knockout"])
        winner = None
        if m["knockout"]:
            winner = home if res.winner == "home" else away
            loser = away if winner == home else home
            update_momentum(self.momentum, winner, MOMENTUM_WIN)
            update_momentum(self.momentum, loser, -MOMENTUM_WIN)
            km = m["ref"]
            km.winner_code, km.loser_code = winner, loser
        else:
            if res.home_goals > res.away_goals:
                winner = home
            elif res.away_goals > res.home_goals:
                winner = away
            self.group_records[home].apply(away, res.home_goals, res.away_goals)
            self.group_records[away].apply(home, res.away_goals, res.home_goals)
            _apply_result_momentum(self.momentum, home, away,
                                   res.home_goals, res.away_goals)
        if m["date"]:
            self.last_played[home] = m["date"]
            self.last_played[away] = m["date"]
        return {"round": m["label"], "match_no": m["match_no"],
                "home": home, "away": away,
                "home_goals": res.home_goals, "away_goals": res.away_goals,
                "penalties": res.went_penalties,
                "home_pens": res.home_pens if res.went_penalties else None,
                "away_pens": res.away_pens if res.went_penalties else None,
                "winner": winner, "date": m["date"], "events": []}

    def _play_round(self) -> None:
        results = [self._sim(m) for m in self._matches_this_round()]
        self.last_round_results = results
        self._score_round(results)
        self.round_no += 1
        if self.phase == "group":
            self.md_index += 1
            if self.md_index >= 3:
                self._finish_groups()
        else:
            self._advance_ko()
        if self.phase in ("group", "knockout"):
            self._open_round()

    def _score_round(self, results: List[dict]) -> None:
        outcome: Dict[str, dict] = {}
        for md in results:
            key = str(md["match_no"])
            if md["winner"] is None:
                res = "D"
            else:
                res = "H" if md["winner"] == md["home"] else "A"
            outcome[key] = {"result": res,
                            "margin": abs(md["home_goals"] - md["away_goals"])}
        self.last_round_points = {}
        for token, picks in self.predictions.items():
            member = self.members.get(token)
            if not member:
                continue
            pts = 0
            for key, pick in picks.items():
                actual = outcome.get(key)
                if not actual:
                    continue
                if pick["result"] == actual["result"]:
                    pts += POINTS_RESULT
                    if pick.get("margin") is not None and pick["margin"] == actual["margin"]:
                        pts += POINTS_MARGIN_BONUS
                        member["exact"] += 1
            member["points"] += pts
            member["rounds_played"] += 1
            self.last_round_points[member["name"]] = pts

    def _finish_groups(self) -> None:
        tables = {g: _sort_group([self.group_records[c] for c in codes])
                  for g, codes in self.group_members.items()}
        self.group_tables = tables
        slot_map, _ = _resolve_qualifiers(tables)
        self.phase = "knockout"
        self.ko_round_idx = 0
        self.cur_round = [KnockoutMatch(73 + i, "R32", home=slot_map.get(s_h),
                                        away=slot_map.get(s_a),
                                        meta=self._meta_for(73 + i))
                          for i, (s_h, s_a) in enumerate(R32_PAIRINGS)]

    def _advance_ko(self) -> None:
        rnd = KO_ROUNDS[self.ko_round_idx]
        if rnd == "F":
            self.champion = self.cur_round[0].winner_code
            self.phase = "done"
            return
        winners = [km.winner_code for km in self.cur_round]
        nxt = KO_ROUNDS[self.ko_round_idx + 1]
        start_no = {"R16": 89, "QF": 97, "SF": 101, "F": 103}[nxt]
        self.cur_round = [KnockoutMatch(start_no + k, nxt, home=winners[2 * k],
                                        away=winners[2 * k + 1],
                                        meta=self._meta_for(start_no + k))
                          for k in range(len(winners) // 2)]
        self.ko_round_idx += 1

    def _meta_for(self, match_no: int) -> dict:
        for m in self.data.knockout_meta:
            if m.get("match_no") == match_no:
                return m
        return {}

    # ---------------------------------------------------------------- output
    def leaderboard(self) -> List[dict]:
        rows = [{"name": m["name"], "points": m["points"], "exact": m["exact"],
                 "rounds_played": m["rounds_played"], "host": m["host"]}
                for m in self.members.values()]
        rows.sort(key=lambda r: (r["points"], r["exact"]), reverse=True)
        return rows

    def state(self, token: str) -> dict:
        self.check_deadline()
        member = self._member(token)
        need = len(self.round_matches)
        return {
            "code": self.code, "phase": self.phase, "round_no": self.round_no,
            "matchday": self.md_index + 1 if self.phase == "group" else None,
            "ko_label": (KO_LABEL[KO_ROUNDS[self.ko_round_idx]]
                         if self.phase == "knockout" else None),
            "members": [{"name": m["name"], "host": m["host"],
                         "points": m["points"],
                         "predicted": len(self.predictions.get(t, {})) >= need
                         if need else True,
                         "is_you": t == token}
                        for t, m in self.members.items()],
            "you": {"name": member["name"], "host": member["host"],
                    "points": member["points"], "exact": member["exact"],
                    "predictions": dict(self.predictions.get(token, {})),
                    "predicted": len(self.predictions.get(token, {})) >= need
                    if need else True},
            "round_matches": self.round_matches,
            "waiting_on": self.pending_members(),
            "last_round": self.last_round_results,
            "last_round_points": self.last_round_points,
            "leaderboard": self.leaderboard(),
            "deadline_at": self.round_deadline,
            "champion": self.champion,
            "champion_name": self.names.get(self.champion) if self.champion else None,
            "team_names": self.names,
            "done": self.phase == "done",
        }

    def preview(self) -> dict:
        return {"code": self.code, "phase": self.phase,
                "players": [{"name": m["name"], "host": m["host"]}
                            for m in self.members.values()],
                "joinable": self.phase == "lobby" and len(self.members) < MAX_MEMBERS}
