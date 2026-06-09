"""Vectorised tournament Monte-Carlo for live title odds.

Runs all N tournaments at once as numpy array ops (axis 0 = simulation), instead
of a Python loop over individual tournaments. ~100x faster than the per-sim
engine, so odds stay *live* (recomputed each call) yet fast even on a tiny host.

Model: Elo + Poisson goals + host advantage in the groups, with extra-time and a
strength-weighted shootout in the knockouts. Momentum / fatigue / red cards (the
small, sequential effects) are omitted here — they barely move aggregate odds and
don't vectorise cleanly. The detailed per-sim engine keeps them for narrative
playthroughs.
"""
from __future__ import annotations

from typing import Dict, List

import numpy as np

from app.engine.match import (
    HOST_HOME_ADVANTAGE,
    MIN_LAMBDA,
    SUPREMACY_SCALE,
    WC_AVG_TOTAL_GOALS,
)
from app.engine.tournament import GROUPS, R32_PAIRINGS

_HALF = WC_AVG_TOTAL_GOALS / 2.0
_HOST = {"United States": "USA", "USA": "USA", "Mexico": "MEX", "Canada": "CAN"}


def _lambdas(elo_h: np.ndarray, elo_a: np.ndarray):
    """Vectorised expected goals from Elo (matches match.py._lambdas)."""
    we = 1.0 / (1.0 + np.power(10.0, -(elo_h - elo_a) / 400.0))
    supremacy = (we - 0.5) * 2.0 * WC_AVG_TOTAL_GOALS * 0.42 + (elo_h - elo_a) * SUPREMACY_SCALE
    lam_h = np.maximum(MIN_LAMBDA, _HALF + supremacy / 2.0)
    lam_a = np.maximum(MIN_LAMBDA, _HALF - supremacy / 2.0)
    return lam_h, lam_a


def _play(rng, elo_h, elo_a, lam_h, lam_a, knockout: bool):
    """Vectorised match: returns (home_goals, away_goals, home_wins_bool)."""
    hg = rng.poisson(lam_h)
    ag = rng.poisson(lam_a)
    home_wins = hg > ag
    if not knockout:
        return hg, ag, home_wins, (hg == ag)
    tie = hg == ag
    if tie.any():
        eth = rng.poisson(lam_h / 3.0)
        eta = rng.poisson(lam_a / 3.0)
        hg = np.where(tie, hg + eth, hg)
        ag = np.where(tie, ag + eta, ag)
        home_wins = hg > ag
        still = hg == ag
        if still.any():
            we = 1.0 / (1.0 + np.power(10.0, -(elo_h - elo_a) / 400.0))
            p_home = 0.5 + (we - 0.5) * 0.30
            pen_home = rng.random(hg.shape) < p_home
            home_wins = np.where(still, pen_home, home_wins)
    return hg, ag, home_wins, np.zeros_like(home_wins)


def monte_carlo_fast(
    data, n: int = 10000, seed: int | None = None,
    elo_overrides: dict | None = None, fixed_results: dict | None = None,
) -> dict:
    """Vectorised odds.

    `elo_overrides` (code -> Elo delta) nudges a team's strength — used for
    manage-mode lineup effects. `fixed_results` (group match_no -> (hg, ag)) pins
    known/real results — used for the What-If Lab.
    """
    rng = np.random.default_rng(seed)
    elo_overrides = elo_overrides or {}
    fixed_results = fixed_results or {}
    codes = list(data.teams.keys())
    idx = {c: i for i, c in enumerate(codes)}
    T = len(codes)
    elo = np.array([float(data.teams[c]["elo"]) + float(elo_overrides.get(c, 0.0))
                    for c in codes])

    members = {g: [] for g in GROUPS}
    for c, t in data.teams.items():
        members[t["group"]].append(idx[c])

    points = np.zeros((n, T)); gf = np.zeros((n, T)); ga = np.zeros((n, T))

    # ---- Group stage (host advantage applied; lambdas are per-fixture consts) ----
    for g in GROUPS:
        for fx in data.group_fixtures.get(g, []):
            h, a = idx[fx["home"]], idx[fx["away"]]
            pin = fixed_results.get(fx.get("match_no"))
            if pin is not None:
                hg = np.full(n, int(pin[0])); ag = np.full(n, int(pin[1]))
            else:
                host = _HOST.get(fx.get("country", ""))
                adv = (HOST_HOME_ADVANTAGE if host == fx["home"]
                       else -0.4 * HOST_HOME_ADVANTAGE if host == fx["away"] else 0.0)
                lam_h, lam_a = _lambdas(np.array(elo[h] + adv), np.array(elo[a]))
                hg = rng.poisson(lam_h, n); ag = rng.poisson(lam_a, n)
            gf[:, h] += hg; ga[:, h] += ag; gf[:, a] += ag; ga[:, a] += hg
            hw = hg > ag; dr = hg == ag; aw = hg < ag
            points[:, h] += 3 * hw + dr
            points[:, a] += 3 * aw + dr

    gd = gf - ga
    key = points * 1e7 + (gd + 200.0) * 1e3 + gf  # composite sort key per team

    # ---- Group placings + best 8 thirds ----
    slot: Dict[str, np.ndarray] = {}
    third_idx = np.empty((n, 12), dtype=int)
    third_key = np.empty((n, 12))
    for gi, g in enumerate(GROUPS):
        cols = np.array(members[g])              # 4 team indices
        order = np.argsort(-key[:, cols], axis=1)  # (n,4) positions
        ranked = cols[order]                     # (n,4) team idx sorted
        slot[f"{g}1"] = ranked[:, 0]
        slot[f"{g}2"] = ranked[:, 1]
        third_idx[:, gi] = ranked[:, 2]
        third_key[:, gi] = np.take_along_axis(key[:, cols], order[:, 2:3], axis=1)[:, 0]

    best = np.argsort(-third_key, axis=1)[:, :8]   # (n,8) group positions of top thirds
    for s in range(8):
        slot[f"T{s+1}"] = np.take_along_axis(third_idx, best[:, s:s+1], axis=1)[:, 0]

    rows = np.arange(n)
    reached = {r: np.zeros((n, T), dtype=bool) for r in ("R32", "R16", "QF", "SF", "F")}

    # ---- Round of 32 participants from the bracket template ----
    part = np.empty((n, 32), dtype=int)
    for i, (sh, sa) in enumerate(R32_PAIRINGS):
        part[:, 2 * i] = slot[sh]
        part[:, 2 * i + 1] = slot[sa]

    for rnd in ("R32", "R16", "QF", "SF", "F"):
        m = part.shape[1] // 2
        reached[rnd][rows[:, None], part] = True
        home = part[:, 0::2]; away = part[:, 1::2]
        eh, ea = elo[home], elo[away]
        lam_h, lam_a = _lambdas(eh, ea)
        _, _, hw, _ = _play(rng, eh, ea, lam_h, lam_a, knockout=True)
        winners = np.where(hw, home, away)          # (n, m)
        part = winners
    champion = part[:, 0]                            # (n,)

    title = np.zeros(T);
    np.add.at(title, champion, 1)

    teams: List[dict] = []
    for c in codes:
        i = idx[c]
        teams.append({
            "code": c, "name": data.teams[c].get("name", c),
            "group": data.teams[c].get("group"), "elo": data.teams[c].get("elo"),
            "fifa_ranking": data.teams[c].get("fifa_ranking"),
            "p_round_of_32": round(float(reached["R32"][:, i].mean()), 4),
            "p_round_of_16": round(float(reached["R16"][:, i].mean()), 4),
            "p_quarter": round(float(reached["QF"][:, i].mean()), 4),
            "p_semi": round(float(reached["SF"][:, i].mean()), 4),
            "p_final": round(float(reached["F"][:, i].mean()), 4),
            "p_title": round(float(title[i] / n), 4),
        })
    teams.sort(key=lambda s: s["p_title"], reverse=True)
    return {"simulations": n, "teams": teams}
