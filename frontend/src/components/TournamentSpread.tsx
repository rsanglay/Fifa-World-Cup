import type { OddsRow } from "../types";

/* "How far do you usually get?" — turns the round-reach probabilities (from
   running the chosen XI through thousands of tournaments) into an exit-stage
   distribution, so you see the most likely outcome and the spread, not one run. */
const STAGES: { key: string; label: string }[] = [
  { key: "group", label: "Group exit" },
  { key: "R32", label: "Lost R32" },
  { key: "R16", label: "Lost R16" },
  { key: "QF", label: "Lost QF" },
  { key: "SF", label: "Lost semi" },
  { key: "final", label: "Runner-up" },
  { key: "win", label: "🏆 Champions" },
];

export default function TournamentSpread({ odds }: { odds: OddsRow }) {
  const dist: Record<string, number> = {
    group: 1 - odds.p_round_of_32,
    R32: odds.p_round_of_32 - odds.p_round_of_16,
    R16: odds.p_round_of_16 - odds.p_quarter,
    QF: odds.p_quarter - odds.p_semi,
    SF: odds.p_semi - odds.p_final,
    final: odds.p_final - odds.p_title,
    win: odds.p_title,
  };
  const max = Math.max(...Object.values(dist), 0.001);
  const modal = STAGES.reduce((a, b) => (dist[b.key] > dist[a.key] ? b : a), STAGES[0]);

  return (
    <div className="card p-4">
      <div className="mb-1 font-display text-lg tracking-wide text-gold">HOW FAR YOU USUALLY GET</div>
      <p className="mb-3 text-xs text-white/40">
        Your chosen XI run through {odds ? "thousands of" : ""} tournaments. Most likely:
        <span className="ml-1 font-semibold text-white/80">{modal.label}</span>.
      </p>
      <div className="space-y-1.5">
        {STAGES.map((s) => {
          const v = Math.max(0, dist[s.key]);
          const isModal = s.key === modal.key;
          return (
            <div key={s.key} className="flex items-center gap-2 text-sm">
              <span className="w-24 shrink-0 text-right text-xs text-white/50">{s.label}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-ink">
                <div
                  className={`h-full rounded ${s.key === "win" ? "bg-gold" : isModal ? "bg-gradient-to-r from-pitch to-emerald-400" : "bg-white/25"}`}
                  style={{ width: `${(v / max) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs tabular-nums text-white/70">{(v * 100).toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
