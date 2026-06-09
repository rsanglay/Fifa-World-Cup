"""Single-match prediction + simulation engine.

Football outcome model grounded in Elo ratings (eloratings.net style) plus a
Poisson goals model. The same primitives drive both:
  * `predict()`  -> analytic win/draw/loss + scoreline probabilities
  * `simulate()` -> one random match result (group or knockout)

Design notes
------------
Elo difference -> win expectancy is the canonical eloratings.net formula. We
convert that to an expected goal supremacy, split a tournament-average total
goal rate around it, and draw goals from independent Poisson distributions.
Knockout matches that finish level go to extra time (a scaled continuation)
and then penalties (a near-coin-flip nudged by team strength).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Optional

import numpy as np

# --- Tuning constants -------------------------------------------------------
# These are HAND-TUNED heuristics, not placeholders. They were calibrated on
# Monte-Carlo output so the favourite's title odds land in a realistic ~20-28%
# band for a 48-team field and single-match scorelines look right (strong-vs-weak
# ~85% win, ~2-0). Changing any of them re-shapes every prediction — re-check the
# odds distribution (GET /api/odds) after editing. See also tournament.py for the
# fatigue + momentum constants.
# Tournament-average goals per match (men's World Cup ~2.5-2.7).
WC_AVG_TOTAL_GOALS = 2.65
# How strongly an Elo edge converts into a goal-supremacy edge. Kept modest so
# single-match upset variance stays realistic (favourites shouldn't run away
# with title odds — a 48-team field tops out around 20-25% for the favourite).
SUPREMACY_SCALE = 0.0018  # goals of supremacy per Elo point
# Home advantage in Elo points, applied only when a team plays in its own
# country (hosts USA / Mexico / Canada). Neutral venues get 0.
HOST_HOME_ADVANTAGE = 75.0
# Floor on a team's expected goals so even huge underdogs can score.
MIN_LAMBDA = 0.18
MAX_GOALS = 9  # scoreline grid cap for the analytic distribution


@dataclass
class TeamStrength:
    """Everything the engine needs to know about a team for one match."""

    code: str
    elo: float
    # Optional per-match Elo delta from lineup selection (manage-a-team mode).
    lineup_delta: float = 0.0

    def effective_elo(self, home_advantage: float = 0.0) -> float:
        return self.elo + self.lineup_delta + home_advantage


def win_expectancy(elo_a: float, elo_b: float) -> float:
    """Probability-like expected score for A vs B from the Elo formula."""
    return 1.0 / (1.0 + 10.0 ** (-(elo_a - elo_b) / 400.0))


def _lambdas(
    home: TeamStrength,
    away: TeamStrength,
    home_advantage: float,
) -> tuple[float, float]:
    """Expected goals for each side."""
    elo_h = home.effective_elo(home_advantage)
    elo_a = away.effective_elo(0.0)
    we = win_expectancy(elo_h, elo_a)
    # Map win expectancy (0..1) onto a goal supremacy, centred at 0.
    supremacy = (we - 0.5) * 2.0 * WC_AVG_TOTAL_GOALS * 0.42
    # Also let a raw Elo gap stretch supremacy a little further.
    supremacy += (elo_h - elo_a) * SUPREMACY_SCALE
    half_total = WC_AVG_TOTAL_GOALS / 2.0
    lam_home = max(MIN_LAMBDA, half_total + supremacy / 2.0)
    lam_away = max(MIN_LAMBDA, half_total - supremacy / 2.0)
    return lam_home, lam_away


def predict(
    home: TeamStrength,
    away: TeamStrength,
    home_advantage: float = 0.0,
) -> Dict[str, float]:
    """Analytic outcome distribution for a single match (regulation time)."""
    lam_home, lam_away = _lambdas(home, away, home_advantage)

    # Poisson pmf grids.
    ks = np.arange(0, MAX_GOALS + 1)
    pmf_home = _poisson_pmf(ks, lam_home)
    pmf_away = _poisson_pmf(ks, lam_away)
    joint = np.outer(pmf_home, pmf_away)  # joint[h, a]

    home_win = float(np.tril(joint, -1).sum())  # h > a
    away_win = float(np.triu(joint, 1).sum())   # a > h
    draw = float(np.trace(joint))               # h == a
    total = home_win + away_win + draw
    # Renormalise for the truncated grid tail.
    home_win, away_win, draw = home_win / total, away_win / total, draw / total

    most_likely = np.unravel_index(int(np.argmax(joint)), joint.shape)
    joint_n = joint / total  # normalised scoreline distribution

    # Goal-market probabilities from the scoreline grid.
    h_idx, a_idx = np.indices(joint_n.shape)
    totals = h_idx + a_idx
    over_25 = float(joint_n[totals >= 3].sum())
    btts = float(joint_n[(h_idx >= 1) & (a_idx >= 1)].sum())

    # Top scorelines.
    flat = sorted(
        ((f"{h}-{a}", float(joint_n[h, a]))
         for h in range(joint_n.shape[0]) for a in range(joint_n.shape[1])),
        key=lambda kv: kv[1], reverse=True,
    )[:6]

    return {
        "home_win": round(home_win, 4),
        "draw": round(draw, 4),
        "away_win": round(away_win, 4),
        "expected_goals_home": round(lam_home, 2),
        "expected_goals_away": round(lam_away, 2),
        "most_likely_score": f"{most_likely[0]}-{most_likely[1]}",
        "over_2_5": round(over_25, 4),
        "under_2_5": round(1.0 - over_25, 4),
        "btts": round(btts, 4),
        "top_scorelines": [{"score": s, "prob": round(p, 4)} for s, p in flat],
    }


_FACTORIAL = np.array([float(math.factorial(k)) for k in range(MAX_GOALS + 1)])


def _poisson_pmf(ks: np.ndarray, lam: float) -> np.ndarray:
    # exp(-lam) * lam^k / k!  over the small fixed grid (no scipy needed).
    return np.exp(-lam) * np.power(lam, ks) / _FACTORIAL


RED_CARD_PROB = 0.055  # per team, per match


@dataclass
class MatchResult:
    home_goals: int
    away_goals: int
    # Knockout-only fields.
    went_extra_time: bool = False
    went_penalties: bool = False
    home_pens: int = 0
    away_pens: int = 0
    # Red-card minute for each side (None if no red card).
    red_home: int | None = None
    red_away: int | None = None

    @property
    def winner(self) -> Optional[str]:
        """'home', 'away', or None for a regulation draw."""
        if self.home_goals > self.away_goals:
            return "home"
        if self.away_goals > self.home_goals:
            return "away"
        if self.went_penalties:
            return "home" if self.home_pens > self.away_pens else "away"
        return None


def simulate(
    home: TeamStrength,
    away: TeamStrength,
    rng: np.random.Generator,
    home_advantage: float = 0.0,
    knockout: bool = False,
) -> MatchResult:
    """Simulate one match. Knockouts always resolve to a winner."""
    lam_home, lam_away = _lambdas(home, away, home_advantage)

    # Red cards: a sending-off late hurts less than an early one, and a defender
    # going off (≈60% of reds) opens you up more than an attacker — the opponent
    # gains more, the carded side's own attack dips less.
    red_home = red_away = None

    def _apply_red(lam_carded, lam_opp, minute):
        share = minute / 90.0
        defender = rng.random() < 0.6
        opp_gain = (0.30 if defender else 0.15) * (1.0 - share)
        own_loss = (0.30 if defender else 0.45)
        lam_carded *= (1.0 - own_loss) + own_loss * share
        lam_opp *= 1.0 + opp_gain
        return lam_carded, lam_opp

    if rng.random() < RED_CARD_PROB:
        red_home = int(rng.integers(20, 90))
        lam_home, lam_away = _apply_red(lam_home, lam_away, red_home)
    if rng.random() < RED_CARD_PROB:
        red_away = int(rng.integers(20, 90))
        lam_away, lam_home = _apply_red(lam_away, lam_home, red_away)

    hg = int(rng.poisson(lam_home))
    ag = int(rng.poisson(lam_away))

    if not knockout or hg != ag:
        return MatchResult(hg, ag, red_home=red_home, red_away=red_away)

    # --- Extra time: 30 mins at ~1/3 the regulation rate. ---
    et_home = int(rng.poisson(lam_home / 3.0))
    et_away = int(rng.poisson(lam_away / 3.0))
    hg += et_home
    ag += et_away
    if hg != ag:
        return MatchResult(hg, ag, went_extra_time=True,
                           red_home=red_home, red_away=red_away)

    # --- Penalties: best-of-5 then sudden death, nudged by strength. ---
    elo_h = home.effective_elo(home_advantage)
    elo_a = away.effective_elo(0.0)
    p_home = 0.5 + (win_expectancy(elo_h, elo_a) - 0.5) * 0.30  # dampened edge
    hp, ap = _shootout(rng, p_home)
    return MatchResult(
        hg, ag, went_extra_time=True, went_penalties=True,
        home_pens=hp, away_pens=ap, red_home=red_home, red_away=red_away,
    )


def _shootout(rng: np.random.Generator, p_home: float) -> tuple[int, int]:
    """Return (home_pens, away_pens), guaranteed unequal."""
    base_conv = 0.75  # average penalty conversion rate
    p_h = base_conv * (p_home / 0.5)
    p_a = base_conv * ((1.0 - p_home) / 0.5)
    p_h, p_a = min(0.95, p_h), min(0.95, p_a)

    hp = ap = 0
    # First five kicks each.
    for _ in range(5):
        hp += int(rng.random() < p_h)
        ap += int(rng.random() < p_a)
    # Sudden death (cap iterations defensively).
    rounds = 0
    while hp == ap and rounds < 20:
        h = int(rng.random() < p_h)
        a = int(rng.random() < p_a)
        hp += h
        ap += a
        rounds += 1
    if hp == ap:  # pathological tie -> nudge by edge
        hp += int(p_home >= 0.5)
        ap += int(p_home < 0.5)
    return hp, ap
