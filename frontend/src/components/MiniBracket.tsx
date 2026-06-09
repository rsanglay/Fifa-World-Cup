import { flag } from "../api/client";
import type { KnockoutMatch } from "../types";

/* Compact, progressively-revealed knockout bracket (R16 -> Final) for the
   cinematic. A round's scores show only once that round has been played in the
   playthrough; future rounds show TBD so nothing is spoiled. */
const ORDER = ["R16", "QF", "SF", "F"];
const TITLE: Record<string, string> = { R16: "Round of 16", QF: "Quarters", SF: "Semis", F: "Final" };

function Side({ code, goals, pens, isWinner, names }: {
  code: string | null; goals: number | null; pens: number | null; isWinner: boolean; names: Record<string, string>;
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1.5 py-1 ${isWinner ? "font-bold text-white" : "text-white/50"}`}>
      <span className="text-sm">{code ? flag(code) : "·"}</span>
      <span className="flex-1 truncate text-[11px]">{code ? names[code] || code : "TBD"}</span>
      <span className="tabular-nums text-[11px]">{goals ?? ""}</span>
      {pens != null && <span className="text-[9px] text-gold">({pens})</span>}
    </div>
  );
}

export default function MiniBracket({
  knockout, revealed, names,
}: {
  knockout: KnockoutMatch[];
  revealed: Set<string>;
  names: Record<string, string>;
}) {
  const byRound = (r: string) => knockout.filter((m) => m.round === r).sort((a, b) => a.match_no - b.match_no);

  return (
    <div className="card overflow-x-auto p-3">
      <div className="flex min-w-max gap-3">
        {ORDER.map((r, ri) => {
          const matches = byRound(r);
          const roundShown = revealed.has(r);
          const prevShown = ri === 0 || revealed.has(ORDER[ri - 1]);
          return (
            <div key={r} className="flex w-36 flex-col">
              <div className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-gold">{TITLE[r]}</div>
              <div className="flex flex-1 flex-col justify-around gap-2">
                {matches.map((m) => {
                  // Show teams once we know them (this round, or feeding round, revealed).
                  const showTeams = roundShown || prevShown;
                  const showScore = roundShown && m.home_goals != null;
                  return (
                    <div key={m.match_no} className="overflow-hidden rounded-lg border border-white/10 bg-ink/40">
                      <Side code={showTeams ? m.home : null} goals={showScore ? m.home_goals : null}
                        pens={showScore && m.penalties ? m.home_pens ?? null : null}
                        isWinner={showScore && m.winner === m.home} names={names} />
                      <div className="h-px bg-white/10" />
                      <Side code={showTeams ? m.away : null} goals={showScore ? m.away_goals : null}
                        pens={showScore && m.penalties ? m.away_pens ?? null : null}
                        isWinner={showScore && m.winner === m.away} names={names} />
                    </div>
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
