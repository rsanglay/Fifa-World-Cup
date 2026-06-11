"""Positional stamina model + effective-rating maths.

Per-position decay per game-minute of play (FM-style: full-backs and wingers
cover the most ground, keepers barely move). Mentality scales every OUTFIELD
rate: attacking football costs more legs, a low defensive block preserves
them. Effective on-pitch rating combines base rating, match form and stamina:

    effective = base * (0.85 + 0.15 * form) * (0.4 + 0.6 * stamina / 100)

so a cooked player (stamina 0) plays at 40% of his rating and a full-form,
fresh player at 100%.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

# Stamina points lost per game-minute, by on-pitch role.
DECAY_RATES: Dict[str, float] = {
    "GK": 0.05, "CB": 0.10, "LB": 0.22, "RB": 0.22,
    "DM": 0.18, "CM": 0.20, "AM": 0.22,
    "LW": 0.25, "RW": 0.25, "CF": 0.20,
}
MENTALITY_STAMINA = {"attacking": 1.15, "balanced": 1.0, "defensive": 0.90}
DEFAULT_FORM = 0.7

# Resting x per role (attacking left -> right, own goal at x=0).
ROLE_X: Dict[str, float] = {
    "GK": 5.0, "LB": 22.0, "CB": 17.0, "RB": 22.0,
    "DM": 34.0, "CM": 45.0, "AM": 57.0,
    "LW": 70.0, "RW": 70.0, "CF": 78.0,
}

# Role templates per positional group size.
_DEF_ROLES = {1: ["CB"], 2: ["CB", "CB"], 3: ["CB", "CB", "CB"],
              4: ["LB", "CB", "CB", "RB"], 5: ["LB", "CB", "CB", "CB", "RB"]}
_MID_ROLES = {1: ["CM"], 2: ["DM", "CM"], 3: ["DM", "CM", "AM"],
              4: ["DM", "CM", "CM", "AM"], 5: ["DM", "DM", "CM", "AM", "AM"]}
_FWD_ROLES = {1: ["CF"], 2: ["CF", "CF"], 3: ["LW", "CF", "RW"],
              4: ["LW", "CF", "CF", "RW"]}


def effective_rating(base: float, stamina: float, form: float = DEFAULT_FORM,
                     cond: float = 1.0) -> float:
    """Live rating of one player given stamina (0-100) and form (0-1)."""
    return (base * cond
            * (0.85 + 0.15 * max(0.0, min(1.0, form)))
            * (0.4 + 0.6 * max(0.0, min(100.0, stamina)) / 100.0))


def decay_for(role: str, mentality: str) -> float:
    """Stamina lost this minute for one player (before tactical multipliers)."""
    base = DECAY_RATES.get(role, 0.20)
    if role == "GK":
        return base                       # mentality scales outfield only
    return base * MENTALITY_STAMINA.get(mentality, 1.0)


def assign_roles(players: List) -> Dict[str, str]:
    """Map player_id -> on-pitch role from the XI's positional groups.

    Squad data only carries GK/DEF/MID/FWD; the formation shape decides who
    plays full-back vs centre-back, DM vs AM, winger vs striker.
    """
    groups: Dict[str, List] = {"GK": [], "DEF": [], "MID": [], "FWD": []}
    for p in players:
        groups.setdefault(p.position, []).append(p)
    roles: Dict[str, str] = {}
    for pos, template in (("DEF", _DEF_ROLES), ("MID", _MID_ROLES), ("FWD", _FWD_ROLES)):
        ps = groups.get(pos, [])
        tmpl = template.get(len(ps))
        if tmpl is None:                       # odd shape (red card etc.)
            tmpl = (template[max(template)] * 2)[: len(ps)]
        for p, role in zip(ps, tmpl):
            roles[p.id] = role
    for p in groups.get("GK", []):
        roles[p.id] = "GK"
    return roles


def formation_slots(players: List, roles: Dict[str, str]) -> Dict[str, Tuple[float, float]]:
    """Resting (x, y) per player_id in attack-left-to-right coordinates."""
    rows: Dict[str, List] = {"GK": [], "DEF": [], "MID": [], "FWD": []}
    for p in players:
        rows.setdefault(p.position, []).append(p)
    out: Dict[str, Tuple[float, float]] = {}
    for pos, ps in rows.items():
        n = len(ps)
        for i, p in enumerate(ps):
            role = roles.get(p.id, "CM")
            y = 50.0 if n == 1 else 12.0 + (i / (n - 1)) * 76.0
            out[p.id] = (ROLE_X.get(role, 45.0), y)
    return out
