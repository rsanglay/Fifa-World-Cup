"""Squad + lineup model for manage-a-team mode.

A user controlling one team picks a starting XI (and bench) from a 26-player
squad. The selected XI is scored against that squad's *optimal* XI; the gap is
converted into an Elo delta that feeds straight into the match engine via
`TeamStrength.lineup_delta`. Pick your best team and you play at full strength;
rest your stars and you concede an edge.

Squads are real player names + positions (data-driven from squads.json) with
ratings modelled from team strength. When squad data is missing for a team we
fall back to a deterministic procedural squad so the feature always works.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional

POSITIONS = ["GK", "DEF", "MID", "FWD"]
# Position weights when scoring an XI (spine matters most).
POS_WEIGHT = {"GK": 1.1, "DEF": 1.0, "MID": 1.05, "FWD": 1.0}
# Valid outfield shapes (DEF-MID-FWD), all summing to 10.
FORMATIONS = {
    "4-3-3": (4, 3, 3), "4-4-2": (4, 4, 2), "3-5-2": (3, 5, 2),
    "4-2-3-1": (4, 5, 1), "3-4-3": (3, 4, 3), "5-3-2": (5, 3, 2),
    "5-4-1": (5, 4, 1), "4-5-1": (4, 5, 1),
}
# Rating points -> Elo points (one average-rating point on the XI ≈ this Elo).
RATING_TO_ELO = 16.0
SQUAD_SIZE = 26


@dataclass
class Player:
    id: str
    name: str
    position: str   # GK / DEF / MID / FWD
    rating: int     # 1-99 overall
    club: str = ""
    number: int = 0
    # Bio / stats (modelled from importance + position when not real data).
    age: int = 26
    caps: int = 0
    goals: int = 0
    assists: int = 0
    market_value: float = 0.0  # € millions
    tier: str = "rotation"
    photo_url: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def model_player_stats(
    name: str, position: str, rating: int, tier: str, real_age: int | None = None
) -> dict:
    """Deterministic, believable bio/stats for a player.

    Real squad data gives us name/position/club/tier (and a real birth year where
    Wikipedia had one). Caps, goals and value are modelled so each profile card is
    plausible and stable (same player always yields the same numbers). Forwards
    score more; keepers barely; stars rack up caps. These are indicative, not
    official career records.
    """
    h = abs(hash(f"{name}:{position}"))
    tier_caps = {"star": 78, "starter": 46, "rotation": 22, "fringe": 8}
    base_caps = tier_caps.get(tier, 22)
    caps = max(1, base_caps + (h % 34) - 14)
    age = real_age if real_age is not None else 21 + (h // 7 % 15)  # 21-35
    goal_rate = {"FWD": 0.42, "MID": 0.18, "DEF": 0.05, "GK": 0.0}[position]
    assist_rate = {"FWD": 0.20, "MID": 0.24, "DEF": 0.08, "GK": 0.0}[position]
    star_mult = 1.5 if tier == "star" else 1.0
    goals = int(caps * goal_rate * star_mult * (0.7 + (h % 50) / 100))
    assists = int(caps * assist_rate * (0.7 + (h // 3 % 50) / 100))
    # Market value (€M): rises steeply with rating, peaks ~age 24, decays late,
    # and gets a lift from goal involvement — so equal-rated stars still differ.
    base_value = max(0.3, (max(0.0, rating - 55) ** 2.55) / 110.0)
    age_factor = max(0.35, 1.0 - abs(age - 24) * 0.055)
    involve_factor = 1.0 + (goals + assists) / 240.0
    value = round(base_value * age_factor * involve_factor, 1)
    return {
        "age": age, "caps": caps, "goals": goals, "assists": assists,
        "market_value": value, "tier": tier,
    }


def elo_to_base_rating(elo: float) -> float:
    """Map a team Elo (~1400-2150) onto an average squad rating (~62-90)."""
    lo, hi = 1400.0, 2150.0
    frac = max(0.0, min(1.0, (elo - lo) / (hi - lo)))
    return 62.0 + frac * 28.0


def generate_squad(code: str, elo: float) -> List[Player]:
    """Deterministic procedural 26-man squad, used when no real data exists."""
    import random

    rng = random.Random(f"{code}:{int(elo)}")
    base = elo_to_base_rating(elo)
    # GK, DEF, MID, FWD counts for a 26-man squad.
    counts = {"GK": 3, "DEF": 8, "MID": 9, "FWD": 6}
    players: List[Player] = []
    number = 1
    for pos in POSITIONS:
        n = counts[pos]
        # First players in each position are starters (higher rated).
        for depth in range(n):
            depth_penalty = depth * (2.6 if depth < 3 else 3.4)
            rating = base + rng.uniform(-2.5, 4.5) - depth_penalty
            rating = int(max(48, min(94, round(rating))))
            tier = ("star" if depth == 0 and rating >= 85 else
                    "starter" if depth < 2 else
                    "rotation" if depth < 4 else "fringe")
            name = f"{code} {pos}{depth+1}"
            stats = model_player_stats(name, pos, rating, tier)
            players.append(Player(
                id=f"{code}-{pos}-{depth+1}",
                name=name, position=pos, rating=rating, number=number, **stats,
            ))
            number += 1
    return players


def best_xi(squad: List[Player], formation: str = "4-3-3") -> List[Player]:
    """Highest-rated valid XI for a formation."""
    d, m, f = FORMATIONS.get(formation, FORMATIONS["4-3-3"])
    need = {"GK": 1, "DEF": d, "MID": m, "FWD": f}
    by_pos: Dict[str, List[Player]] = {p: [] for p in POSITIONS}
    for pl in squad:
        by_pos.setdefault(pl.position, []).append(pl)
    chosen: List[Player] = []
    for pos, k in need.items():
        ranked = sorted(by_pos.get(pos, []), key=lambda p: p.rating, reverse=True)
        chosen.extend(ranked[:k])
    return chosen


def _xi_score(xi: List[Player]) -> float:
    if not xi:
        return 0.0
    total = sum(p.rating * POS_WEIGHT.get(p.position, 1.0) for p in xi)
    weight = sum(POS_WEIGHT.get(p.position, 1.0) for p in xi)
    return total / weight


def optimal_score(squad: List[Player]) -> float:
    """Best achievable XI score across all formations (full-strength baseline)."""
    return max(_xi_score(best_xi(squad, f)) for f in FORMATIONS)


def validate_xi(xi: List[Player]) -> tuple[bool, str]:
    if len(xi) != 11:
        return False, f"A starting XI needs 11 players (got {len(xi)})."
    gks = sum(1 for p in xi if p.position == "GK")
    if gks != 1:
        return False, f"Exactly 1 goalkeeper required (got {gks})."
    d = sum(1 for p in xi if p.position == "DEF")
    m = sum(1 for p in xi if p.position == "MID")
    f = sum(1 for p in xi if p.position == "FWD")
    if (d, m, f) not in FORMATIONS.values():
        return False, f"Shape {d}-{m}-{f} is not a valid formation."
    if d < 3:
        return False, "At least 3 defenders required."
    return True, "ok"


def lineup_delta(squad: List[Player], selected_ids: List[str]) -> Dict[str, object]:
    """Elo delta (and diagnostics) for a chosen XI vs the squad's optimum."""
    by_id = {p.id: p for p in squad}
    xi = [by_id[i] for i in selected_ids if i in by_id]
    ok, msg = validate_xi(xi)
    baseline = optimal_score(squad)
    if not ok:
        return {"valid": False, "message": msg, "elo_delta": -250.0,
                "xi_score": 0.0, "baseline_score": round(baseline, 2)}
    score = _xi_score(xi)
    delta = (score - baseline) * RATING_TO_ELO
    # An XI can't really exceed the modelled optimum; cap the upside at 0.
    delta = min(0.0, max(-300.0, delta))
    shape = (
        sum(1 for p in xi if p.position == "DEF"),
        sum(1 for p in xi if p.position == "MID"),
        sum(1 for p in xi if p.position == "FWD"),
    )
    return {
        "valid": True, "message": "ok",
        "elo_delta": round(delta, 1),
        "xi_score": round(score, 2),
        "baseline_score": round(baseline, 2),
        "formation": f"{shape[0]}-{shape[1]}-{shape[2]}",
        "strength_pct": round(100.0 * score / baseline, 1) if baseline else 0.0,
    }
