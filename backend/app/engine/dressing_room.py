"""Dressing-room events & press conferences between rounds (career mode).

After a round, a small decision card may appear: a benched star sulking, the
press writing you off, a fan-favourite chasing a milestone. Each choice nudges
player morale (via SquadCondition) and/or team momentum — small, bounded
effects with real trade-offs. Pure flavour with teeth.

Each template returns an event dict:
  {"id", "title", "body", "player_id"?, "options": [{"key","label","hint"}]}
and `apply(...)` maps (event, choice) -> effects + a one-line outcome string.
"""
from __future__ import annotations

from typing import List, Optional

from app.engine.tournament import update_momentum

EVENT_CHANCE = 0.65          # chance a card appears after a round (when eligible)
MOMENTUM_NUDGE = 8.0         # team-level momentum swing from a strong call


def maybe_generate(rng, squad, xi_ids: List[str], condition, form: List[str],
                   names: dict, next_opp: Optional[str]) -> Optional[dict]:
    """Roll for a between-rounds event. Returns an event dict or None."""
    if rng.random() > EVENT_CHANCE:
        return None
    pool = []
    bench = [p for p in squad if p.id not in xi_ids]
    star_benched = max(bench, key=lambda p: p.rating, default=None)
    if star_benched and star_benched.rating >= 80:
        pool.append(("bench_star", star_benched))
    if form and form[-1] == "L":
        pool.append(("press_doubt", None))
    if form and len(form) >= 2 and form[-2:] == ["W", "W"]:
        pool.append(("high_spirits", None))
    tired = [p for p in squad
             if p.id in xi_ids and condition.c.get(p.id, {}).get("fatigue", 0) >= 55]
    if tired:
        pool.append(("tired_leader", max(tired, key=lambda p: p.rating)))
    if next_opp:
        pool.append(("media_bait", None))
    if not pool:
        return None
    kind, player = pool[int(rng.integers(len(pool)))]
    opp_name = names.get(next_opp, "your next opponent") if next_opp else "the next match"
    return _build(kind, player, opp_name)


def _build(kind: str, player, opp_name: str) -> dict:
    if kind == "bench_star":
        return {
            "id": kind, "player_id": player.id, "player_name": player.name,
            "title": "Star on the bench",
            "body": (f"{player.name} trained away from the group today and told "
                     f"reporters he “expects to start every match for his country”."),
            "options": [
                {"key": "back", "label": "Back him publicly",
                 "hint": "His morale jumps — the XI who played may feel snubbed."},
                {"key": "discipline", "label": "Lay down the law",
                 "hint": "The group tightens up; the star sulks."},
                {"key": "defuse", "label": "Defuse with a joke",
                 "hint": "Nothing changes much, nobody is hurt."},
            ],
        }
    if kind == "press_doubt":
        return {
            "id": kind, "player_id": None, "player_name": None,
            "title": "The press smell blood",
            "body": ("This morning's back pages call your side “flattering to "
                     "deceive”. The squad has seen the headlines."),
            "options": [
                {"key": "fire_up", "label": "Pin it on the wall",
                 "hint": "Use it as fuel — momentum up, but pressure rises."},
                {"key": "shield", "label": "Shield the squad",
                 "hint": "Take the criticism yourself. Calm, steady."},
            ],
        }
    if kind == "high_spirits":
        return {
            "id": kind, "player_id": None, "player_name": None,
            "title": "The camp is buzzing",
            "body": ("Two wins on the spin and the players want a night off "
                     "team curfew to celebrate."),
            "options": [
                {"key": "allow", "label": "Let them celebrate",
                 "hint": "Morale soars; legs may be heavier."},
                {"key": "focus", "label": "Stay locked in",
                 "hint": "No distractions — but the buzz fades."},
            ],
        }
    if kind == "tired_leader":
        return {
            "id": kind, "player_id": player.id, "player_name": player.name,
            "title": "Heavy legs in the engine room",
            "body": (f"The medical staff flag {player.name} as carrying serious "
                     f"fatigue. He insists he's fine and wants to play."),
            "options": [
                {"key": "trust", "label": "Trust the player",
                 "hint": "His morale holds, his body might not."},
                {"key": "protect", "label": "Promise him a rest",
                 "hint": "Costs you his match sharpness, recovers his legs."},
            ],
        }
    # media_bait
    return {
        "id": "media_bait", "player_id": None, "player_name": None,
        "title": "Bulletin-board material",
        "body": (f"A pundit from {opp_name}'s TV coverage called your team "
                 f"“the weakest side left in the draw”."),
        "options": [
            {"key": "bite", "label": "Fire back in the presser",
             "hint": "The squad loves it — and the match gets spicier."},
            {"key": "ignore", "label": "“We let football talk”",
             "hint": "Professional. No swing either way."},
        ],
    }


def apply(event: dict, choice: str, condition, momentum: dict, team: str,
          xi_ids: List[str]) -> str:
    """Apply a choice's effects. Returns a one-line outcome for the news log."""
    pid = event.get("player_id")
    name = event.get("player_name") or "The player"
    eid, key = event.get("id"), choice

    if eid == "bench_star":
        if key == "back":
            condition.nudge_morale([pid], +14)
            condition.nudge_morale(xi_ids, -3)
            return f"You backed {name} publicly — he beams; a few starters grumble."
        if key == "discipline":
            condition.nudge_morale([pid], -10)
            condition.nudge_all_morale(+3)
            update_momentum(momentum, team, MOMENTUM_NUDGE * 0.5)
            return f"You laid down the law. {name} sulks; the group walks taller."
        condition.nudge_morale([pid], +3)
        return "You defused it with a joke. Storm in a teacup."
    if eid == "press_doubt":
        if key == "fire_up":
            condition.nudge_all_morale(+5)
            update_momentum(momentum, team, MOMENTUM_NUDGE)
            return "Headlines on the dressing-room wall. The lads are snarling."
        condition.nudge_all_morale(+2)
        return "You took the bullets yourself. The squad noticed."
    if eid == "high_spirits":
        if key == "allow":
            condition.nudge_all_morale(+8)
            for st in condition.c.values():
                st["fatigue"] = min(100.0, st["fatigue"] + 6.0)
            return "A night off curfew. Spirits sky-high, a few heavy heads."
        condition.nudge_all_morale(-2)
        update_momentum(momentum, team, MOMENTUM_NUDGE * 0.4)
        return "Curfew held. All business."
    if eid == "tired_leader":
        if key == "trust":
            condition.nudge_morale([pid], +8)
            return f"{name} starts if selected — heart over hamstrings."
        if pid in condition.c:
            condition.c[pid]["fatigue"] = max(0.0, condition.c[pid]["fatigue"] - 25.0)
            condition.c[pid]["sharpness"] = max(30.0, condition.c[pid]["sharpness"] - 6.0)
        condition.nudge_morale([pid], -4)
        return f"You promised {name} a rest. Fresh legs, slightly fewer minutes."
    if eid == "media_bait":
        if key == "bite":
            condition.nudge_all_morale(+4)
            update_momentum(momentum, team, MOMENTUM_NUDGE * 0.7)
            return "You bit back. The squad loved every word."
        return "You let football do the talking."
    return "Noted."
