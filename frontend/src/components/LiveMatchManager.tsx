import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, flag } from "../api/client";
import Pitch2D from "./Pitch2D";
import { sound } from "../lib/sound";
import type { LiveSnapshot, ManagedState, ManagedSquadPlayer, MatchEvent } from "../types";

const MENTALITIES = [
  { key: "defensive", label: "Defensive", icon: "🛡️" },
  { key: "balanced", label: "Balanced", icon: "⚖️" },
  { key: "attacking", label: "Attacking", icon: "⚔️" },
];
const TEMPOS = [
  { key: "slow", label: "Slow build-up" },
  { key: "balanced", label: "Balanced" },
  { key: "fast", label: "Fast & direct" },
];
const PASSINGS = [
  { key: "short", label: "Short passing" },
  { key: "mixed", label: "Mixed" },
  { key: "direct", label: "Direct passing" },
];
const PRESSINGS = [
  { key: "low_block", label: "Low block" },
  { key: "mid", label: "Mid press" },
  { key: "high", label: "High press" },
];
// Famous tactical identities -> dial combos (FM-preset style).
const PRESETS: { name: string; icon: string; t: Record<string, string> }[] = [
  { name: "Tiki-Taka", icon: "🎨", t: { mentality: "balanced", tempo: "slow", passing: "short", pressing: "high" } },
  { name: "Gegenpress", icon: "⚡", t: { mentality: "attacking", tempo: "fast", passing: "mixed", pressing: "high" } },
  { name: "Counter-Attack", icon: "🗡️", t: { mentality: "defensive", tempo: "fast", passing: "direct", pressing: "low_block" } },
  { name: "Route One", icon: "🚀", t: { mentality: "balanced", tempo: "fast", passing: "direct", pressing: "mid" } },
  { name: "Park the Bus", icon: "🚌", t: { mentality: "defensive", tempo: "slow", passing: "direct", pressing: "low_block" } },
];
const TICK_MS = 700; // 1 game-minute per tick at 1x

/* In-game management: pause, change tactics and substitute at ANY minute,
 * while the 2D match view plays out live — Football Manager style. */
export default function LiveMatchManager({
  sid, initial, squad, names, team, onDone,
}: {
  sid: string;
  initial: LiveSnapshot;
  squad: ManagedSquadPlayer[];
  names: Record<string, string>;
  team: string;
  onDone: (state: ManagedState) => void;
}) {
  const [live, setLive] = useState<LiveSnapshot>(initial);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState<"tactics" | "subs" | null>(null);
  const [subOut, setSubOut] = useState<string | null>(null);
  const [subMsg, setSubMsg] = useState<string | null>(null);
  const [finalState, setFinalState] = useState<ManagedState | null>(null);
  const inFlight = useRef(false);

  const byId = useMemo(() => Object.fromEntries(squad.map((p) => [p.id, p])), [squad]);
  const shape = useMemo(() => {
    const on = live.xi.map((i) => byId[i]).filter(Boolean);
    return {
      d: on.filter((p) => p.position === "DEF").length || 4,
      m: on.filter((p) => p.position === "MID").length || 3,
      f: on.filter((p) => p.position === "FWD").length || 3,
    };
  }, [live.xi, byId]);

  // Game clock: tick the server one minute at a time.
  useEffect(() => {
    if (!playing || live.done || panel) return;
    const t = window.setInterval(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const r = await api.manageLiveTick(sid, 1);
        inFlight.current = false;
        setLive(r.live);
        r.live.new_events.forEach((e) => {
          if (e.type === "goal") sound.goal();
          else if (e.type === "red") sound.red();
        });
        if (r.live.break || r.live.done) setPlaying(false);
        if (r.state) setFinalState(r.state);
      } catch {
        inFlight.current = false;
      }
    }, TICK_MS / speed);
    return () => window.clearInterval(t);
  }, [playing, speed, live.done, panel, sid]);

  const lastEvent: MatchEvent | null = live.events.length
    ? tagHome(live.events[live.events.length - 1], live.home) : null;

  const setTactics = async (t: Record<string, string>) => {
    const r = await api.manageLiveTactics(sid, t);
    setLive(r.live);
  };
  const setMentality = (m: string) => setTactics({ mentality: m });
  const makeSub = async (outId: string, inId: string) => {
    setSubMsg(null);
    const r = await api.manageLiveSub(sid, outId, inId);
    setLive(r.live);
    setSubOut(null);
    if (r.message !== "ok") setSubMsg(r.message);
  };

  const us = live.our_side === "home"
    ? { gf: live.home_goals, ga: live.away_goals } : { gf: live.away_goals, ga: live.home_goals };
  // Cosmetic possession bias for the 2D view: short/slow keep-ball styles hold
  // the ball more; direct/fast styles trade it away faster.
  const styleBias = (m: string, tempo: string, passing: string) =>
    (m === "attacking" ? 0.05 : m === "defensive" ? -0.05 : 0)
    + (passing === "short" ? 0.06 : passing === "direct" ? -0.03 : 0)
    + (tempo === "slow" ? 0.04 : tempo === "fast" ? -0.02 : 0);
  const ourBias = styleBias(live.mentality, live.tempo, live.passing);
  const oppBias = styleBias(live.opp_mentality, live.opp_tempo, live.opp_passing);
  const possession = 0.5 + (live.our_side === "home" ? ourBias - oppBias : oppBias - ourBias);

  return (
    <div className="space-y-3">
      {/* scoreboard + controls */}
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2 font-display text-2xl">
          <span className="text-3xl">{flag(live.home)}</span>
          <span className="tabular-nums">{live.home_goals}:{live.away_goals}</span>
          <span className="text-3xl">{flag(live.away)}</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          <span className="font-mono text-lg tabular-nums">{live.minute}'</span>
          <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold">{live.period}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!live.done && (
            <button onClick={() => setPlaying((p) => !p)} className="btn-primary text-sm">
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
          )}
          {[1, 2, 4].map((s) => (
            <button key={s} onClick={() => setSpeed(s)}
              className={`rounded px-2 py-1 text-xs ${speed === s ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>{s}×</button>
          ))}
          <button onClick={() => { setPanel(panel === "tactics" ? null : "tactics"); setPlaying(false); }}
            className={`rounded-lg px-3 py-1 text-sm font-semibold ${panel === "tactics" ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>📋 Tactics</button>
          <button onClick={() => { setPanel(panel === "subs" ? null : "subs"); setPlaying(false); }}
            className={`rounded-lg px-3 py-1 text-sm font-semibold ${panel === "subs" ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>
            🔁 Subs <span className="text-[10px] opacity-70">({live.subs_remaining})</span>
          </button>
        </div>
      </div>

      {/* 2D live pitch */}
      <Pitch2D
        ourShape={shape} oppShape={{ d: 4, m: 3, f: 3 }} ourSide={live.our_side}
        running={playing && !live.done} lastEvent={lastEvent}
        homeGoals={live.home_goals} awayGoals={live.away_goals} possession={possession}
      />

      {/* break / FT banners */}
      <AnimatePresence>
        {live.break === "HT" && !playing && (
          <Banner key="ht" title="HALF-TIME" sub="Adjust your approach, make changes, then resume.">
            <MentalityRow value={live.mentality} onPick={setMentality} />
            <button onClick={() => { setPanel(null); setPlaying(true); }} className="btn-primary mt-3">▶ Second half</button>
          </Banner>
        )}
        {live.break === "ET" && !playing && (
          <Banner key="et" title="EXTRA TIME" sub={`Level at ${live.home_goals}:${live.away_goals} after 90 — 30 more minutes.`}>
            <MentalityRow value={live.mentality} onPick={setMentality} />
            <button onClick={() => { setPanel(null); setPlaying(true); }} className="btn-primary mt-3">▶ Play extra time</button>
          </Banner>
        )}
        {live.done && (
          <Banner key="ft" title={us.gf > us.ga || (live.penalties && wonPens(live)) ? "FULL TIME — YOU WIN! 🎉" : us.gf === us.ga && !live.penalties ? "FULL TIME — DRAW" : "FULL TIME"}
            sub={live.penalties ? `${live.home_pens}–${live.away_pens} on penalties` : `${names[live.home]} ${live.home_goals} : ${live.away_goals} ${names[live.away]}`}>
            <button onClick={() => finalState && onDone(finalState)} disabled={!finalState} className="btn-primary mt-2">
              Continue →
            </button>
          </Banner>
        )}
      </AnimatePresence>

      {/* tactics panel */}
      {panel === "tactics" && !live.done && (
        <div className="card space-y-3 p-4">
          <div className="text-xs uppercase tracking-wider text-gold">Match tactics — applied immediately</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const active = Object.entries(p.t).every(([k, v]) => (live as any)[k] === v);
              return (
                <button key={p.name} onClick={() => setTactics(p.t)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${active ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
                  {p.icon} {p.name}
                </button>
              );
            })}
          </div>
          <DialRow label="Mentality" options={MENTALITIES.map((m) => ({ key: m.key, label: `${m.icon} ${m.label}` }))}
            value={live.mentality} onPick={(v) => setTactics({ mentality: v })} />
          <DialRow label="Tempo" options={TEMPOS} value={live.tempo} onPick={(v) => setTactics({ tempo: v })} />
          <DialRow label="Passing" options={PASSINGS} value={live.passing} onPick={(v) => setTactics({ passing: v })} />
          <DialRow label="Pressing" options={PRESSINGS} value={live.pressing} onPick={(v) => setTactics({ pressing: v })} />
          {live.pressing === "high" && live.avg_stamina < 70 && (
            <div className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
              ⚠️ Your legs are going (avg stamina {live.avg_stamina}%) — a high press on tired legs
              leaves space in behind. Sub fresh legs or drop the press.
            </div>
          )}
          <div className="text-xs text-white/40">
            Opposition: <b className="text-white/70">{live.opp_mentality}</b> · {oppStyle(live)}.
            {live.our_red != null && <span className="text-red-300"> You are down to 10 men ({live.our_red}').</span>}
            {live.opp_red != null && <span className="text-emerald-300"> They are down to 10 men ({live.opp_red}').</span>}
          </div>
        </div>
      )}

      {/* substitutions panel */}
      {panel === "subs" && !live.done && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-gold">Substitutions — {live.subs_remaining} remaining</div>
            {subOut && <button onClick={() => setSubOut(null)} className="text-xs text-white/50">cancel</button>}
          </div>
          {subMsg && <div className="mb-2 rounded bg-red-500/15 px-2 py-1 text-xs text-red-300">{subMsg}</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[10px] uppercase text-white/40">On the pitch {subOut ? "" : "— pick who comes OFF"}</div>
              <div className="space-y-1">
                {live.xi.map((id) => (
                  <PlayerRow key={id} p={byId[id]} stamina={live.stamina[id]}
                    active={subOut === id} dim={!!subOut && subOut !== id}
                    onClick={() => setSubOut(subOut === id ? null : id)} />
                ))}
              </div>
            </div>
            <div className={subOut ? "" : "opacity-40"}>
              <div className="mb-1 text-[10px] uppercase text-white/40">Bench {subOut ? "— pick who comes ON" : ""}</div>
              <div className="space-y-1">
                {live.bench.map((id) => (
                  <PlayerRow key={id} p={byId[id]} stamina={live.stamina[id]} fresh
                    onClick={() => subOut && live.subs_remaining > 0 && makeSub(subOut, id)} />
                ))}
              </div>
            </div>
          </div>
          {live.subs.length > 0 && (
            <div className="mt-2 text-[11px] text-white/40">
              {live.subs.map((s, i) => <span key={i} className="mr-3">🔁 {s.minute}' {s.in} ↔ {s.out}</span>)}
            </div>
          )}
        </div>
      )}

      {/* event ticker */}
      <div className="card max-h-44 space-y-1 overflow-y-auto p-3">
        {live.events.length === 0 && <div className="text-xs text-white/30">Kick-off…</div>}
        {[...live.events].reverse().slice(0, 14).map((e, i) => (
          <div key={`${e.minute}-${e.type}-${i}`}
            className={`flex items-center gap-2 text-sm ${e.team === team ? "" : "text-white/60"}`}>
            <span className="w-7 text-right font-mono text-xs text-white/40">{e.minute}'</span>
            <span>{icon(e)}</span>
            <span className="truncate">{text(e, names)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function tagHome(e: MatchEvent, home: string): MatchEvent {
  (e as any).__home = e.team === home;
  return e;
}
function wonPens(l: LiveSnapshot): boolean {
  const ourPens = l.our_side === "home" ? l.home_pens : l.away_pens;
  const oppPens = l.our_side === "home" ? l.away_pens : l.home_pens;
  return (ourPens ?? 0) > (oppPens ?? 0);
}
function icon(e: MatchEvent): string {
  switch (e.type) {
    case "goal": return e.source === "penalty" ? "🎯" : e.source === "freekick" ? "🚀" : "⚽";
    case "chance": return e.set_piece === "freekick" ? "🚀"
      : e.outcome === "saved" ? "🧤" : e.outcome === "woodwork" ? "🥅" : "❌";
    case "penalty_miss": return e.outcome === "saved" ? "🧤" : "❌";
    case "yellow": return "🟨";
    case "red": return "🟥";
    case "sub": return "🔁";
    case "pens": return "🎯";
    default: return "•";
  }
}
function text(e: MatchEvent, names: Record<string, string>): string {
  const t = names[e.team] || e.team;
  switch (e.type) {
    case "goal":
      return e.source === "penalty" ? `PENALTY GOAL! ${e.scorer} converts from the spot (${t})`
        : e.source === "freekick" ? `FREE KICK GOAL! ${e.scorer} curls it in (${t})`
        : `GOAL! ${e.scorer} (${t})`;
    case "chance": {
      const fk = e.set_piece === "freekick" ? "free kick " : "";
      return e.outcome === "saved" ? `${e.scorer}'s ${fk}effort is saved!`
        : e.outcome === "woodwork" ? `${e.scorer}'s ${fk}strike rattles the woodwork!`
        : `${e.scorer} sends the ${fk}shot wide.`;
    }
    case "penalty_miss":
      return e.outcome === "saved" ? `PENALTY SAVED! ${e.scorer} is denied from the spot!`
        : `PENALTY MISSED! ${e.scorer} puts it wide!`;
    case "yellow": return `${e.scorer} is booked.`;
    case "red": return e.second_yellow ? `${e.scorer} — second yellow, off!` : `RED CARD — ${e.scorer} (${t})`;
    case "sub": return `Substitution: ${e.scorer} on for ${e.assist}.`;
    case "pens": return `Penalty shoot-out: ${e.scorer}.`;
    default: return e.scorer;
  }
}

function oppStyle(l: LiveSnapshot): string {
  if (l.opp_pressing === "low_block" && l.opp_tempo === "slow") return "parking the bus";
  if (l.opp_pressing === "high" && l.opp_tempo === "fast") return "pressing high and chasing";
  if (l.opp_pressing === "low_block") return "sitting deep on the counter";
  return "playing a balanced game";
}

function DialRow({ label, options, value, onPick }: {
  label: string; options: { key: string; label: string }[]; value: string; onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 text-xs uppercase tracking-wide text-white/40">{label}</span>
      {options.map((o) => (
        <button key={o.key} onClick={() => onPick(o.key)}
          className={`rounded-lg px-3 py-1 text-sm font-semibold ${value === o.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MentalityRow({ value, onPick }: { value: string; onPick: (m: string) => void }) {
  return (
    <div className="flex justify-center gap-2">
      {MENTALITIES.map((m) => (
        <button key={m.key} onClick={() => onPick(m.key)}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${value === m.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
          {m.icon} {m.label}
        </button>
      ))}
    </div>
  );
}

function Banner({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="card p-5 text-center">
      <div className="font-display text-2xl tracking-wide text-gold">{title}</div>
      {sub && <div className="mt-1 text-sm text-white/60">{sub}</div>}
      <div className="mt-3">{children}</div>
    </motion.div>
  );
}

function PlayerRow({ p, stamina, active, dim, fresh, onClick }: {
  p?: ManagedSquadPlayer; stamina?: number; active?: boolean; dim?: boolean; fresh?: boolean;
  onClick?: () => void;
}) {
  if (!p) return null;
  const st = stamina ?? 100;
  const col = st > 65 ? "bg-emerald-400" : st > 40 ? "bg-amber-400" : "bg-red-400";
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition
        ${active ? "bg-gold/20 ring-1 ring-gold" : dim ? "opacity-40" : "bg-ink/50 hover:bg-white/10"}`}>
      <span className="w-7 rounded bg-white/10 text-center text-[10px]">{p.position}</span>
      <span className="min-w-0 flex-1 truncate">{p.name}</span>
      <span className="text-xs font-bold text-gold">{p.rating}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
        <span className={`block h-full ${col}`} style={{ width: `${fresh ? 100 : st}%` }} />
      </span>
    </button>
  );
}
