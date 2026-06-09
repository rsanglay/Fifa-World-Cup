import { useEffect, useMemo, useState } from "react";
import { api, flag } from "../api/client";
import ErrorBox from "../components/ErrorBox";
import type { Fixture, OddsRow, Team } from "../types";

type Results = Record<number, [number, number]>;

export default function Reality() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teams, setTeams] = useState<Record<string, Team>>({});
  const [baseline, setBaseline] = useState<Record<string, number>>({});
  const [results, setResults] = useState<Results>({});
  const [conditioned, setConditioned] = useState<OddsRow[] | null>(null);
  const [standings, setStandings] = useState<Record<string, any[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("A");

  const load = () => {
    setError(null);
    api.fixtures().then((d) => setFixtures(d.group_stage)).catch((e) => setError(String(e?.message || e)));
    api.teams().then((ts) => {
      const m: Record<string, Team> = {};
      ts.forEach((t) => (m[t.code] = t));
      setTeams(m);
    });
    api.odds(2000).then((d) => {
      const b: Record<string, number> = {};
      d.teams.forEach((t) => (b[t.code] = t.p_title));
      setBaseline(b);
    }).catch(() => {});
  };
  useEffect(load, []);

  const setScore = (no: number, side: 0 | 1, val: string) => {
    setResults((cur) => {
      const pair: [number, number] = cur[no] ? [...cur[no]] as [number, number] : [NaN, NaN];
      pair[side] = val === "" ? NaN : Math.max(0, Math.min(99, Number(val)));
      const next = { ...cur, [no]: pair };
      return next;
    });
  };

  const cleanResults = useMemo(() => {
    const out: Record<string, [number, number]> = {};
    Object.entries(results).forEach(([no, [h, a]]) => {
      if (Number.isFinite(h) && Number.isFinite(a)) out[no] = [h, a];
    });
    return out;
  }, [results]);

  const playedCount = Object.keys(cleanResults).length;

  const recompute = () => {
    setBusy(true);
    api.realityOdds(cleanResults, 2500).then((d) => {
      setConditioned(d.teams);
      setStandings(d.standings);
      setBusy(false);
    }).catch((e) => { setError(String(e?.message || e)); setBusy(false); });
  };

  const name = (c?: string) => (c && teams[c]?.name) || c || "";
  const groupFixtures = fixtures.filter((f) => f.group === groupFilter);

  return (
    <div>
      <h1 className="mb-1 font-display text-4xl tracking-wide">WHAT-IF LAB</h1>
      <p className="mb-1 text-white/60">
        Enter results — real ones as the tournament unfolds, or hypothetical "what-ifs" — and watch the
        title odds and group tables re-calculate around them.
      </p>
      <p className="mb-5 text-xs text-white/40">
        {playedCount} result{playedCount === 1 ? "" : "s"} locked in. The rest is simulated from there.
      </p>

      {error && <ErrorBox message={error} onRetry={load} />}

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        {/* Results entry */}
        <div>
          <div className="mb-3 flex flex-wrap gap-1">
            {"ABCDEFGHIJKL".split("").map((g) => (
              <button key={g} onClick={() => setGroupFilter(g)}
                className={`rounded-lg px-2.5 py-1 text-sm font-medium ${groupFilter === g ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
                {g}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {groupFixtures.map((f) => {
              const r = results[f.match_no];
              return (
                <div key={f.match_no} className="card flex items-center gap-2 p-2.5">
                  <span className="w-6 text-center text-[10px] text-white/30">{f.match_no}</span>
                  <div className="flex flex-1 items-center justify-end gap-2 text-right">
                    <span className="truncate text-sm">{name(f.home)}</span>
                    <span className="text-xl">{flag(f.home || "")}</span>
                  </div>
                  <input inputMode="numeric" value={Number.isFinite(r?.[0]) ? r![0] : ""}
                    onChange={(e) => setScore(f.match_no, 0, e.target.value)}
                    className="w-9 rounded bg-ink px-1 py-1 text-center outline-none ring-1 ring-white/10 focus:ring-gold" />
                  <span className="text-white/30">:</span>
                  <input inputMode="numeric" value={Number.isFinite(r?.[1]) ? r![1] : ""}
                    onChange={(e) => setScore(f.match_no, 1, e.target.value)}
                    className="w-9 rounded bg-ink px-1 py-1 text-center outline-none ring-1 ring-white/10 focus:ring-gold" />
                  <div className="flex flex-1 items-center gap-2">
                    <span className="text-xl">{flag(f.away || "")}</span>
                    <span className="truncate text-sm">{name(f.away)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={recompute} disabled={busy} className="btn-primary text-sm">
              {busy ? "Calculating…" : "↻ Update odds & tables"}
            </button>
            <button onClick={() => { setResults({}); setConditioned(null); setStandings({}); }} className="btn-ghost text-sm">
              Clear all
            </button>
          </div>
        </div>

        {/* Conditioned output */}
        <div className="space-y-4">
          {standings[groupFilter] && Object.keys(cleanResults).length > 0 && (
            <div className="card p-3">
              <div className="mb-1 font-display text-lg text-gold">GROUP {groupFilter} — from your results</div>
              <table className="w-full text-sm">
                <tbody>
                  {standings[groupFilter].map((r: any, i: number) => (
                    <tr key={r.code} className={i < 2 ? "text-white" : "text-white/50"}>
                      <td className="py-1">{flag(r.code)} {name(r.code)}</td>
                      <td className="text-center text-white/40">{r.played}</td>
                      <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                      <td className="text-center font-bold">{r.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card p-3">
            <div className="mb-2 font-display text-lg text-gold">TITLE ODDS {conditioned ? "(conditioned)" : ""}</div>
            {!conditioned && <p className="text-sm text-white/40">Enter some results and hit “Update” to see how the odds shift.</p>}
            {conditioned && (
              <div className="space-y-1">
                {conditioned.slice(0, 12).map((t) => {
                  const base = baseline[t.code] ?? t.p_title;
                  const delta = t.p_title - base;
                  return (
                    <div key={t.code} className="flex items-center gap-2 text-sm">
                      <span className="text-lg">{flag(t.code)}</span>
                      <span className="flex-1 truncate">{t.name}</span>
                      <span className="tabular-nums font-semibold">{(t.p_title * 100).toFixed(1)}%</span>
                      <span className={`w-12 text-right text-xs tabular-nums ${delta > 0.002 ? "text-emerald-400" : delta < -0.002 ? "text-red-400" : "text-white/30"}`}>
                        {delta > 0 ? "▲" : delta < 0 ? "▼" : ""}{Math.abs(delta * 100).toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
