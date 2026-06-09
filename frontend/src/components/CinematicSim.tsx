import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, flag } from "../api/client";
import type { GroupRow, KnockoutMatch, MatchEvent, SimResult } from "../types";
import Bracket from "./Bracket";
import Awards from "./Awards";
import LiveMatch from "./LiveMatch";
import MatchModal, { MatchData } from "./MatchModal";
import Confetti from "./Confetti";
import { sound } from "../lib/sound";

type GMatch = SimResult["group_matches"][number];

interface Step {
  kind: "group" | "ko" | "final" | "awards" | "champion";
  label: string;
  matches?: (GMatch | KnockoutMatch)[];
  round?: string;
}

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
  const [openMatch, setOpenMatch] = useState<MatchData | null>(null);
  const [follow, setFollow] = useState<string>("");
  const [speed, setSpeed] = useState(1);
  const [elos, setElos] = useState<Record<string, number>>({});
  useEffect(() => {
    api.teams().then((ts) => {
      const m: Record<string, number> = {};
      ts.forEach((t) => (m[t.code] = t.elo));
      setElos(m);
    }).catch(() => {});
  }, []);

  const steps = useMemo<Step[]>(() => {
    const s: Step[] = [];
    const byDate: Record<string, GMatch[]> = {};
    result.group_matches.forEach((m) => { (byDate[m.date || "?"] ||= []).push(m); });
    Object.keys(byDate).sort().forEach((d) =>
      s.push({ kind: "group", label: `Matchday — ${fmtDate(d)}`, matches: byDate[d] })
    );
    const rounds: [string, string][] = [
      ["R32", "Round of 32"], ["R16", "Round of 16"], ["QF", "Quarter-finals"],
      ["SF", "Semi-finals"], ["3P", "Third-place play-off"],
    ];
    rounds.forEach(([r, label]) => {
      const ms = result.knockout.filter((k) => k.round === r);
      if (ms.length) s.push({ kind: "ko", label, matches: ms, round: r });
    });
    const final = result.knockout.find((k) => k.round === "F");
    if (final) s.push({ kind: "final", label: "The Final", matches: [final] });
    if (result.awards) s.push({ kind: "awards", label: "The Awards" });
    s.push({ kind: "champion", label: "Champions" });
    return s;
  }, [result]);

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timer = useRef<number | null>(null);
  const step = steps[idx];

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
    if (playing && idx < steps.length - 1 && !openMatch) {
      const featuredKo = step.kind === "ko" && follow &&
        ((step.matches as any[]) || []).some((m) => m.home === follow || m.away === follow);
      const base =
        step.kind === "final" ? 9000 :
        featuredKo ? 6000 :
        step.kind === "awards" || step.kind === "ko" ? 4200 : 3200;
      timer.current = window.setTimeout(() => setIdx((i) => i + 1), base / speed);
    }
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [idx, playing, steps.length, step, openMatch, speed, follow]);

  // Cumulative events up to the current step — powers the live Golden Boot race.
  const goldenBoot = useMemo(() => {
    const tally: Record<string, { name: string; team: string; goals: number }> = {};
    for (let i = 0; i <= idx; i++) {
      for (const m of (steps[i].matches as any[]) || []) {
        for (const e of (m.events || []) as MatchEvent[]) {
          if (e.type === "red") continue;
          const k = e.scorer_id || e.scorer;
          (tally[k] ||= { name: e.scorer, team: e.team, goals: 0 }).goals++;
        }
      }
    }
    return Object.values(tally).sort((a, b) => b.goals - a.goals).slice(0, 3);
  }, [idx, steps]);

  // Upsets in the current step's matches (loser meaningfully stronger by Elo).
  const upsets = useMemo(() => {
    const ms = (step?.matches as any[]) || [];
    const out: { winner: string; loser: string; score: string }[] = [];
    for (const m of ms) {
      const w = m.winner || (m.home_goals > m.away_goals ? m.home : m.away_goals > m.home_goals ? m.away : null);
      if (!w) continue;
      const l = w === m.home ? m.away : m.home;
      if ((elos[l] || 0) - (elos[w] || 0) >= 90) {
        out.push({ winner: w, loser: l, score: `${m.home_goals}-${m.away_goals}` });
      }
    }
    return out;
  }, [step, elos]);

  const jumpToFollow = () => {
    if (!follow) return;
    for (let i = idx + 1; i < steps.length; i++) {
      const ms = (steps[i].matches as any[]) || [];
      if (ms.some((m) => m.home === follow || m.away === follow)) { setIdx(i); return; }
    }
  };

  const progress = ((idx + 1) / steps.length) * 100;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setIdx((i) => Math.max(0, i - 1))} className="btn-ghost text-sm" disabled={idx === 0}>‹ Prev</button>
        <button onClick={() => setPlaying((p) => !p)} className="btn-primary text-sm">{playing ? "⏸ Pause" : "▶ Play"}</button>
        <button onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))} className="btn-ghost text-sm" disabled={idx === steps.length - 1}>Next ›</button>
        <button onClick={onFinish} className="btn-ghost text-sm">⏭ Skip to results</button>
        <div className="ml-auto text-sm text-white/50">{step?.label}</div>
      </div>
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-ink">
        <div className="h-full bg-gradient-to-r from-pitch to-gold transition-all" style={{ width: `${progress}%` }} />
      </div>

      {/* Follow + speed controls */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-white/40">Follow:</span>
        <select value={follow} onChange={(e) => setFollow(e.target.value)}
          className="rounded-lg bg-ink-card px-2 py-1 text-sm outline-none ring-1 ring-white/10 focus:ring-gold">
          <option value="">No-one</option>
          {Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => (
            <option key={c} value={c}>{n}</option>
          ))}
        </select>
        {follow && <button onClick={jumpToFollow} className="btn-ghost text-xs">⏭ Their next match</button>}
        <span className="ml-2 text-white/40">Speed:</span>
        {[1, 2, 4].map((s) => (
          <button key={s} onClick={() => setSpeed(s)}
            className={`rounded px-2 py-1 text-xs ${speed === s ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>{s}×</button>
        ))}
      </div>

      {/* Live stats ticker */}
      {(goldenBoot.length > 0 || upsets.length > 0) && (
        <div className="mb-4 space-y-2">
          {upsets.map((u, i) => (
            <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
              className="rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-200">
              🚨 UPSET — {flag(u.winner)} {names[u.winner]} beat {flag(u.loser)} {names[u.loser]} {u.score}
            </motion.div>
          ))}
          {goldenBoot.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-ink/50 px-3 py-1.5 text-xs">
              <span className="font-semibold text-gold">👟 Golden Boot</span>
              {goldenBoot.map((g) => (
                <span key={g.name} className="text-white/70">{flag(g.team)} {g.name} <b className="text-white">{g.goals}</b></span>
              ))}
            </div>
          )}
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div key={idx} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.35 }}>
          {step.kind === "group" && (
            <GroupStep matches={step.matches as GMatch[]} standings={standingsUpTo(result.group_matches, cumulativeIdx)} names={names} onOpen={setOpenMatch} />
          )}
          {step.kind === "ko" && (
            <KnockoutStep matches={step.matches as KnockoutMatch[]} label={step.label} names={names} onOpen={setOpenMatch} follow={follow} />
          )}
          {step.kind === "final" && (
            <div>
              <h3 className="mb-3 text-center font-display text-4xl tracking-wide text-gold">THE FINAL</h3>
              <LiveMatch match={step.matches![0] as KnockoutMatch} names={names} />
            </div>
          )}
          {step.kind === "awards" && result.awards && <Awards awards={result.awards} />}
          {step.kind === "champion" && <ChampionStep result={result} />}
        </motion.div>
      </AnimatePresence>

      {openMatch && <MatchModal match={openMatch} names={names} onClose={() => setOpenMatch(null)} />}
    </div>
  );
}

function scorerLine(events: MatchEvent[] | undefined, team: string): string {
  if (!events) return "";
  const mine = events.filter((e) => e.team === team && e.type !== "red");
  if (!mine.length) return "";
  return mine.map((e) => `${e.scorer} ${e.minute}'`).join(", ");
}

function LiveScore({
  match, names, onOpen, delay = 0,
}: {
  match: GMatch | KnockoutMatch;
  names: Record<string, string>;
  onOpen: (m: MatchData) => void;
  delay?: number;
}) {
  const home = (match as any).home || "";
  const away = (match as any).away || "";
  const hg = (match as any).home_goals ?? 0;
  const ag = (match as any).away_goals ?? 0;
  const pens = (match as any).penalties;
  const hp = (match as any).home_pens;
  const ap = (match as any).away_pens;
  const hw = hg > ag || (pens && (hp ?? 0) > (ap ?? 0));
  const events = (match as any).events as MatchEvent[] | undefined;

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay }}
      onClick={() => onOpen(match)}
      className="card w-full p-3 text-left transition hover:border-gold/40"
    >
      <div className="flex items-center gap-2">
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
      </div>
      {pens && (
        <div className="mt-1 text-center text-[10px] text-gold">penalties {hp}–{ap}</div>
      )}
      {events && events.length > 0 && (
        <div className="mt-1 flex justify-between gap-2 text-[10px] text-white/40">
          <span className="flex-1 truncate text-right">⚽ {scorerLine(events, home)}</span>
          <span className="flex-1 truncate">{scorerLine(events, away)} ⚽</span>
        </div>
      )}
    </motion.button>
  );
}

function GroupStep({
  matches, standings, names, onOpen,
}: {
  matches: GMatch[];
  standings: Record<string, GroupRow[]>;
  names: Record<string, string>;
  onOpen: (m: MatchData) => void;
}) {
  const groupsToday = Array.from(new Set(matches.map((m) => m.group))).sort();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gold">Results</h3>
        <div className="space-y-2">
          {matches.map((m, i) => (
            <LiveScore key={m.match_no} match={m} names={names} onOpen={onOpen} delay={i * 0.25} />
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
  matches, label, names, onOpen, follow,
}: {
  matches: KnockoutMatch[];
  label: string;
  names: Record<string, string>;
  onOpen: (m: MatchData) => void;
  follow: string;
}) {
  const featured = follow ? matches.find((m) => m.home === follow || m.away === follow) : undefined;
  const rest = featured ? matches.filter((m) => m !== featured) : matches;
  return (
    <div>
      <h3 className="mb-3 text-center font-display text-3xl tracking-wide text-gold">{label}</h3>
      {featured && (
        <div className="mx-auto mb-3 max-w-2xl">
          <div className="mb-1 text-center text-xs uppercase tracking-widest text-gold">★ Following {names[follow]}</div>
          <LiveMatch match={featured} names={names} durationMs={5000} />
        </div>
      )}
      <div className="mx-auto grid max-w-3xl gap-2">
        {rest.map((m, i) => (
          <LiveScore key={m.match_no} match={m} names={names} onOpen={onOpen} delay={i * 0.15} />
        ))}
      </div>
    </div>
  );
}

function ChampionStep({ result }: { result: SimResult }) {
  useEffect(() => {
    sound.fanfare();
  }, []);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="card relative overflow-hidden p-10 text-center">
      <Confetti />
      <div className="absolute inset-0 bg-gradient-to-b from-gold/25 to-transparent" />
      <div className="relative">
        <motion.div initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", delay: 0.2 }} className="text-7xl">🏆</motion.div>
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
