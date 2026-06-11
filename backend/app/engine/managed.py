"""Round-by-round managed tournament (career mode).

You control ONE nation. Each match you pick the XI + a mentality, watch it play
out in two halves (with a half-time tactical switch), and everything else
auto-sims. Carries fatigue, momentum and discipline (yellows->ban, reds) between
rounds. Tracks a nation expectation, per-match ratings, achievements and form.

Two-phase managed match (legacy):
  play_first_half(xi, mentality)  -> sims 0-45', stores HT state
  play_second_half(mentality)     -> sims 45-90' (+ET/pens), finalises, auto-sims
                                     the rest of the round, advances.

Live managed match (interactive, Football-Manager style):
  start_live(xi, mentality)   -> creates a LiveMatch (minute 0)
  tick_live(minutes)          -> advances the sim minute by minute; the client
                                 can pause, change mentality and substitute at
                                 ANY minute. Finalises automatically at FT.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional

import numpy as np

from app.engine import dressing_room
from app.engine.condition import SquadCondition
from app.engine.live import LiveMatch
from app.engine.stats import StatsTracker
from app.engine.match import (
    RED_CARD_PROB,
    TeamStrength,
    _lambdas,
    simulate,
    win_expectancy,
)
from app.engine.squad import best_xi, lineup_delta
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
YELLOW_PROB = 0.16
YELLOWS_FOR_BAN = 2
# mentality -> (own goal multiplier, opponent goal multiplier). Attacking opens
# the game up both ways; defensive shuts it down.
MENTALITY = {"attacking": (1.20, 1.14), "balanced": (1.0, 1.0), "defensive": (0.84, 0.80)}
SCORE_W = {"FWD": 6.0, "MID": 3.0, "DEF": 1.0, "GK": 0.02}


class ManagedTournament:
    def __init__(self, data, team, squad, all_squads, seed):
        self.data = data
        self.team = team
        self.squad = squad
        self.all_squads = all_squads
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

        self.phase = "group"
        self.match_log: List[dict] = []
        self.journey: List[dict] = []
        self.suspended: Dict[str, int] = {}
        self.yellows: Dict[str, int] = {}
        self.alive = True
        self.eliminated_round: Optional[str] = None
        self.champion: Optional[str] = None
        self.runner_up: Optional[str] = None

        self.group_tables: Optional[Dict[str, List[TeamRecord]]] = None
        self.ko_round_idx = 0
        self.cur_round: List[KnockoutMatch] = []
        self.last_round_results: List[dict] = []
        self.last_managed_match: Optional[dict] = None   # full events for live replay

        self.pending: Optional[dict] = None
        self.live: Optional[LiveMatch] = None
        self._live_mm: Optional[dict] = None
        self.ratings: List[float] = []
        self.achievements: List[str] = []
        self.form: List[str] = []   # 'W'/'D'/'L'
        self.expectation = self._expectation()
        # Depth systems: per-player condition, injuries, the Golden Boot race
        # and between-rounds dressing-room events.
        self.condition = SquadCondition(squad)
        self.injured: Dict[str, int] = {}          # player_id -> rounds out
        self.stats = StatsTracker(all_squads, {c: t["name"] for c, t in data.teams.items()})
        self.pending_event: Optional[dict] = None
        self.news: List[str] = []

    # ---------------------------------------------------------- expectations
    def _expectation(self) -> dict:
        rank = sorted(self.base_elo.items(), key=lambda kv: kv[1], reverse=True)
        pos = next(i for i, (c, _) in enumerate(rank) if c == self.team)
        if pos < 3:
            tier, label = "F", "Win the World Cup"
        elif pos < 8:
            tier, label = "SF", "Reach the semi-finals"
        elif pos < 16:
            tier, label = "QF", "Reach the quarter-finals"
        elif pos < 24:
            tier, label = "R16", "Reach the Round of 16"
        else:
            tier, label = "groups", "Get out of the group"
        return {"tier": tier, "label": label}

    # ----------------------------------------------------------------- helpers
    def _meta_for(self, match_no: int) -> dict:
        for m in self.data.knockout_meta:
            if m.get("match_no") == match_no:
                return m
        return {}

    def _strengths(self, home, away, date, country):
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        h_adv = (_home_adv(home, away, country)
                 + _net_fatigue_adv(home, away, date, self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        return sh, sa, h_adv

    def _base_lambdas(self, home, away, date, country, xi_ids):
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        if xi_ids is not None:
            ld = (float(lineup_delta(self.squad, xi_ids).get("elo_delta", 0.0))
                  + self.condition.xi_elo_delta(xi_ids))
            if home == self.team:
                sh.lineup_delta = ld
            elif away == self.team:
                sa.lineup_delta = ld
        h_adv = (_home_adv(home, away, country)
                 + _net_fatigue_adv(home, away, date, self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        return _lambdas(sh, sa, h_adv)

    def _xi_players(self, team, xi_ids):
        if team == self.team and xi_ids:
            by = {p.id: p for p in self.squad}
            line = [by[i] for i in xi_ids if i in by]
            if len(line) == 11:
                return line
        return best_xi(self.all_squads.get(team, []))

    def _gen_events(self, team, players, goals, lo, hi):
        if goals <= 0 or not players:
            return []
        w = np.array([SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players])
        w = w / w.sum()
        mins = sorted(int(m) for m in self.rng.integers(lo, hi + 1, size=int(goals)))
        out = []
        for k in range(int(goals)):
            scorer = players[int(self.rng.choice(len(players), p=w))]
            out.append({"type": "goal", "minute": mins[k], "team": team,
                        "scorer": scorer.name, "scorer_id": scorer.id,
                        "position": scorer.position, "assist": None})
        return out

    # --------------------------------------------------------------- preview
    def preview(self, xi_ids, mentality="balanced") -> dict:
        mm = self._current_managed_match()
        if not mm:
            return {}
        home, away, date, country = mm["home"], mm["away"], mm["date"], mm["country"]
        lh, la = self._base_lambdas(home, away, date, country, xi_ids)
        own, opp = MENTALITY.get(mentality, (1.0, 1.0))
        if home == self.team:
            lh, la = lh * own, la * opp
        else:
            la, lh = la * own, lh * opp
        # Poisson outcome split over a small grid.
        import math
        grid = 8
        ph = [math.exp(-lh) * lh ** k / math.factorial(k) for k in range(grid)]
        pa = [math.exp(-la) * la ** k / math.factorial(k) for k in range(grid)]
        hw = dw = aw = 0.0
        for i in range(grid):
            for j in range(grid):
                p = ph[i] * pa[j]
                if i > j: hw += p
                elif i == j: dw += p
                else: aw += p
        tot = hw + dw + aw
        we_win = (hw if home == self.team else aw) / tot
        we_draw = dw / tot
        we_lose = (aw if home == self.team else hw) / tot
        opp_team = away if home == self.team else home
        return {
            "win": round(we_win, 3), "draw": round(we_draw, 3), "lose": round(we_lose, 3),
            "your_key": _top_name(self._xi_players(self.team, xi_ids)),
            "opp_key": _top_name(best_xi(self.all_squads.get(opp_team, []))),
        }

    # --------------------------------------------------------- match plumbing
    def _current_managed_match(self):
        if self.phase == "group":
            for fx in self.matchdays[self.md_index]:
                if self.team in (fx["home"], fx["away"]):
                    return {"kind": "group", "home": fx["home"], "away": fx["away"],
                            "date": fx.get("date"), "country": fx.get("country", ""),
                            "knockout": False, "fx": fx}
        elif self.phase == "knockout":
            km = self._managed_km()
            if km:
                return {"kind": "ko", "home": km.home, "away": km.away,
                        "date": km.meta.get("date"), "country": km.meta.get("country", ""),
                        "knockout": True, "km": km}
        return None

    def _managed_km(self):
        for km in self.cur_round:
            if self.team in (km.home, km.away):
                return km
        return None

    # --------------------------------------------------------- two-phase play
    def play_first_half(self, xi_ids, mentality="balanced"):
        mm = self._current_managed_match()
        if mm is None or self.pending is not None:
            return
        self._discard_pending_event()
        home, away, date, country = mm["home"], mm["away"], mm["date"], mm["country"]
        lh, la = self._base_lambdas(home, away, date, country, xi_ids)
        own, opp = MENTALITY.get(mentality, (1.0, 1.0))
        if home == self.team:
            elh, ela = lh * own, la * opp
        else:
            elh, ela = lh * opp, la * own
        fh_home = int(self.rng.poisson(elh * 0.5))
        fh_away = int(self.rng.poisson(ela * 0.5))
        home_pl = self._xi_players(home, xi_ids)
        away_pl = self._xi_players(away, xi_ids)
        events = (self._gen_events(home, home_pl, fh_home, 1, 45)
                  + self._gen_events(away, away_pl, fh_away, 1, 45))
        events.sort(key=lambda e: e["minute"])
        self.pending = {
            "mm": mm, "xi": xi_ids, "home": home, "away": away, "date": date,
            "country": country, "lh": lh, "la": la, "fh_home": fh_home,
            "fh_away": fh_away, "fh_events": events, "ment1": mentality,
        }

    def play_second_half(self, mentality="balanced"):
        p = self.pending
        if p is None:
            return
        home, away = p["home"], p["away"]
        lh, la = p["lh"], p["la"]
        own, opp = MENTALITY.get(mentality, (1.0, 1.0))
        if home == self.team:
            elh, ela = lh * own, la * opp
        else:
            elh, ela = lh * opp, la * own
        sh_home = int(self.rng.poisson(elh * 0.5))
        sh_away = int(self.rng.poisson(ela * 0.5))
        home_pl = self._xi_players(home, p["xi"])
        away_pl = self._xi_players(away, p["xi"])
        events = list(p["fh_events"])
        events += self._gen_events(home, home_pl, sh_home, 46, 90)
        events += self._gen_events(away, away_pl, sh_away, 46, 90)

        hg = p["fh_home"] + sh_home
        ag = p["fh_away"] + sh_away
        knockout = p["mm"]["knockout"]
        penalties = False
        hp = ap = None
        red = None
        if self.rng.random() < RED_CARD_PROB:
            red = int(self.rng.integers(25, 90))

        if knockout and hg == ag:
            # Extra time then penalties.
            et_h = int(self.rng.poisson(elh / 6.0))
            et_a = int(self.rng.poisson(ela / 6.0))
            events += self._gen_events(home, home_pl, et_h, 91, 120)
            events += self._gen_events(away, away_pl, et_a, 91, 120)
            hg += et_h
            ag += et_a
            if hg == ag:
                penalties = True
                p_home = 0.5 + (win_expectancy(self.base_elo[home], self.base_elo[away]) - 0.5) * 0.3
                hp, ap = 0, 0
                for _ in range(5):
                    hp += int(self.rng.random() < 0.75 * (p_home / 0.5) * 0.5 + 0.375)
                    ap += int(self.rng.random() < 0.75)
                while hp == ap:
                    hp += int(self.rng.random() < 0.75)
                    ap += int(self.rng.random() < 0.75)
        events.sort(key=lambda e: e["minute"])

        winner = None
        if hg > ag or (penalties and (hp or 0) > (ap or 0)):
            winner = home
        elif ag > hg or (penalties and (ap or 0) > (hp or 0)):
            winner = away

        md = {"round": "groups" if not knockout else KO_ROUNDS[self.ko_round_idx],
              "home": home, "away": away, "home_goals": hg, "away_goals": ag,
              "penalties": penalties, "home_pens": hp, "away_pens": ap,
              "winner": winner, "date": p["date"], "events": events}

        # Apply to standings / momentum / rest.
        if not knockout:
            self.group_records[home].apply(away, hg, ag)
            self.group_records[away].apply(home, ag, hg)
            _apply_result_momentum(self.momentum, home, away, hg, ag)
        else:
            update_momentum(self.momentum, winner, MOMENTUM_WIN)
            update_momentum(self.momentum, away if winner == home else home, -MOMENTUM_WIN)
        if p["date"]:
            self.last_played[home] = p["date"]
            self.last_played[away] = p["date"]

        self.match_log.append(md)
        self.journey.append(md)
        self.last_managed_match = md
        self.last_round_results = [md]
        red_for_us = red if (red and (home == self.team or away == self.team)) else None
        self._record_discipline(p["xi"], red_for_us)
        won = winner == self.team
        drew = winner is None
        self._last_xi = list(p["xi"])
        self.condition.after_round(p["xi"], None if drew else won)
        self.stats.add_goal_events(md["events"])
        self._rate_and_track(md)

        # Auto-sim the rest of this round, then advance.
        self._finish_round(p["mm"], winner)
        self.pending = None
        self._maybe_event()

    # ------------------------------------------------------ live (interactive)
    def start_live(self, xi_ids, mentality="balanced"):
        """Begin an interactive minute-by-minute match (in-game management)."""
        mm = self._current_managed_match()
        if mm is None or self.live is not None or self.pending is not None:
            return
        self._discard_pending_event()
        home, away, date, country = mm["home"], mm["away"], mm["date"], mm["country"]
        sh, sa, h_adv = self._strengths(home, away, date, country)
        opp = away if home == self.team else home
        self.live = LiveMatch(
            rng=self.rng, team=self.team, home=home, away=away,
            knockout=mm["knockout"], sh=sh, sa=sa, h_adv=h_adv,
            squad=[p for p in self.squad
                   if self.suspended.get(p.id, 0) <= 0 and self.injured.get(p.id, 0) <= 0],
            opp_players=best_xi(self.all_squads.get(opp, [])),
            xi_ids=xi_ids, mentality=mentality, date=date,
            cond_mult=self.condition.multipliers(),
        )
        self._live_mm = mm

    def tick_live(self, minutes=1):
        if self.live is None:
            return None
        new = self.live.tick(minutes)
        snap = self.live.snapshot(new)
        if self.live.done:
            self._finalize_live()
        return snap

    def live_tactics(self, mentality=None, tempo=None, passing=None, pressing=None,
                     attack_style=None, time_wasting=None, penalty_taker=None):
        if self.live is None:
            return None
        self.live.set_tactics(mentality=mentality, tempo=tempo,
                              passing=passing, pressing=pressing,
                              attack_style=attack_style, time_wasting=time_wasting,
                              penalty_taker=penalty_taker)
        return self.live.snapshot()

    def live_substitute(self, out_id, in_id):
        if self.live is None:
            return None, "No live match in progress."
        ok, msg = self.live.substitute(out_id, in_id)
        return self.live.snapshot(), (msg if not ok else "ok")

    def _finalize_live(self):
        lv, mm = self.live, self._live_mm
        record_events = [e for e in lv.events if e.get("type") in ("goal", "red")]
        md = {"round": "groups" if not mm["knockout"] else KO_ROUNDS[self.ko_round_idx],
              "home": lv.home, "away": lv.away, "home_goals": lv.hg,
              "away_goals": lv.ag, "penalties": lv.penalties,
              "home_pens": lv.home_pens, "away_pens": lv.away_pens,
              "winner": lv.winner, "date": lv.date, "events": record_events}

        if not mm["knockout"]:
            self.group_records[lv.home].apply(lv.away, lv.hg, lv.ag)
            self.group_records[lv.away].apply(lv.home, lv.ag, lv.hg)
            _apply_result_momentum(self.momentum, lv.home, lv.away, lv.hg, lv.ag)
        else:
            update_momentum(self.momentum, lv.winner, MOMENTUM_WIN)
            update_momentum(self.momentum, lv.away if lv.winner == lv.home else lv.home,
                            -MOMENTUM_WIN)
        if lv.date:
            self.last_played[lv.home] = lv.date
            self.last_played[lv.away] = lv.date

        self.match_log.append(md)
        self.journey.append(md)
        self.last_managed_match = md
        self.last_round_results = [md]
        self._record_discipline_live(lv.yellow_ids, lv.red_ids)
        # Knocks picked up in the match rule players out of coming round(s).
        for pid in lv.injured_ids:
            self.injured[pid] = int(self.rng.integers(1, 3))   # 1-2 rounds
            p = lv.by_id.get(pid)
            if p:
                self.news.append(f"🏥 {p.name} is injured — out for "
                                 f"{self.injured[pid]} match(es).")
        won = lv.winner == self.team
        drew = lv.winner is None
        self._last_xi = list(lv.played_ids)
        self.condition.after_round(lv.played_ids, None if drew else won)
        self.stats.add_goal_events(md["events"])
        self._rate_and_track(md)
        self._finish_round(mm, lv.winner)
        self.live = None
        self._live_mm = None
        self._maybe_event()

    def _tick_injuries(self):
        for pid in list(self.injured):
            self.injured[pid] -= 1
            if self.injured[pid] <= 0:
                del self.injured[pid]

    def _record_discipline_live(self, yellow_ids, red_ids):
        """Apply the cards actually shown in the live match (no random re-draw)."""
        self._tick_injuries()
        for pid in list(self.suspended):
            self.suspended[pid] -= 1
            if self.suspended[pid] <= 0:
                del self.suspended[pid]
        for pid in yellow_ids:
            self.yellows[pid] = self.yellows.get(pid, 0) + 1
            if self.yellows[pid] >= YELLOWS_FOR_BAN:
                self.suspended[pid] = 1
                self.yellows[pid] = 0
        for pid in red_ids:
            self.suspended[pid] = 1
            self.yellows[pid] = 0

    def _finish_round(self, mm, managed_winner):
        if mm["kind"] == "group":
            for fx in self.matchdays[self.md_index]:
                if self.team in (fx["home"], fx["away"]):
                    continue
                res = self._autosim(fx["home"], fx["away"], fx.get("date"), fx.get("country", ""))
                self.group_records[fx["home"]].apply(fx["away"], res[0], res[1])
                self.group_records[fx["away"]].apply(fx["home"], res[1], res[0])
                self.last_round_results.append(self._auto_md(fx["home"], fx["away"], res, fx.get("date"), "groups"))
            self.md_index += 1
            if self.md_index >= 3:
                self._finish_group_stage()
        else:
            managed_km = self._managed_km()
            for km in self.cur_round:
                if km is managed_km:
                    km.winner_code = managed_winner
                    km.loser_code = km.away if managed_winner == km.home else km.home
                    continue
                res = self._autosim(km.home, km.away, km.meta.get("date"), km.meta.get("country", ""), knockout=True)
                km.winner_code, km.loser_code = res[2], res[3]
                self.last_round_results.append(self._auto_md(km.home, km.away, res, km.meta.get("date"), KO_ROUNDS[self.ko_round_idx]))
            if managed_km and managed_km.loser_code == self.team:
                self.alive = False
                self.eliminated_round = KO_ROUNDS[self.ko_round_idx]
                self.phase = "done"
                self._final_review()
                return
            if KO_ROUNDS[self.ko_round_idx] == "F":
                self.champion = managed_km.winner_code
                self.runner_up = managed_km.loser_code
                self.phase = "done"
                self._final_review()
                return
            winners = [km.winner_code for km in self.cur_round]
            nxt = KO_ROUNDS[self.ko_round_idx + 1]
            start_no = {"R16": 89, "QF": 97, "SF": 101, "F": 103}[nxt]
            self.cur_round = [KnockoutMatch(start_no + k, nxt, home=winners[2 * k],
                              away=winners[2 * k + 1], meta=self._meta_for(start_no + k))
                              for k in range(len(winners) // 2)]
            self.ko_round_idx += 1

    def _autosim(self, home, away, date, country, knockout=False):
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        h_adv = (_home_adv(home, away, country)
                 + _net_fatigue_adv(home, away, date, self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        res = simulate(sh, sa, self.rng, home_advantage=h_adv, knockout=knockout)
        self.stats.sample_goals(self.rng, home, res.home_goals)
        self.stats.sample_goals(self.rng, away, res.away_goals)
        if date:
            self.last_played[home] = date
            self.last_played[away] = date
        if knockout:
            winner = home if res.winner == "home" else away
            loser = away if res.winner == "home" else home
            update_momentum(self.momentum, winner, MOMENTUM_WIN)
            update_momentum(self.momentum, loser, -MOMENTUM_WIN)
            return (res.home_goals, res.away_goals, winner, loser, res)
        _apply_result_momentum(self.momentum, home, away, res.home_goals, res.away_goals)
        return (res.home_goals, res.away_goals)

    def _auto_md(self, home, away, res, date, rnd):
        return {"round": rnd, "home": home, "away": away, "home_goals": res[0],
                "away_goals": res[1], "penalties": False, "winner":
                (res[2] if len(res) > 2 else (home if res[0] > res[1] else away if res[1] > res[0] else None)),
                "date": date, "events": []}

    # ------------------------------------------------------- discipline/rating
    def _record_discipline(self, xi_ids, red_minute):
        self._tick_injuries()
        for pid in list(self.suspended):
            self.suspended[pid] -= 1
            if self.suspended[pid] <= 0:
                del self.suspended[pid]
        for pid in xi_ids:
            if self.rng.random() < YELLOW_PROB:
                self.yellows[pid] = self.yellows.get(pid, 0) + 1
                if self.yellows[pid] >= YELLOWS_FOR_BAN:
                    self.suspended[pid] = 1
                    self.yellows[pid] = 0
        if red_minute is not None and xi_ids:
            self.suspended[xi_ids[int(self.rng.integers(len(xi_ids)))]] = 1

    def _rate_and_track(self, md):
        us_home = md["home"] == self.team
        gf = md["home_goals"] if us_home else md["away_goals"]
        ga = md["away_goals"] if us_home else md["home_goals"]
        won = md["winner"] == self.team
        drew = md["winner"] is None
        rating = 6.0 + (gf - ga) * 0.8 + (1.2 if won else -1.0 if not drew else 0)
        if ga == 0:
            rating += 0.6
        rating = round(max(3.0, min(10.0, rating)), 1)
        self.ratings.append(rating)
        self.form.append("W" if won else "D" if drew else "L")
        opp = md["away"] if us_home else md["home"]
        # Achievements.
        if ga == 0 and "Clean sheet" not in self.achievements:
            self.achievements.append("Clean sheet")
        if gf >= 3 and "Scored 3+ in a match" not in self.achievements:
            self.achievements.append("Scored 3+ in a match")
        top_rank = sorted(self.base_elo.items(), key=lambda kv: kv[1], reverse=True)
        top10 = {c for c, _ in top_rank[:10]}
        if won and opp in top10 and "Beat a top-10 nation" not in self.achievements:
            self.achievements.append("Beat a top-10 nation")
        if md.get("penalties") and won and "Won a penalty shootout" not in self.achievements:
            self.achievements.append("Won a penalty shootout")

    def _final_review(self):
        order = ["groups", "R32", "R16", "QF", "SF", "F", "W"]
        reached = "W" if self.champion == self.team else (self.eliminated_round or "groups")
        exp_idx = order.index(self.expectation["tier"]) if self.expectation["tier"] in order else 0
        reached_idx = order.index(reached) if reached in order else 0
        if reached_idx > exp_idx:
            self.review = "Expectations exceeded! 🎉"
        elif reached_idx == exp_idx:
            self.review = "Expectations met. 👍"
        else:
            self.review = "Below expectations. 😞"

    # --------------------------------------------------------- group stage end
    def _finish_group_stage(self):
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
            for entry in log:
                self.stats.sample_goals(self.rng, entry["home"], entry["home_goals"])
                self.stats.sample_goals(self.rng, entry["away"], entry["away_goals"])
            self.match_log.extend(log)
        self.group_tables = tables
        pos = next(i for i, r in enumerate(managed_table) if r.code == self.team)
        qualified = pos <= 1
        if pos == 2:
            thirds = rank_third_placed([t[2] for t in tables.values() if len(t) >= 3])
            qualified = self.team in [r.code for r in thirds[:8]]
        if pos == 0 and "Topped the group" not in self.achievements:
            self.achievements.append("Topped the group")
        if not qualified:
            self.alive = False
            self.eliminated_round = "groups"
            self.phase = "done"
            self._final_review()
            return
        self.phase = "knockout"
        self.ko_round_idx = 0
        slot = self._slot_map()
        self.cur_round = [KnockoutMatch(73 + i, "R32", home=slot.get(sh), away=slot.get(sa),
                          meta=self._meta_for(73 + i)) for i, (sh, sa) in enumerate(R32_PAIRINGS)]

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

    # ------------------------------------------------------- dressing room
    def _maybe_event(self):
        """Roll for a between-rounds dressing-room card (never when done)."""
        if self.phase == "done" or not self.alive:
            self.pending_event = None
            return
        nf = self._next_fixture()
        names = {c: t["name"] for c, t in self.data.teams.items()}
        self.pending_event = dressing_room.maybe_generate(
            self.rng, self.squad, list(getattr(self, "_last_xi", [])), self.condition,
            self.form, names, nf["opponent"] if nf else None)

    def respond_event(self, choice: str) -> Optional[str]:
        if not self.pending_event:
            return None
        outcome = dressing_room.apply(self.pending_event, choice, self.condition,
                                      self.momentum, self.team, [])
        self.news.append(f"🎙️ {outcome}")
        self.pending_event = None
        return outcome

    def _discard_pending_event(self):
        """Kicking off with an unanswered card = “no comment” (tiny morale dip)."""
        if self.pending_event:
            self.condition.nudge_all_morale(-1)
            self.news.append("🎙️ You ducked the press. The squad shrugged.")
            self.pending_event = None

    # ----------------------------------------------------------------- output
    def _squad_payload(self):
        return [{
            "id": p.id, "name": p.name, "position": p.position, "number": p.number,
            "rating": p.rating, "club": p.club, "photo_url": getattr(p, "photo_url", ""),
            "suspended": self.suspended.get(p.id, 0) > 0, "yellows": self.yellows.get(p.id, 0),
            "injured": self.injured.get(p.id, 0) > 0,
            "injured_rounds": self.injured.get(p.id, 0),
            **self.condition.payload(p.id),
        } for p in self.squad]

    def _next_fixture(self):
        mm = self._current_managed_match()
        if not mm:
            return None
        opp = mm["away"] if mm["home"] == self.team else mm["home"]
        stage = (f"Group {self.group} · Matchday {self.md_index + 1}" if mm["kind"] == "group"
                 else KO_LABEL[KO_ROUNDS[self.ko_round_idx]])
        return {"stage": stage, "opponent": opp, "date": mm["date"],
                "venue": (mm.get("fx") or mm.get("km").meta if mm.get("km") else {}).get("venue") if mm.get("fx") else (mm.get("km").meta.get("venue") if mm.get("km") else None),
                "home": mm["home"] == self.team}

    def state(self) -> dict:
        names = {c: t["name"] for c, t in self.data.teams.items()}
        if self.group_tables:
            table = [r.as_dict() for r in self.group_tables[self.group]]
        else:
            table = [r.as_dict() for r in _sort_group([self.group_records[c] for c in self.members[self.group]])]
        ht = None
        if self.pending:
            ht = {"home": self.pending["home"], "away": self.pending["away"],
                  "home_goals": self.pending["fh_home"], "away_goals": self.pending["fh_away"],
                  "events": self.pending["fh_events"]}
        return {
            "team": self.team, "team_name": names[self.team], "group": self.group,
            "phase": self.phase, "alive": self.alive,
            "eliminated_round": self.eliminated_round, "champion": self.champion,
            "champion_name": names.get(self.champion) if self.champion else None,
            "group_table": table, "next_fixture": self._next_fixture(),
            "last_round": self.last_round_results, "last_managed_match": self.last_managed_match,
            "journey": self.journey, "squad": self._squad_payload(), "team_names": names,
            "done": self.phase == "done", "won": self.champion == self.team,
            "awaiting_second_half": self.pending is not None, "half_time": ht,
            "live": self.live.snapshot() if self.live else None,
            "expectation": self.expectation, "achievements": self.achievements,
            "ratings": self.ratings, "avg_rating": round(sum(self.ratings) / len(self.ratings), 1) if self.ratings else None,
            "form": self.form[-5:], "review": getattr(self, "review", None),
            "top_scorers": self.stats.top(10),
            "team_scorers": self.stats.top(5, team=self.team),
            "pending_event": self.pending_event,
            "news": self.news[-6:],
        }


def _top_name(players):
    if not players:
        return None
    return max(players, key=lambda p: p.rating).name
