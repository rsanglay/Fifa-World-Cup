import type { LiveStats } from "../../types";

/* Bottom HUD bar: minute | score | animated possession bar | shots on/off
 * target | corners. FM-dark glass over the pitch. */
export default function HUDBar({
  minute, phase, homeGoals, awayGoals, home, away, stats,
}: {
  minute: number;
  phase: string;
  homeGoals: number;
  awayGoals: number;
  home: string;
  away: string;
  stats: LiveStats | null;
}) {
  const poss = stats?.possession || { home: 50, away: 50 };
  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
        <span className="font-display text-2xl tabular-nums text-txt-primary">{minute}'</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-txt-secondary">{phase}</span>
      </div>

      <div className="font-display text-2xl tabular-nums">
        <span className="text-txt-primary">{home}</span>
        <span className="mx-2 text-accent">{homeGoals}:{awayGoals}</span>
        <span className="text-txt-primary">{away}</span>
      </div>

      {/* possession: animated split bar */}
      <div className="flex min-w-[180px] flex-1 items-center gap-2">
        <span className="w-7 text-right font-mono text-xs tabular-nums text-txt-primary">{poss.home}%</span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-accent"
            style={{ width: `${poss.home}%`, transition: "width 600ms ease" }} />
        </div>
        <span className="w-7 font-mono text-xs tabular-nums text-txt-secondary">{poss.away}%</span>
      </div>

      <Stat label="Shots" a={stats?.shots.home ?? 0} b={stats?.shots.away ?? 0} />
      <Stat label="On target" a={stats?.on_target.home ?? 0} b={stats?.on_target.away ?? 0} />
      <Stat label="Corners" a={stats?.corners.home ?? 0} b={stats?.corners.away ?? 0} />
    </div>
  );
}

function Stat({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <div className="text-center">
      <div className="font-mono text-sm tabular-nums text-txt-primary">{a} – {b}</div>
      <div className="text-[9px] uppercase tracking-wider text-txt-secondary">{label}</div>
    </div>
  );
}
