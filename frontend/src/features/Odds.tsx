import { useEffect, useState } from "react";
import { api, flag } from "../api/client";
import type { OddsRow } from "../types";

const COLS: { key: keyof OddsRow; label: string }[] = [
  { key: "p_round_of_16", label: "R16" },
  { key: "p_quarter", label: "QF" },
  { key: "p_semi", label: "SF" },
  { key: "p_final", label: "Final" },
  { key: "p_title", label: "Win" },
];

export default function Odds() {
  const [rows, setRows] = useState<OddsRow[]>([]);
  const [sims, setSims] = useState(5000);
  const [loading, setLoading] = useState(true);

  const load = (n: number) => {
    setLoading(true);
    api.odds(n).then((d) => {
      setRows(d.teams);
      setLoading(false);
    });
  };
  useEffect(() => load(sims), []); // eslint-disable-line

  const max = rows[0]?.p_title || 1;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl tracking-wide">TITLE ODDS</h1>
          <p className="text-white/60">
            Each row = chance to reach that stage, from {sims.toLocaleString()} simulated tournaments.
          </p>
        </div>
        <div className="flex gap-2">
          {[2000, 5000, 10000].map((n) => (
            <button
              key={n}
              onClick={() => {
                setSims(n);
                load(n);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                sims === n ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              {n / 1000}k sims
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-white/40">
            <tr>
              <th className="p-3">#</th>
              <th className="p-3">Team</th>
              {COLS.map((c) => (
                <th key={c.key} className="p-3 text-right">{c.label}</th>
              ))}
              <th className="p-3 w-40">Title chance</th>
            </tr>
          </thead>
          <tbody>
            {(loading ? [] : rows).map((t, i) => (
              <tr key={t.code} className="border-t border-white/5 hover:bg-white/5">
                <td className="p-3 text-white/40">{i + 1}</td>
                <td className="p-3">
                  <span className="mr-2 text-xl">{flag(t.code)}</span>
                  {t.name}
                </td>
                {COLS.map((c) => (
                  <td key={c.key} className="p-3 text-right tabular-nums text-white/80">
                    {((t[c.key] as number) * 100).toFixed(1)}%
                  </td>
                ))}
                <td className="p-3">
                  <div className="h-3 w-full overflow-hidden rounded-full bg-ink">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-pitch to-gold"
                      style={{ width: `${Math.min(100, (t.p_title / max) * 100)}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="p-6 text-center text-white/40">Running {sims.toLocaleString()} simulations…</div>}
      </div>
    </div>
  );
}
