import { flag } from "../api/client";
import type { KnockoutMatch } from "../types";

const ROUND_TITLES: Record<string, string> = {
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  F: "Final",
};
const ORDER = ["R32", "R16", "QF", "SF", "F"];

function Side({
  code,
  goals,
  pens,
  isWinner,
  names,
}: {
  code: string | null;
  goals: number | null;
  pens: number | null;
  isWinner: boolean;
  names: Record<string, string>;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 ${
        isWinner ? "font-bold text-white" : "text-white/55"
      }`}
    >
      <span className="text-base">{code ? flag(code) : "•"}</span>
      <span className="flex-1 truncate text-xs">{code ? names[code] || code : "TBD"}</span>
      <span className="tabular-nums text-xs">{goals ?? "-"}</span>
      {pens != null && <span className="text-[10px] text-gold">({pens})</span>}
    </div>
  );
}

export default function Bracket({
  knockout,
  names,
  onOpen,
}: {
  knockout: KnockoutMatch[];
  names: Record<string, string>;
  onOpen?: (m: KnockoutMatch) => void;
}) {
  const byRound = (r: string) =>
    knockout.filter((m) => m.round === r).sort((a, b) => a.match_no - b.match_no);

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex min-w-max gap-4">
        {ORDER.map((r) => {
          const matches = byRound(r);
          return (
            <div key={r} className="flex w-52 flex-col">
              <div className="mb-2 text-center text-xs font-semibold uppercase tracking-wider text-gold">
                {ROUND_TITLES[r]}
              </div>
              <div className="flex flex-1 flex-col justify-around gap-3">
                {matches.map((m) => (
                  <div
                    key={m.match_no}
                    onClick={() => onOpen && m.home && onOpen(m)}
                    className={`card overflow-hidden ${onOpen && m.home ? "cursor-pointer transition hover:border-gold/40" : ""}`}
                  >
                    <Side
                      code={m.home}
                      goals={m.home_goals}
                      pens={m.penalties ? m.home_pens : null}
                      isWinner={m.winner === m.home}
                      names={names}
                    />
                    <div className="h-px bg-white/10" />
                    <Side
                      code={m.away}
                      goals={m.away_goals}
                      pens={m.penalties ? m.away_pens : null}
                      isWinner={m.winner === m.away}
                      names={names}
                    />
                    {(m.extra_time || m.penalties) && (
                      <div className="bg-ink/60 px-2 py-0.5 text-center text-[9px] text-white/40">
                        {m.penalties ? "after penalties" : "after extra time"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
