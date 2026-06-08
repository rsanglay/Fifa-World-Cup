import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { flag } from "../api/client";
import type { GroupRow, KnockoutMatch, SimResult } from "../types";
import Bracket from "./Bracket";
import Awards from "./Awards";

type GMatch = SimResult["group_matches"][number];

interface Step {
  kind: "group" | "ko" | "awards" | "champion";
  label: string;
  date?: string;
  matches?: (GMatch | KnockoutMatch)[];
  round?: string;
}

/* Cumulative group tables from all group matches up to (and incl.) a date. */
function standingsUpTo(matches: GMatch[], upToIdx: number): Record<string, GroupRow[]> {
  const rec: Record<string, Record<string, GroupRow>> = {};
  matches.slice(0, upToIdx).forEach((m) => {
    const g = (rec[m.group] ||= {});
    const ensure = (c: string): GroupRow =>
      (g[c] ||= { code: c, group: m.group, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 });
    const h = ensure(m.home), a = ensure(m.away);
    h.played++; a.played++;
    h.gf += m.home_goals; h.ga += m.away_goals;
    a.gf += m.away_goals; a.ga += m.home_goals;
    if (m.home_goals > m.away_goals) { h.won++; h.points += 3; a.lost++; }
    else if (m.home_goals < m.away_goals) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  });
  const out: Record<string, GroupRow[]> = {};
  Object.entries(rec).forEach(([g, teams]) => {
    out[g] = Object.values(teams).map((r) => ({ ...r, gd: r.gf - r.ga }))
      .sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf);
  });
  return out;
}

export default function CinematicSim({
  result,
  onFinish,
}: {
  result: SimResult;
  onFinish: () => void;
}) {
  const names = result.team_names;

  // Build the timeline of steps.
  const steps = useMemo<Step[]>(() => {
    const s: Step[] = [];
    // Group stage by date.
    const byDate: Record<string, GMatch[]> = {};
    result.group_matches.forEach((m) => {
      (byDate[m.date || "?"] ||= []).push(m);
    });
    const dates = Object.keys(byDate).sort();
    dates.forEach((d, i) =>
      s.push({ kind: "group", label: `Matchday — ${fmtDate(d)}`, date: d, matches: byDate[d], round: `g${i}` })
    );
    // Knockout by round.
    const rounds: [string, string][] = [
      ["R32", "Round of 32"], ["R16", "Round of 16"], ["QF", "Quarter-finals"],
      ["SF", "Semi-finals"], ["3P", "Third-place play-off"], ["F", "Final"],
    ];
    rounds.forEach(([r, label]) => {
      const ms = result.knockout.filter((k) => k.round === r);
      if (ms.length) s.push({ kind: "ko", label, matches: ms, round: r });
    });
    if (result.awards) s.push({ kind: "awards", label: "The Awards" });
    s.push({ kind: "champion", label: "Champions" });
    return s;
  }, [result]);

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timer = useRef<number | null>(null);
  const step = steps[idx];

  // Index into group_matches for cumulative standings at this step.
  const cumulativeIdx = useMemo(() => {
    if (step?.kind !== "group") return 0;
    let count = 0;
    for (let i = 0; i <= idx; i++) {
      if (steps[i].kind === "group") count += steps[i].matches!.length;
    }
    return count;
  }, [idx, steps, step]);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (playing && idx < steps.length - 1) {
      const dwell = step.kind === "awards" || step.kind === "ko" ? 4200 : 3200;
      timer.current = window.setTimeout(() => setIdx((i) => i + 1), dwell);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [idx, playing, steps.length, step]);

  const progress = ((idx + 1) / steps.length) * 100;

  return (
    <div>
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setIdx((i) => Math.max(0, i - 1))} className="btn-ghost text-sm" disabled={idx === 0}>
          ‹ Prev
        </button>
        <button onClick={() => setPlaying((p) => !p)} className="btn-primary text-sm">
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))} className="btn-ghost text-sm" disabled={idx === steps.length - 1}>
          Next ›
        </button>
        <button onClick={onFinish} className="btn-ghost text-sm">
          ⏭ Skip to results
        </button>
        <div className="ml-auto text-sm text-white/50">{step?.label}</div>
      </div>
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-ink">
        <div className="h-full bg-gradient-to-r from-pitch to-gold transition-all" style={{ width: `${progress}%` }} />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={idx}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.35 }}
        >
          {step.kind === "group" && (
            <GroupStep
              matches={step.matches as GMatch[]}
              standings={standingsUpTo(result.group_matches, cumulativeIdx)}
              names={names}
            />
          )}
          {step.kind === "ko" && (
            <KnockoutStep matches={step.matches as KnockoutMatch[]} label={step.label} names={names} />
          )}
          {step.kind === "awards" && result.awards && <Awards awards={result.awards} />}
          {step.kind === "champion" && <ChampionStep result={result} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function LiveScore({
  home, away, hg, ag, names, pens, hp, ap, delay = 0,
}: {
  home: string; away: string; hg: number; ag: number;
  names: Record<string, string>; pens?: boolean; hp?: number | null; ap?: number | null; delay?: number;
}) {
  const hw = hg > ag || (pens && (hp ?? 0) > (ap ?? 0));
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay }}
      className="card flex items-center gap-2 p-3"
    >
      <div className={`flex flex-1 items-center justify-end gap-2 text-right ${hw ? "font-bold" : "text-white/60"}`}>
        <span className="truncate text-sm">{names[home] || home}</span>
        <span className="text-2xl">{flag(home)}</span>
      </div>
      <div className="flex items-center gap-1 rounded-lg bg-ink px-3 py-1 font-display text-2xl tabular-nums">
        <span>{hg}</span><span className="text-white/30">:</span><span>{ag}</span>
      </div>
      <div className={`flex flex-1 items-center gap-2 ${!hw && hg !== ag ? "font-bold" : "text-white/60"}`}>
        <span className="text-2xl">{flag(away)}</span>
        <span className="truncate text-sm">{names[away] || away}</span>
      </div>
      {pens && (
        <span className="absolute -mt-10 ml-2 rounded bg-gold/20 px-1 text-[9px] text-gold">
          pens {hp}-{ap}
        </span>
      )}
    </motion.div>
  );
}

function GroupStep({
  matches, standings, names,
}: {
  matches: GMatch[];
  standings: Record<string, GroupRow[]>;
  names: Record<string, string>;
}) {
  const groupsToday = Array.from(new Set(matches.map((m) => m.group))).sort();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gold">Results</h3>
        <div className="space-y-2">
          {matches.map((m, i) => (
            <LiveScore key={m.match_no} home={m.home} away={m.away} hg={m.home_goals} ag={m.away_goals} names={names} delay={i * 0.25} />
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gold">Standings</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {groupsToday.map((g) => (
            <div key={g} className="card p-3">
              <div className="mb-1 font-display text-lg text-gold">GROUP {g}</div>
              <table className="w-full text-xs">
                <tbody>
                  {(standings[g] || []).map((r, i) => (
                    <tr key={r.code} className={i < 2 ? "text-white" : "text-white/50"}>
                      <td className="py-0.5">{flag(r.code)} {names[r.code] || r.code}</td>
                      <td className="text-center text-white/40">{r.played}</td>
                      <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                      <td className="text-center font-bold">{r.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KnockoutStep({
  matches, label, names,
}: {
  matches: KnockoutMatch[];
  label: string;
  names: Record<string, string>;
}) {
  return (
    <div>
      <h3 className="mb-3 text-center font-display text-3xl tracking-wide text-gold">{label}</h3>
      <div className="mx-auto grid max-w-3xl gap-2">
        {matches.map((m, i) => (
          <LiveScore
            key={m.match_no}
            home={m.home || ""} away={m.away || ""}
            hg={m.home_goals ?? 0} ag={m.away_goals ?? 0}
            names={names} pens={m.penalties} hp={m.home_pens} ap={m.away_pens}
            delay={i * 0.2}
          />
        ))}
      </div>
    </div>
  );
}

function ChampionStep({ result }: { result: SimResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="card relative overflow-hidden p-10 text-center"
    >
      <div className="absolute inset-0 bg-gradient-to-b from-gold/25 to-transparent" />
      <div className="relative">
        <motion.div
          initial={{ y: -30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", delay: 0.2 }}
          className="text-7xl"
        >
          🏆
        </motion.div>
        <div className="mt-2 text-xs uppercase tracking-[0.3em] text-gold">World Champions 2026</div>
        <div className="mt-3 text-8xl">{flag(result.champion)}</div>
        <div className="mt-2 font-display text-6xl tracking-wide">{result.team_names[result.champion]}</div>
        <div className="mt-4 flex justify-center gap-8 text-sm text-white/60">
          <div>🥈 {result.team_names[result.runner_up]}</div>
          <div>🥉 {result.team_names[result.third]}</div>
        </div>
      </div>
    </motion.div>
  );
}

function fmtDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  } catch {
    return d;
  }
}
