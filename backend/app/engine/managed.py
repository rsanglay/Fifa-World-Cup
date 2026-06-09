"""Round-by-round managed tournament.

The user controls ONE nation and picks its XI for each match in turn; every other
match auto-simulates around them. Carries fatigue (real schedule rest), momentum,
and discipline (yellow accumulation + red cards -> next-match suspension) between
rounds, so rotation actually matters.

State lives in a server-side session (see services/manage_session.py). The engine
itself is a plain stepper: `state()` describes what to do next, `play_round(xi)`
advances one match (managed) + auto-sims its round, returns the updated state.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional

import numpy as np

from app.engine.match import TeamStrength, simulate
from app.engine.squad import lineup_delta
from app.engine.tournament import (
    R32_PAIRINGS,
    KnockoutMatch,
    MOMENTUM_WIN,
    TeamRecord,
    _apply_result_momentum,
    _home_adv,
    _momentum_adv,
    _net_fatigue_adv,
    _sort_group,
    play_group,
    rank_third_placed,
    update_momentum,
)

KO_ROUNDS = ["R32", "R16", "QF", "SF", "F"]
KO_LABEL = {"R32": "Round of 32", "R16": "Round of 16", "QF": "Quarter-final",
            "SF": "Semi-final", "F": "Final"}
YELLOW_PROB = 0.16   # per managed player, per match
YELLOWS_FOR_BAN = 2


class ManagedTournament:
    def __init__(self, data, team: str, squad: list, seed: Optional[int]):
        self.data = data
        self.team = team
        self.squad = squad
        self.rng = np.random.default_rng(seed)
        self.base_elo = {c: float(t["elo"]) for c, t in data.teams.items()}
        self.momentum: Dict[str, float] = {}
        self.last_played: Dict[str, str] = {}
        self.group = data.teams[team]["group"]

        self.members: Dict[str, list] = defaultdict(list)
        for c, t in data.teams.items():
            self.members[t["group"]].append(c)

        self.group_records = {c: TeamRecord(c, data.teams[c]["group"]) for c in data.teams}
        gf = sorted(data.group_fixtures[self.group],
                    key=lambda f: (f.get("date", ""), f.get("match_no", 0)))
        self.matchdays = [gf[0:2], gf[2:4], gf[4:6]]
        self.md_index = 0

        self.phase = "group"          # group -> knockout -> done
        self.match_log: List[dict] = []
        self.journey: List[dict] = []
        self.suspended: Dict[str, int] = {}   # player id -> bans remaining
        self.yellows: Dict[str, int] = {}
        self.alive = True
        self.eliminated_round: Optional[str] = None
        self.champion: Optional[str] = None
        self.runner_up: Optional[str] = None

        self.group_tables: Optional[Dict[str, List[TeamRecord]]] = None
        self.ko_round_idx = 0
        self.cur_round: List[KnockoutMatch] = []   # current KO round matches
        self.last_round_results: List[dict] = []   # matches just played (for the UI)

    # ---------------------------------------------------------------- helpers
    def _meta_for(self, match_no: int) -> dict:
        for m in self.data.knockout_meta:
            if m.get("match_no") == match_no:
                return m
        return {}

    def _sim(self, home, away, date, country, xi_ids=None, knockout=False):
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        if xi_ids is not None:
            ld = float(lineup_delta(self.squad, xi_ids).get("elo_delta", 0.0))
            if home == self.team:
                sh.lineup_delta = ld
            elif away == self.team:
                sa.lineup_delta = ld
        h_adv = (_home_adv(home, away, country)
                 + _net_fatigue_adv(home, away, date, self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        res = simulate(sh, sa, self.rng, home_advantage=h_adv, knockout=knockout)
        if date:
            self.last_played[home] = date
            self.last_played[away] = date
        if knockout:
            winner = home if res.winner == "home" else away
            loser = away if res.winner == "home" else home
            update_momentum(self.momentum, winner, MOMENTUM_WIN)
            update_momentum(self.momentum, loser, -MOMENTUM_WIN)
        else:
            _apply_result_momentum(self.momentum, home, away, res.home_goals, res.away_goals)
        return res

    def _record_discipline(self, xi_ids: List[str], red_minute):
        """Roll yellows for the managed XI, apply reds, tick down bans."""
        # Decrement existing bans first (this match they sat out / now served).
        for pid in list(self.suspended):
            self.suspended[pid] -= 1
            if self.suspended[pid] <= 0:
                del self.suspended[pid]
        # Yellows this match.
        for pid in xi_ids:
            if self.rng.random() < YELLOW_PROB:
                self.yellows[pid] = self.yellows.get(pid, 0) + 1
                if self.yellows[pid] >= YELLOWS_FOR_BAN:
                    self.suspended[pid] = 1
                    self.yellows[pid] = 0
        # A red card on our side -> a player banned next match.
        if red_minute is not None and xi_ids:
            pid = xi_ids[int(self.rng.integers(len(xi_ids)))]
            self.suspended[pid] = 1

    def _match_dict(self, home, away, res, date=None, rnd="groups"):
        return {
            "round": rnd, "home": home, "away": away,
            "home_goals": res.home_goals, "away_goals": res.away_goals,
            "penalties": res.went_penalties, "home_pens": res.home_pens,
            "away_pens": res.away_pens, "winner": (home if res.winner == "home"
                                                   else away if res.winner == "away" else None),
            "date": date,
        }

    # --------------------------------------------------------------- stepping
    def play_round(self, xi_ids: List[str]) -> None:
        self.last_round_results = []
        if self.phase == "group":
            self._play_group_matchday(xi_ids)
        elif self.phase == "knockout":
            self._play_ko_round(xi_ids)

    def _play_group_matchday(self, xi_ids):
        for fx in self.matchdays[self.md_index]:
            home, away = fx["home"], fx["away"]
            date, country = fx.get("date"), fx.get("country", "")
            managed = self.team in (home, away)
            res = self._sim(home, away, date, country,
                            xi_ids=xi_ids if managed else None)
            self.group_records[home].apply(away, res.home_goals, res.away_goals)
            self.group_records[away].apply(home, res.away_goals, res.home_goals)
            md = self._match_dict(home, away, res, date, "groups")
            self.match_log.append(md)
            self.last_round_results.append(md)
            if managed:
                self.journey.append(md)
                red = res.red_home if home == self.team else res.red_away
                self._record_discipline(xi_ids, red)
        self.md_index += 1
        if self.md_index >= 3:
            self._finish_group_stage()

    def _finish_group_stage(self):
        # Auto-simulate every other group in full (fatigue/momentum-aware).
        tables: Dict[str, List[TeamRecord]] = {}
        managed_table = _sort_group([self.group_records[c] for c in self.members[self.group]])
        tables[self.group] = managed_table
        for g, codes in self.members.items():
            if g == self.group:
                continue
            strengths = {c: TeamStrength(c, self.base_elo[c]) for c in codes}
            table, log = play_group(g, codes, strengths, self.data.group_fixtures.get(g, []),
                                    self.rng, {}, self.last_played, self.momentum)
            tables[g] = table
            self.match_log.extend(log)
        self.group_tables = tables

        # Did the managed team qualify (top 2, or one of 8 best thirds)?
        pos = next(i for i, r in enumerate(managed_table) if r.code == self.team)
        qualified = pos <= 1
        if pos == 2:
            thirds = rank_third_placed([t[2] for t in tables.values() if len(t) >= 3])
            qualified = self.team in [r.code for r in thirds[:8]]
        if not qualified:
            self.alive = False
            self.eliminated_round = "groups"
            self.phase = "done"
            return
        self._build_first_ko_round()

    def _slot_map(self):
        slot: Dict[str, str] = {}
        thirds = []
        for g, table in self.group_tables.items():
            slot[f"{g}1"] = table[0].code
            slot[f"{g}2"] = table[1].code
            if len(table) >= 3:
                thirds.append(table[2])
        for i, r in enumerate(rank_third_placed(thirds)[:8], 1):
            slot[f"T{i}"] = r.code
        return slot

    def _build_first_ko_round(self):
        self.phase = "knockout"
        self.ko_round_idx = 0
        slot = self._slot_map()
        self.cur_round = []
        for i, (sh, sa) in enumerate(R32_PAIRINGS):
            no = 73 + i
            self.cur_round.append(KnockoutMatch(no, "R32", home=slot.get(sh),
                                                away=slot.get(sa), meta=self._meta_for(no)))

    def _managed_match_in_round(self):
        for km in self.cur_round:
            if self.team in (km.home, km.away):
                return km
        return None

    def _play_ko_round(self, xi_ids):
        rnd = KO_ROUNDS[self.ko_round_idx]
        managed_km = self._managed_match_in_round()
        for km in self.cur_round:
            is_managed = km is managed_km
            date = km.meta.get("date")
            res = self._sim(km.home, km.away, date, km.meta.get("country", ""),
                            xi_ids=xi_ids if is_managed else None, knockout=True)
            km.result = res
            km.winner_code = km.home if res.winner == "home" else km.away
            km.loser_code = km.away if res.winner == "home" else km.home
            md = self._match_dict(km.home, km.away, res, date, rnd)
            self.match_log.append(md)
            self.last_round_results.append(md)
            if is_managed:
                self.journey.append(md)
                red = res.red_home if km.home == self.team else res.red_away
                self._record_discipline(xi_ids, red)

        # Did we go through?
        if managed_km and managed_km.loser_code == self.team:
            self.alive = False
            self.eliminated_round = rnd
            self.phase = "done"
            return
        if rnd == "F":
            self.champion = managed_km.winner_code
            self.runner_up = managed_km.loser_code
            self.phase = "done"
            return
        # Build next round from winners.
        winners = [km.winner_code for km in self.cur_round]
        nxt_round = KO_ROUNDS[self.ko_round_idx + 1]
        start_no = {"R16": 89, "QF": 97, "SF": 101, "F": 103}[nxt_round]
        self.cur_round = [
            KnockoutMatch(start_no + k, nxt_round,
                          home=winners[2 * k], away=winners[2 * k + 1],
                          meta=self._meta_for(start_no + k))
            for k in range(len(winners) // 2)
        ]
        self.ko_round_idx += 1

    # ----------------------------------------------------------------- output
    def _squad_payload(self):
        out = []
        for p in self.squad:
            out.append({
                "id": p.id, "name": p.name, "position": p.position,
                "number": p.number, "rating": p.rating, "club": p.club,
                "photo_url": getattr(p, "photo_url", ""),
                "suspended": self.suspended.get(p.id, 0) > 0,
                "yellows": self.yellows.get(p.id, 0),
            })
        return out

    def _next_fixture(self):
        if self.phase == "group":
            for fx in self.matchdays[self.md_index]:
                if self.team in (fx["home"], fx["away"]):
                    opp = fx["away"] if fx["home"] == self.team else fx["home"]
                    return {"stage": f"Group {self.group} · Matchday {self.md_index + 1}",
                            "opponent": opp, "date": fx.get("date"),
                            "venue": fx.get("venue"), "city": fx.get("city")}
        elif self.phase == "knockout":
            km = self._managed_match_in_round()
            if km:
                opp = km.away if km.home == self.team else km.home
                return {"stage": KO_LABEL[KO_ROUNDS[self.ko_round_idx]],
                        "opponent": opp, "date": km.meta.get("date"),
                        "venue": km.meta.get("venue"), "city": km.meta.get("city")}
        return None

    def state(self) -> dict:
        names = {c: t["name"] for c, t in self.data.teams.items()}
        table = None
        if self.group_tables:
            table = [r.as_dict() for r in self.group_tables[self.group]]
        else:
            table = [r.as_dict() for r in
                     _sort_group([self.group_records[c] for c in self.members[self.group]])]
        return {
            "team": self.team, "team_name": names[self.team], "group": self.group,
            "phase": self.phase, "alive": self.alive,
            "eliminated_round": self.eliminated_round, "champion": self.champion,
            "champion_name": names.get(self.champion) if self.champion else None,
            "group_table": table,
            "next_fixture": self._next_fixture(),
            "last_round": self.last_round_results,
            "journey": self.journey,
            "squad": self._squad_payload(),
            "team_names": names,
            "done": self.phase == "done",
            "won": self.champion == self.team,
        }
