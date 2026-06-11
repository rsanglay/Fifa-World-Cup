"""Tournament-wide player stats: the Golden Boot race.

One tracker per tournament (career or multiplayer room). Matches with real
event streams feed goals/assists directly; auto-simmed matches sample
scorers from the team's best XI with the same position weights the event
generator uses — so the race covers all 104 matches, not just yours.
"""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np

from app.engine.squad import best_xi

SCORE_W = {"FWD": 6.0, "MID": 3.0, "DEF": 1.0, "GK": 0.02}
ASSIST_W = {"FWD": 2.5, "MID": 4.0, "DEF": 1.2, "GK": 0.05}
ASSIST_PROB = 0.72   # share of goals with a credited assist


class StatsTracker:
    def __init__(self, all_squads: Dict[str, list], team_names: Dict[str, str]):
        self.all_squads = all_squads
        self.names = team_names
        # player_id -> row
        self.rows: Dict[str, dict] = {}

    def _row(self, team: str, pid: str, name: str, position: str) -> dict:
        row = self.rows.get(pid)
        if row is None:
            row = {"player_id": pid, "name": name, "team": team,
                   "team_name": self.names.get(team, team),
                   "position": position, "goals": 0, "assists": 0}
            self.rows[pid] = row
        return row

    # ----------------------------------------------------------- ingestion
    def add_goal_events(self, events: List[dict]) -> None:
        """Feed goal events that carry scorer (and optionally assist) ids."""
        for e in events:
            if e.get("type") != "goal" or not e.get("scorer_id"):
                continue
            self._row(e["team"], e["scorer_id"], e["scorer"],
                      e.get("position", "")) ["goals"] += 1
            if e.get("assist_id"):
                self._row(e["team"], e["assist_id"], e["assist"],
                          e.get("assist_position", "")) ["assists"] += 1

    def sample_goals(self, rng: np.random.Generator, team: str, goals: int) -> None:
        """Attribute goals from an auto-simmed match (no event stream)."""
        if goals <= 0:
            return
        players = best_xi(self.all_squads.get(team, []))
        if not players:
            return
        w = np.array([SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players])
        w = w / w.sum()
        for _ in range(int(goals)):
            scorer = players[int(rng.choice(len(players), p=w))]
            self._row(team, scorer.id, scorer.name, scorer.position)["goals"] += 1
            if rng.random() < ASSIST_PROB:
                others = [p for p in players if p.id != scorer.id]
                ow = np.array([ASSIST_W.get(p.position, 1.0) * (p.rating / 80.0)
                               for p in others])
                ow = ow / ow.sum()
                a = others[int(rng.choice(len(others), p=ow))]
                self._row(team, a.id, a.name, a.position)["assists"] += 1

    def decorate_assists(self, rng: np.random.Generator, events: List[dict],
                         on_pitch: Dict[str, list]) -> None:
        """Add assist credits to goal events in place (team -> players map)."""
        for e in events:
            if e.get("type") != "goal" or e.get("assist_id") or e.get("source") == "penalty":
                continue
            if rng.random() >= ASSIST_PROB:
                continue
            mates = [p for p in on_pitch.get(e["team"], []) if p.id != e.get("scorer_id")]
            if not mates:
                continue
            w = np.array([ASSIST_W.get(p.position, 1.0) * (p.rating / 80.0) for p in mates])
            w = w / w.sum()
            a = mates[int(rng.choice(len(mates), p=w))]
            e["assist"] = a.name
            e["assist_id"] = a.id
            e["assist_position"] = a.position

    # ------------------------------------------------------------- payload
    def top(self, n: int = 10, team: Optional[str] = None) -> List[dict]:
        rows = [r for r in self.rows.values() if team is None or r["team"] == team]
        rows.sort(key=lambda r: (r["goals"], r["assists"]), reverse=True)
        return [dict(r) for r in rows[:n] if r["goals"] or r["assists"]]
