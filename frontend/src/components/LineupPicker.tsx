import { useMemo } from "react";
import type { Player } from "../types";

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3],
  "4-4-2": [4, 4, 2],
  "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2],
  "3-4-3": [3, 4, 3],
  "5-3-2": [5, 3, 2],
  "5-4-1": [5, 4, 1],
};

const POS_LABEL: Record<string, string> = {
  GK: "Goalkeeper",
  DEF: "Defenders",
  MID: "Midfielders",
  FWD: "Forwards",
};

export default function LineupPicker({
  squad,
  selected,
  formation,
  onToggle,
  onFormation,
}: {
  squad: Player[];
  selected: string[];
  formation: string;
  onToggle: (id: string) => void;
  onFormation: (f: string) => void;
}) {
  const [d, m, f] = FORMATIONS[formation];
  const need: Record<string, number> = { GK: 1, DEF: d, MID: m, FWD: f };

  const byPos = useMemo(() => {
    const g: Record<string, Player[]> = { GK: [], DEF: [], MID: [], FWD: [] };
    squad.forEach((p) => g[p.position]?.push(p));
    Object.values(g).forEach((arr) => arr.sort((a, b) => b.rating - a.rating));
    return g;
  }, [squad]);

  const selCount = (pos: string) =>
    selected.filter((id) => squad.find((p) => p.id === id)?.position === pos).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-white/60">Formation:</span>
        {Object.keys(FORMATIONS).map((fm) => (
          <button
            key={fm}
            onClick={() => onFormation(fm)}
            className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
              formation === fm ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            {fm}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(["GK", "DEF", "MID", "FWD"] as const).map((pos) => {
          const full = selCount(pos) >= need[pos];
          return (
            <div key={pos} className="card p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold">{POS_LABEL[pos]}</span>
                <span className={`text-xs ${full ? "text-gold" : "text-white/40"}`}>
                  {selCount(pos)}/{need[pos]}
                </span>
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {byPos[pos].map((p) => {
                  const on = selected.includes(p.id);
                  const blocked = !on && full;
                  return (
                    <button
                      key={p.id}
                      disabled={blocked}
                      onClick={() => onToggle(p.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                        on
                          ? "bg-pitch/40 ring-1 ring-pitch"
                          : blocked
                          ? "cursor-not-allowed opacity-30"
                          : "bg-ink/50 hover:bg-white/10"
                      }`}
                    >
                      <span className="w-6 text-center text-xs text-white/40">
                        {p.number || ""}
                      </span>
                      <span className="flex-1 truncate">{p.name}</span>
                      {p.club && (
                        <span className="hidden truncate text-[10px] text-white/30 sm:block">
                          {p.club}
                        </span>
                      )}
                      <span className="w-7 rounded bg-ink px-1 text-center text-xs font-bold tabular-nums text-gold">
                        {p.rating}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
