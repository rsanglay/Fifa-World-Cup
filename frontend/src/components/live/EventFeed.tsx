import type { ChainEvent } from "../../types";

/* Left sidebar (240px): scrollable headline match log, newest at top.
 * ⚽ goal · 🟡 yellow · 🔴 red · ↕️ sub · 🩹 injury · ⚑ tactical change */

function icon(e: ChainEvent): string {
  switch (e.type) {
    case "goal": return "⚽";
    case "yellow": return "🟡";
    case "red": return "🔴";
    case "sub": return "↕️";
    case "injury": return "🩹";
    case "tactic":
    case "OPP_TACTICAL_CHANGE": return "⚑";
    case "chance": return e.outcome === "saved" ? "🧤" : e.outcome === "woodwork" ? "🥅" : "❌";
    case "penalty_miss": return e.outcome === "saved" ? "🧤" : "❌";
    case "pens": return "🎯";
    default: return "•";
  }
}

function label(e: ChainEvent, names: Record<string, string>): string {
  const team = names[e.team] || e.team;
  const who = e.scorer || e.player || team;
  switch (e.type) {
    case "goal":
      return e.source === "penalty" ? `PENALTY GOAL! ${who} (${team})`
        : e.source === "freekick" ? `FREE KICK GOAL! ${who} (${team})`
        : `GOAL! ${who} (${team})${e.assist ? ` — assist ${e.assist}` : ""}`;
    case "chance":
      return e.outcome === "saved" ? `${who}'s effort is saved`
        : e.outcome === "woodwork" ? `${who} rattles the woodwork`
        : `${who} fires wide`;
    case "penalty_miss":
      return e.outcome === "saved" ? `PENALTY SAVED! ${who} denied` : `PENALTY MISSED! ${who}`;
    case "yellow": return `${who} is booked`;
    case "red": return `RED CARD — ${who} (${team})`;
    case "sub": return `Sub: ${who} on for ${e.assist || "…"}`;
    case "injury": return `${who} is injured${e.severity ? ` (${e.severity})` : ""}`;
    case "tactic":
    case "OPP_TACTICAL_CHANGE":
      return `${team}: ${e.detail || e.reason || "tactical change"}`;
    case "pens": return `Shoot-out: ${who}`;
    default: return who;
  }
}

export default function EventFeed({
  feed, names, ourTeam,
}: {
  feed: ChainEvent[];
  names: Record<string, string>;
  ourTeam: string;
}) {
  return (
    <aside className="card flex h-full flex-col overflow-hidden" style={{ width: 240, minWidth: 240 }}>
      <div className="border-b border-white/10 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-txt-secondary">
        Match events
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {feed.length === 0 && (
          <div className="px-1 py-2 text-xs text-txt-secondary">Kick-off…</div>
        )}
        {feed.map((e, i) => (
          <div key={`${e.minute}-${e.type}-${e.player_id || e.scorer_id || i}-${i}`}
            className={`flex items-start gap-1.5 rounded-lg px-1.5 py-1 text-xs leading-snug ${
              e.type === "goal" ? "bg-accent/10" : ""} ${
              e.team === ourTeam ? "text-txt-primary" : "text-txt-secondary"}`}>
            <span className="w-6 shrink-0 text-right font-mono text-[10px] text-txt-secondary">{e.minute}'</span>
            <span className="shrink-0">{icon(e)}</span>
            <span className="min-w-0">{label(e, names)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
