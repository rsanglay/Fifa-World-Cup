"""Multiplayer World Cup: one shared tournament, several human managers.

Friends create a room, each picks a nation (or drafts one), and the whole
48-team tournament advances round by round once EVERY manager has submitted
a lineup + mentality. All 12 groups play matchday-by-matchday, so any number
of humans can be in any group — including the same one.

When two human teams meet the round HOLDS and the fixture becomes a live
head-to-head grudge match (`live_h2h.py`) that both managers play out minute
by minute over a WebSocket; every other match in the round is simulated
instantly and revealed when the live match finishes.

Also in the room: per-player condition (sharpness/fatigue/morale) so squad
rotation matters, injuries and suspensions that carry between rounds, a
tournament-wide Golden Boot race, an optional draft lobby, host-set round
deadlines with auto-pick for no-shows, a trash-talk feed, and spectator
predictions so eliminated managers stay in the game.
"""
from __future__ import annotations

import time
from collections import OrderedDict, defaultdict
from typing import Dict, List, Optional

import numpy as np

from app.engine.condition import SquadCondition
from app.engine.live_h2h import H2HLiveMatch, Side
from app.engine.managed import (
    KO_LABEL,
    KO_ROUNDS,
    MENTALITY,
    SCORE_W,
    YELLOW_PROB,
    YELLOWS_FOR_BAN,
)
from app.engine.match import (
    RED_CARD_PROB,
    TeamStrength,
    _lambdas,
    _shootout,
    win_expectancy,
)
from app.engine.squad import best_xi, lineup_delta, validate_xi
from app.engine.stats import StatsTracker
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

MAX_PLAYERS = 12
MAX_CHAT = 100
CHAT_SHOWN = 40
INJURY_KNOCK_PROB = 0.10        # post-round random knock for instant-simmed matches
LIVE_STALE_SECONDS = 120.0      # nobody connected -> auto-resolve the grudge match


class MultiplayerRoom:
    def __init__(self, code: str, data, all_squads, seed: Optional[int] = None,
                 draft: bool = False, deadline_minutes: int = 0,
                 live_h2h: bool = True):
        self.code = code
        self.data = data
        self.all_squads = all_squads
        self.rng = np.random.default_rng(seed)
        self.base_elo = {c: float(t["elo"]) for c, t in data.teams.items()}
        self.names = {c: t["name"] for c, t in data.teams.items()}

        self.phase = "lobby"  # lobby | draft | group | knockout | done
        self.managers: "OrderedDict[str, dict]" = OrderedDict()
        self.momentum: Dict[str, float] = {}
        self.last_played: Dict[str, str] = {}

        self.members: Dict[str, List[str]] = defaultdict(list)
        for c, t in data.teams.items():
            self.members[t["group"]].append(c)
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
        self.runner_up: Optional[str] = None

        self.submissions: Dict[str, dict] = {}
        self.last_round_results: List[dict] = []
        self.h2h: List[dict] = []
        self.suspended: Dict[str, Dict[str, int]] = defaultdict(dict)
        self.yellows: Dict[str, Dict[str, int]] = defaultdict(dict)
        self.injured: Dict[str, Dict[str, int]] = defaultdict(dict)
        self.conditions: Dict[str, SquadCondition] = {}
        self.stats = StatsTracker(all_squads, self.names)

        # Options.
        self.draft = bool(draft)
        self.draft_order: List[str] = []
        self.draft_pos = 0
        self.deadline_minutes = max(0, int(deadline_minutes or 0))
        self.round_deadline: Optional[float] = None
        self.live_h2h_enabled = bool(live_h2h)

        # Social.
        self.messages: List[dict] = []
        self.round_predictions: Dict[str, Dict[str, str]] = defaultdict(dict)
        self.round_matches: List[dict] = []     # predictable fixtures this round

        # Live grudge matches currently holding the round.
        self.live_matches: Dict[str, dict] = {}
        self.held_results: List[dict] = []
        self._live_teams_this_round: set = set()

    # ------------------------------------------------------------------ lobby
    @property
    def human_teams(self) -> Dict[str, dict]:
        return {m["team"]: m for m in self.managers.values() if m["team"]}

    def join(self, token: str, name: str, team: Optional[str], host: bool = False) -> None:
        if self.phase != "lobby":
            raise ValueError("This tournament has already kicked off.")
        if len(self.managers) >= MAX_PLAYERS:
            raise ValueError(f"Room is full ({MAX_PLAYERS} managers max).")
        if self.draft:
            team = None          # teams are assigned by the draft
        else:
            team = (team or "").upper()
            if team not in self.data.teams:
                raise KeyError(f"Unknown team code: {team}")
            if team in self.human_teams:
                raise ValueError(f"{self.names[team]} is already managed by "
                                 f"{self.human_teams[team]['name']}.")
        name = (name or "").strip()[:24] or f"Manager {len(self.managers) + 1}"
        if any(m["name"].lower() == name.lower() for m in self.managers.values()):
            raise ValueError(f"The name “{name}” is taken in this room.")
        self.managers[token] = {
            "token": token, "name": name, "team": team, "host": host,
            "alive": True, "eliminated_round": None, "form": [],
            "pred_points": 0,
        }

    def switch_team(self, token: str, team: str) -> None:
        if self.phase != "lobby":
            raise ValueError("Teams are locked once the tournament starts.")
        if self.draft:
            raise ValueError("This is a draft room — teams are picked in the draft.")
        mgr = self._mgr(token)
        team = team.upper()
        if team not in self.data.teams:
            raise KeyError(f"Unknown team code: {team}")
        taken = {t: m for t, m in self.human_teams.items() if m["token"] != token}
        if team in taken:
            raise ValueError(f"{self.names[team]} is already managed by {taken[team]['name']}.")
        mgr["team"] = team

    def start(self, token: str) -> None:
        mgr = self._mgr(token)
        if not mgr["host"]:
            raise ValueError("Only the host can start the tournament.")
        if self.phase != "lobby":
            raise ValueError("Already started.")
        if self.draft:
            self.phase = "draft"
            order = list(self.managers)
            self.rng.shuffle(order)
            self.draft_order = order
            self.draft_pos = 0
        else:
            self._begin_tournament()

    def draft_pick(self, token: str, team: str) -> None:
        if self.phase != "draft":
            raise ValueError("No draft is running.")
        mgr = self._mgr(token)
        if self.draft_order[self.draft_pos] != token:
            on_clock = self.managers[self.draft_order[self.draft_pos]]["name"]
            raise ValueError(f"It is {on_clock}'s pick.")
        team = team.upper()
        if team not in self.data.teams:
            raise KeyError(f"Unknown team code: {team}")
        if team in self.human_teams:
            raise ValueError(f"{self.names[team]} has already been drafted.")
        mgr["team"] = team
        self.draft_pos += 1
        self._chat_system(f"{mgr['name']} drafts {self.names[team]} {team}")
        if self.draft_pos >= len(self.draft_order):
            self._begin_tournament()

    def _begin_tournament(self) -> None:
        for team in self.human_teams:
            self.conditions[team] = SquadCondition(self.all_squads.get(team, []))
        self.phase = "group"
        self._open_round()

    def _mgr(self, token: str) -> dict:
        mgr = self.managers.get(token)
        if mgr is None:
            raise KeyError("You are not in this room (bad or expired token).")
        return mgr

    # ------------------------------------------------------------- round flow
    def _open_round(self) -> None:
        """A new round awaits lineups: list its matches, arm the deadline."""
        self.round_matches = [
            {"key": str(m["match_no"]), "home": m["home"], "away": m["away"],
             "stage": m["label"]}
            for m in self._matches_this_round()]
        self.round_predictions = defaultdict(dict)
        self.round_deadline = (time.time() + self.deadline_minutes * 60
                               if self.deadline_minutes else None)

    def _matches_this_round(self) -> List[dict]:
        out = []
        if self.phase == "group":
            for g in sorted(self.matchdays):
                for fx in self.matchdays[g][self.md_index]:
                    out.append({"kind": "group", "home": fx["home"], "away": fx["away"],
                                "date": fx.get("date"), "country": fx.get("country", ""),
                                "knockout": False, "label": "groups",
                                "match_no": fx.get("match_no"), "ref": fx})
        elif self.phase == "knockout":
            rnd = KO_ROUNDS[self.ko_round_idx]
            for km in self.cur_round:
                out.append({"kind": "ko", "home": km.home, "away": km.away,
                            "date": km.meta.get("date"),
                            "country": km.meta.get("country", ""),
                            "knockout": True, "label": rnd,
                            "match_no": km.match_no, "ref": km})
        return out

    def _pending_teams(self) -> List[str]:
        if self.live_matches:
            return []           # round is being decided on the pitch
        if self.phase == "group":
            need = [m["team"] for m in self.managers.values() if m["alive"]]
        elif self.phase == "knockout":
            in_round = {km.home for km in self.cur_round} | {km.away for km in self.cur_round}
            need = [m["team"] for m in self.managers.values()
                    if m["alive"] and m["team"] in in_round]
        else:
            return []
        return [t for t in need if t not in self.submissions]

    def check_deadline(self) -> None:
        """Lazy deadline enforcement: auto-pick best XIs for no-shows."""
        if (self.round_deadline is None or time.time() < self.round_deadline
                or self.phase not in ("group", "knockout") or self.live_matches):
            return
        for team in list(self._pending_teams()):
            self.submissions[team] = {"xi": self._auto_xi(team),
                                      "mentality": "balanced", "auto": True}
            self._chat_system(f"⏰ Deadline — {self.human_teams[team]['name']}'s "
                              f"XI was auto-picked.")
        if not self._pending_teams():
            self._play_round()

    def _auto_xi(self, team: str) -> List[str]:
        banned = {pid for pid, n in self.suspended[team].items() if n > 0}
        banned |= {pid for pid, n in self.injured[team].items() if n > 0}
        avail = [p for p in self.all_squads.get(team, []) if p.id not in banned]
        return [p.id for p in best_xi(avail)]

    def submit(self, token: str, xi_ids: List[str], mentality: str = "balanced") -> None:
        self.check_deadline()
        mgr = self._mgr(token)
        if self.phase not in ("group", "knockout"):
            raise ValueError("No round is awaiting lineups right now.")
        if self.live_matches:
            raise ValueError("A live grudge match is deciding this round.")
        team = mgr["team"]
        if not mgr["alive"]:
            raise ValueError("You are out of the tournament — spectating only.")
        if team in self.submissions:
            raise ValueError("You have already submitted for this round.")
        if team not in self._pending_teams():
            raise ValueError("No lineup is needed from you right now.")
        squad = self.all_squads.get(team, [])
        by_id = {p.id: p for p in squad}
        unknown = [i for i in xi_ids if i not in by_id]
        if unknown:
            raise ValueError(f"Unknown player ids: {', '.join(unknown[:3])}")
        banned = [by_id[i].name for i in xi_ids if self.suspended[team].get(i, 0) > 0]
        if banned:
            raise ValueError(f"Suspended and cannot play: {', '.join(banned)}.")
        crocked = [by_id[i].name for i in xi_ids if self.injured[team].get(i, 0) > 0]
        if crocked:
            raise ValueError(f"Injured and cannot play: {', '.join(crocked)}.")
        ok, msg = validate_xi([by_id[i] for i in xi_ids])
        if not ok:
            raise ValueError(msg)
        if mentality not in MENTALITY:
            mentality = "balanced"
        self.submissions[team] = {"xi": list(xi_ids), "mentality": mentality}
        if not self._pending_teams():
            self._play_round()

    # ------------------------------------------------------------ predictions
    def predict(self, token: str, picks: Dict[str, str]) -> None:
        """Spectator predictions: call results for matches you are NOT in."""
        self.check_deadline()
        mgr = self._mgr(token)
        if self.phase not in ("group", "knockout"):
            raise ValueError("Nothing to predict right now.")
        valid_keys = {m["key"]: m for m in self.round_matches}
        for key, pick in picks.items():
            m = valid_keys.get(str(key))
            if m is None:
                continue
            if mgr["team"] in (m["home"], m["away"]):
                continue        # no self-prophecies
            if pick in ("H", "D", "A"):
                self.round_predictions[token][str(key)] = pick

    def _score_predictions(self, results: List[dict]) -> None:
        outcomes: Dict[str, str] = {}
        for md in results:
            key = str(md.get("match_no"))
            if md["winner"] is None:
                outcomes[key] = "D"
            else:
                outcomes[key] = "H" if md["winner"] == md["home"] else "A"
        for token, picks in self.round_predictions.items():
            mgr = self.managers.get(token)
            if not mgr:
                continue
            gained = sum(1 for k, p in picks.items() if outcomes.get(k) == p)
            if gained:
                mgr["pred_points"] += gained

    # ------------------------------------------------------------------- chat
    def post_chat(self, token: str, text: str) -> None:
        mgr = self._mgr(token)
        text = (text or "").strip()[:200]
        if not text:
            raise ValueError("Say something.")
        self.messages.append({"name": mgr["name"], "team": mgr["team"],
                              "text": text, "ts": time.time(),
                              "round_no": self.round_no, "system": False})
        del self.messages[:-MAX_CHAT]

    def _chat_system(self, text: str) -> None:
        self.messages.append({"name": "", "team": None, "text": text,
                              "ts": time.time(), "round_no": self.round_no,
                              "system": True})
        del self.messages[:-MAX_CHAT]

    # ---------------------------------------------------------- match engine
    def _xi_players(self, team: str) -> list:
        sub = self.submissions.get(team)
        if sub:
            by = {p.id: p for p in self.all_squads.get(team, [])}
            line = [by[i] for i in sub["xi"] if i in by]
            if len(line) == 11:
                return line
        return best_xi(self.all_squads.get(team, []))

    def _gen_events(self, team, players, goals, lo, hi) -> List[dict]:
        if goals <= 0 or not players:
            return []
        w = np.array([SCORE_W.get(p.position, 1.0) * (p.rating / 80.0) for p in players])
        w = w / w.sum()
        mins = sorted(int(m) for m in self.rng.integers(lo, hi + 1, size=int(goals)))
        out = []
        for k in range(int(goals)):
            pl = players[int(self.rng.choice(len(players), p=w))]
            out.append({"type": "goal", "minute": mins[k], "team": team,
                        "scorer": pl.name, "scorer_id": pl.id,
                        "position": pl.position, "assist": None})
        return out

    def _team_strengths(self, home: str, away: str, date, country):
        humans = self.human_teams
        sh = TeamStrength(home, self.base_elo[home])
        sa = TeamStrength(away, self.base_elo[away])
        for ts in (sh, sa):
            sub = self.submissions.get(ts.code) if ts.code in humans else None
            if sub:
                squad = self.all_squads.get(ts.code, [])
                ld = float(lineup_delta(squad, sub["xi"]).get("elo_delta", 0.0))
                cond = self.conditions.get(ts.code)
                if cond:
                    ld += cond.xi_elo_delta(sub["xi"])
                ts.lineup_delta = ld
        h_adv = (_home_adv(home, away, country)
                 + _net_fatigue_adv(home, away, date, self.last_played)
                 + _momentum_adv(home, away, self.momentum))
        return sh, sa, h_adv

    def _sim_match(self, m: dict) -> dict:
        """Instant simulation of one match, honouring human lineups + mentality."""
        home, away = m["home"], m["away"]
        date, country, knockout = m["date"], m["country"], m["knockout"]
        humans = self.human_teams
        sh, sa, h_adv = self._team_strengths(home, away, date, country)
        lh, la = _lambdas(sh, sa, h_adv)
        h_own, h_opp = MENTALITY.get(self._mentality_of(home), (1.0, 1.0))
        a_own, a_opp = MENTALITY.get(self._mentality_of(away), (1.0, 1.0))
        lh, la = lh * h_own * a_opp, la * a_own * h_opp

        hg = int(self.rng.poisson(lh))
        ag = int(self.rng.poisson(la))
        any_human = home in humans or away in humans
        events: List[dict] = []
        if any_human:
            events += self._gen_events(home, self._xi_players(home), hg, 1, 90)
            events += self._gen_events(away, self._xi_players(away), ag, 1, 90)

        penalties = False
        hp = ap = None
        if knockout and hg == ag:
            et_h = int(self.rng.poisson(lh / 3.0))
            et_a = int(self.rng.poisson(la / 3.0))
            if any_human:
                events += self._gen_events(home, self._xi_players(home), et_h, 91, 120)
                events += self._gen_events(away, self._xi_players(away), et_a, 91, 120)
            hg += et_h
            ag += et_a
            if hg == ag:
                penalties = True
                p_home = 0.5 + (win_expectancy(
                    sh.effective_elo(h_adv), sa.effective_elo(0.0)) - 0.5) * 0.30
                hp, ap = _shootout(self.rng, p_home)

        winner = None
        if hg > ag or (penalties and (hp or 0) > (ap or 0)):
            winner = home
        elif ag > hg or (penalties and (ap or 0) > (hp or 0)):
            winner = away

        reds: Dict[str, Optional[int]] = {home: None, away: None}
        for side in (home, away):
            if self.rng.random() < RED_CARD_PROB:
                reds[side] = int(self.rng.integers(20, 90))
                if any_human:
                    events.append({"type": "red", "minute": reds[side], "team": side})
        events.sort(key=lambda e: e["minute"])

        # Stats: real events for human matches, sampled scorers otherwise.
        if any_human:
            self.stats.decorate_assists(self.rng, events,
                                        {home: self._xi_players(home),
                                         away: self._xi_players(away)})
            self.stats.add_goal_events(events)
        else:
            self.stats.sample_goals(self.rng, home, hg)
            self.stats.sample_goals(self.rng, away, ag)

        md = {"round": m["label"], "match_no": m.get("match_no"),
              "home": home, "away": away,
              "home_goals": hg, "away_goals": ag, "penalties": penalties,
              "home_pens": hp, "away_pens": ap, "winner": winner, "date": date,
              "events": events,
              "home_manager": humans.get(home, {}).get("name"),
              "away_manager": humans.get(away, {}).get("name")}

        self._apply_result(md, knockout)
        self._post_match_human(home, md, reds[home])
        self._post_match_human(away, md, reds[away])
        if home in humans and away in humans:
            self.h2h.append(md)
        if m["kind"] == "ko":
            km = m["ref"]
            km.winner_code = winner
            km.loser_code = away if winner == home else home
        return md

    def _apply_result(self, md: dict, knockout: bool) -> None:
        home, away = md["home"], md["away"]
        hg, ag, winner = md["home_goals"], md["away_goals"], md["winner"]
        if not knockout:
            self.group_records[home].apply(away, hg, ag)
            self.group_records[away].apply(home, ag, hg)
            _apply_result_momentum(self.momentum, home, away, hg, ag)
        else:
            loser = away if winner == home else home
            update_momentum(self.momentum, winner, MOMENTUM_WIN)
            update_momentum(self.momentum, loser, -MOMENTUM_WIN)
        if md["date"]:
            self.last_played[home] = md["date"]
            self.last_played[away] = md["date"]

    def _mentality_of(self, team: str) -> str:
        sub = self.submissions.get(team)
        return sub["mentality"] if sub else "balanced"

    def _post_match_human(self, team: str, md: dict, red_minute: Optional[int]) -> None:
        """Form, discipline, condition and knocks for an instant-simmed match."""
        if team not in self.human_teams:
            return
        mgr = self.human_teams[team]
        won = md["winner"] == team
        drew = md["winner"] is None
        mgr["form"].append("W" if won else "D" if drew else "L")
        xi = self.submissions.get(team, {}).get("xi", [])
        cond = self.conditions.get(team)
        if cond:
            cond.after_round(xi, None if drew else won)
        susp, yel, inj = self.suspended[team], self.yellows[team], self.injured[team]
        for store in (susp, inj):
            for pid in list(store):
                store[pid] -= 1
                if store[pid] <= 0:
                    del store[pid]
        for pid in xi:
            if self.rng.random() < YELLOW_PROB:
                yel[pid] = yel.get(pid, 0) + 1
                if yel[pid] >= YELLOWS_FOR_BAN:
                    susp[pid] = 1
                    yel[pid] = 0
        if red_minute is not None and xi:
            susp[xi[int(self.rng.integers(len(xi)))]] = 1
        if xi and self.rng.random() < INJURY_KNOCK_PROB:
            pid = xi[int(self.rng.integers(len(xi)))]
            inj[pid] = int(self.rng.integers(1, 3))
            by = {p.id: p for p in self.all_squads.get(team, [])}
            if pid in by:
                self._chat_system(f"🏥 {by[pid].name} ({self.names[team]}) picked up "
                                  f"a knock — out {inj[pid]} match(es).")

    # ------------------------------------------------------------ round play
    def _play_round(self) -> None:
        matches = self._matches_this_round()
        humans = self.human_teams
        grudges = [m for m in matches
                   if self.live_h2h_enabled
                   and m["home"] in humans and m["away"] in humans]
        instant = [m for m in matches if m not in grudges]
        results = [self._sim_match(m) for m in instant]
        if grudges:
            self.held_results = results
            self._live_teams_this_round = set()
            for m in grudges:
                self._start_live_match(m)
            self._chat_system("🔥 GRUDGE MATCH — the round is decided live on the pitch!")
            return
        self._complete_round(results)

    def _start_live_match(self, m: dict) -> None:
        home, away = m["home"], m["away"]
        sh, sa, h_adv = self._team_strengths(home, away, m["date"], m["country"])

        def make_side(team: str) -> Side:
            banned = {pid for pid, n in self.suspended[team].items() if n > 0}
            banned |= {pid for pid, n in self.injured[team].items() if n > 0}
            squad = [p for p in self.all_squads.get(team, []) if p.id not in banned]
            sub = self.submissions.get(team, {})
            cond = self.conditions.get(team)
            return Side(team, self.human_teams[team]["name"], squad,
                        sub.get("xi", [p.id for p in best_xi(squad)]),
                        sub.get("mentality", "balanced"),
                        cond.multipliers() if cond else None)

        key = str(m["match_no"])
        self.live_matches[key] = {
            "match": H2HLiveMatch(self.rng, make_side(home), make_side(away),
                                  m["knockout"], sh, sa, h_adv, m["date"]),
            "meta": m,
            "tokens": {"home": self.human_teams[home]["token"],
                       "away": self.human_teams[away]["token"]},
            "created": time.time(),
            "started": False,
        }
        self._live_teams_this_round |= {home, away}

    # ------------------------------------------------------------- live plumbing
    def live_entry(self, key: str) -> dict:
        entry = self.live_matches.get(str(key))
        if entry is None:
            raise KeyError("No live match with that id.")
        return entry

    def live_side_for(self, key: str, token: str) -> Optional[str]:
        entry = self.live_entry(key)
        for side, tok in entry["tokens"].items():
            if tok == token:
                return side
        return None

    def finalize_live_match(self, key: str) -> None:
        """A grudge match reached FT: bank everything it produced."""
        entry = self.live_matches.pop(str(key), None)
        if entry is None:
            return
        lm: H2HLiveMatch = entry["match"]
        m = entry["meta"]
        humans = self.human_teams
        md = lm.result_md(m["label"], {k: humans.get(lm.sides[k].code, {}).get("name")
                                       for k in ("home", "away")})
        md["match_no"] = m.get("match_no")
        self._apply_result(md, m["knockout"])
        if m["kind"] == "ko":
            km = m["ref"]
            km.winner_code = md["winner"]
            km.loser_code = md["away"] if md["winner"] == md["home"] else md["home"]
        for side_key in ("home", "away"):
            side = lm.sides[side_key]
            team = side.code
            mgr = humans.get(team)
            if not mgr:
                continue
            won = md["winner"] == team
            drew = md["winner"] is None
            mgr["form"].append("W" if won else "D" if drew else "L")
            cond = self.conditions.get(team)
            if cond:
                cond.after_round(side.played_ids, None if drew else won)
            susp, yel, inj = self.suspended[team], self.yellows[team], self.injured[team]
            for store in (susp, inj):
                for pid in list(store):
                    store[pid] -= 1
                    if store[pid] <= 0:
                        del store[pid]
            for pid in side.yellow_ids:
                yel[pid] = yel.get(pid, 0) + 1
                if yel[pid] >= YELLOWS_FOR_BAN:
                    susp[pid] = 1
                    yel[pid] = 0
            for pid in side.red_ids:
                susp[pid] = 1
                yel[pid] = 0
            for pid in side.injured_ids:
                inj[pid] = int(self.rng.integers(1, 3))
        self.stats.add_goal_events(md["events"])
        self.h2h.append(md)
        self.held_results.append(md)
        self._chat_system(
            f"📣 FT {self.names[md['home']]} {md['home_goals']}–{md['away_goals']} "
            f"{self.names[md['away']]}"
            + (f" ({md['home_pens']}–{md['away_pens']} pens)" if md["penalties"] else ""))
        if not self.live_matches:
            held, self.held_results = self.held_results, []
            self._complete_round(held)

    def resolve_stale_live(self) -> None:
        """Nobody is playing a held grudge match — let the engine finish it.

        Two stale shapes: never-started (no manager ever connected) and
        abandoned mid-match (ticker stopped because everyone disconnected).
        Both auto-resolve after LIVE_STALE_SECONDS so a round can never
        deadlock the whole room.
        """
        now = time.time()
        for key, entry in list(self.live_matches.items()):
            last = entry.get("last_tick") or entry["created"]
            if now - last < LIVE_STALE_SECONDS:
                continue
            lm: H2HLiveMatch = entry["match"]
            while not lm.done:
                lm.tick(5)
            self.finalize_live_match(key)

    # --------------------------------------------------------- round complete
    def _complete_round(self, results: List[dict]) -> None:
        self.last_round_results = results
        self._score_predictions(results)
        self.submissions = {}
        self._live_teams_this_round = set()
        self.round_no += 1
        if self.phase == "group":
            self.md_index += 1
            if self.md_index >= 3:
                self._finish_group_stage()
        elif self.phase == "knockout":
            self._advance_knockout()
        if (self.phase == "knockout"
                and not any(m["alive"] for m in self.managers.values())):
            # All humans out: fast-forward the rest of the bracket instantly.
            self._complete_round([self._sim_match(m) for m in self._matches_this_round()])
            return
        if self.phase in ("group", "knockout"):
            self._open_round()

    def _finish_group_stage(self) -> None:
        tables = {g: _sort_group([self.group_records[c] for c in codes])
                  for g, codes in self.members.items()}
        self.group_tables = tables
        slot_map, _ = _resolve_qualifiers(tables)
        qualified = set(slot_map.values())
        for mgr in self.managers.values():
            if mgr["team"] not in qualified:
                mgr["alive"] = False
                mgr["eliminated_round"] = "groups"
        self.phase = "knockout"
        self.ko_round_idx = 0
        self.cur_round = [KnockoutMatch(73 + i, "R32", home=slot_map.get(s_h),
                                        away=slot_map.get(s_a), meta=self._meta_for(73 + i))
                          for i, (s_h, s_a) in enumerate(R32_PAIRINGS)]

    def _advance_knockout(self) -> None:
        rnd = KO_ROUNDS[self.ko_round_idx]
        losers = {km.loser_code for km in self.cur_round}
        for mgr in self.managers.values():
            if mgr["alive"] and mgr["team"] in losers:
                mgr["alive"] = False
                mgr["eliminated_round"] = rnd
        if rnd == "F":
            self.champion = self.cur_round[0].winner_code
            self.runner_up = self.cur_round[0].loser_code
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

    # --------------------------------------------------------------- payload
    def _next_fixture_for(self, team: str) -> Optional[dict]:
        humans = self.human_teams
        for m in self._matches_this_round():
            if team in (m["home"], m["away"]):
                opp = m["away"] if m["home"] == team else m["home"]
                g = self.data.teams[team]["group"]
                stage = (f"Group {g} · Matchday {self.md_index + 1}"
                         if m["kind"] == "group" else KO_LABEL[m["label"]])
                return {"stage": stage, "opponent": opp, "date": m["date"],
                        "venue": (m["ref"].get("venue") if m["kind"] == "group"
                                  else m["ref"].meta.get("venue")),
                        "home": m["home"] == team,
                        "opp_manager": humans.get(opp, {}).get("name")}
        return None

    def _squad_payload(self, team: str) -> List[dict]:
        susp, yel, inj = self.suspended[team], self.yellows[team], self.injured[team]
        cond = self.conditions.get(team)
        out = []
        for p in self.all_squads.get(team, []):
            row = {"id": p.id, "name": p.name, "position": p.position,
                   "number": p.number, "rating": p.rating, "club": p.club,
                   "photo_url": getattr(p, "photo_url", ""),
                   "suspended": susp.get(p.id, 0) > 0, "yellows": yel.get(p.id, 0),
                   "injured": inj.get(p.id, 0) > 0,
                   "injured_rounds": inj.get(p.id, 0)}
            if cond:
                row.update(cond.payload(p.id))
            out.append(row)
        return out

    def _table_payload(self, g: str) -> List[dict]:
        if self.group_tables:
            return [r.as_dict() for r in self.group_tables[g]]
        return [r.as_dict() for r in _sort_group([self.group_records[c] for c in self.members[g]])]

    def _standings(self) -> List[dict]:
        order = {"groups": 0, "R32": 1, "R16": 2, "QF": 3, "SF": 4, "F": 5}
        rows = []
        for m in self.managers.values():
            if not m["team"]:
                continue
            if self.champion == m["team"]:
                progress, rank = "Champions 🏆", 100
            elif m["team"] == self.runner_up:
                progress, rank = "Runners-up", 50
            elif m["alive"]:
                progress = ("In the group stage" if self.phase == "group"
                            else f"In the {KO_LABEL[KO_ROUNDS[self.ko_round_idx]]}"
                            if self.phase == "knockout" else "Alive")
                rank = 40
            else:
                progress = ("Out in the group stage" if m["eliminated_round"] == "groups"
                            else f"Out in the {KO_LABEL.get(m['eliminated_round'], m['eliminated_round'])}")
                rank = order.get(m["eliminated_round"], 0)
            rows.append({"name": m["name"], "team": m["team"],
                         "team_name": self.names[m["team"]], "alive": m["alive"],
                         "progress": progress, "form": m["form"][-5:],
                         "pred_points": m["pred_points"], "_rank": rank})
        rows.sort(key=lambda r: (r["_rank"], r["pred_points"]), reverse=True)
        for r in rows:
            del r["_rank"]
        return rows

    def _draft_payload(self, token: str) -> Optional[dict]:
        if not self.draft:
            return None
        on_clock = (self.draft_order[self.draft_pos]
                    if self.phase == "draft" and self.draft_pos < len(self.draft_order)
                    else None)
        return {
            "active": self.phase == "draft",
            "order": [self.managers[t]["name"] for t in self.draft_order],
            "position": self.draft_pos,
            "on_clock": self.managers[on_clock]["name"] if on_clock else None,
            "your_turn": on_clock == token,
            "taken": sorted(self.human_teams),
        }

    def _live_payload(self, token: str) -> List[dict]:
        out = []
        for key, entry in self.live_matches.items():
            lm: H2HLiveMatch = entry["match"]
            side = self.live_side_for(key, token)
            out.append({"key": key, "home": lm.sides["home"].code,
                        "away": lm.sides["away"].code,
                        "home_manager": lm.sides["home"].manager,
                        "away_manager": lm.sides["away"].manager,
                        "minute": lm.minute, "home_goals": lm.hg,
                        "away_goals": lm.ag, "done": lm.done,
                        "your_side": side, "started": entry["started"]})
        return out

    def state(self, token: str) -> dict:
        self.check_deadline()
        self.resolve_stale_live()
        mgr = self._mgr(token)
        team = mgr["team"]
        g = self.data.teams[team]["group"] if team else None
        humans = set(self.human_teams)
        pending = self._pending_teams()
        waiting_on = [self.human_teams[t]["name"] for t in pending]

        def relevant(md):
            return (md["home"] in humans or md["away"] in humans
                    or md["round"] != "groups"
                    or (g and self.data.teams[md["home"]]["group"] == g))
        last_round = [md for md in self.last_round_results if relevant(md)]

        predictable = [m for m in self.round_matches
                       if team not in (m["home"], m["away"])] \
            if self.phase in ("group", "knockout") and not self.live_matches else []

        return {
            "code": self.code, "phase": self.phase, "round_no": self.round_no,
            "matchday": self.md_index + 1 if self.phase == "group" else None,
            "ko_round": (KO_ROUNDS[self.ko_round_idx] if self.phase == "knockout" else None),
            "ko_label": (KO_LABEL[KO_ROUNDS[self.ko_round_idx]] if self.phase == "knockout" else None),
            "players": [{"name": m["name"], "team": m["team"],
                         "team_name": self.names.get(m["team"]) if m["team"] else None,
                         "host": m["host"],
                         "alive": m["alive"], "eliminated_round": m["eliminated_round"],
                         "submitted": bool(m["team"]) and m["team"] in self.submissions,
                         "pred_points": m["pred_points"],
                         "is_you": m["token"] == token}
                        for m in self.managers.values()],
            "waiting_on": waiting_on,
            "you": {
                "name": mgr["name"], "team": team,
                "team_name": self.names.get(team) if team else None,
                "group": g, "host": mgr["host"], "alive": mgr["alive"],
                "eliminated_round": mgr["eliminated_round"],
                "submitted": bool(team) and team in self.submissions,
                "needs_lineup": team in pending,
                "squad": self._squad_payload(team) if team else [],
                "next_fixture": (self._next_fixture_for(team)
                                 if team and mgr["alive"] else None),
                "form": mgr["form"][-5:],
                "pred_points": mgr["pred_points"],
                "predictions": dict(self.round_predictions.get(token, {})),
            },
            "group_table": self._table_payload(g) if g else [],
            "last_round": last_round,
            "h2h": self.h2h,
            "standings": self._standings(),
            "bracket": ([{"round": km.round, "home": km.home, "away": km.away,
                          "winner": km.winner_code} for km in self.cur_round]
                        if self.phase in ("knockout", "done") else []),
            "champion": self.champion,
            "champion_name": self.names.get(self.champion) if self.champion else None,
            "champion_manager": self.human_teams.get(self.champion, {}).get("name") if self.champion else None,
            "runner_up": self.runner_up,
            "team_names": self.names,
            "done": self.phase == "done",
            # New surfaces.
            "draft": self._draft_payload(token),
            "chat": self.messages[-CHAT_SHOWN:],
            "deadline_at": self.round_deadline,
            "deadline_minutes": self.deadline_minutes,
            "top_scorers": self.stats.top(10),
            "team_scorers": self.stats.top(5, team=team) if team else [],
            "predictable": predictable,
            "live_h2h": self._live_payload(token),
            "awaiting_live": bool(self.live_matches),
        }

    def preview(self) -> dict:
        return {
            "code": self.code, "phase": self.phase,
            "players": [{"name": m["name"], "team": m["team"],
                         "team_name": self.names.get(m["team"]) if m["team"] else None,
                         "host": m["host"]}
                        for m in self.managers.values()],
            "taken_teams": sorted(self.human_teams),
            "joinable": self.phase == "lobby" and len(self.managers) < MAX_PLAYERS,
            "draft": self.draft,
            "deadline_minutes": self.deadline_minutes,
        }
