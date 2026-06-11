import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { flag, mpLiveWsUrl } from "../api/client";
import MatchView from "./MatchView";
import { sound } from "../lib/sound";
import { downloadShareCard } from "../lib/shareCard";
import type { H2HSide, H2HSnapshot, ManagedSquadPlayer, MatchEvent, MPLiveInfo } from "../types";

const MENTALITIES = [
  { key: "defensive", label: "🛡️ Defensive" },
  { key: "balanced", label: "⚖️ Balanced" },
  { key: "attacking", label: "⚔️ Attacking" },
];
const TEMPOS = [{ key: "slow", label: "Slow" }, { key: "balanced", label: "Balanced" }, { key: "fast", label: "Fast" }];
const PASSINGS = [{ key: "short", label: "Short" }, { key: "mixed", label: "Mixed" }, { key: "direct", label: "Direct" }];
const PRESSINGS = [{ key: "low_block", label: "Low block" }, { key: "mid", label: "Mid" }, { key: "high", label: "High" }];
const STYLES = [{ key: "balanced", label: "Balanced" }, { key: "target_man", label: "🎯 Target man" }, { key: "false_nine", label: "🎭 False nine" }];

/* The multiplayer grudge match, live: both managers (and any spectators)
 * watch the same server-clocked feed; each manager commands only their side. */
export default function MPLiveMatch({ code, token, info, squad, names, onDone }: {
  code: string;
  token: string;
  info: MPLiveInfo;
  squad: ManagedSquadPlayer[];        // YOUR squad ([] for spectators)
  names: Record<string, string>;
  onDone: () => void;
}) {
  const [snap, setSnap] = useState<H2HSnapshot | null>(null);
  const [conn, setConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [subOut, setSubOut] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [shownScore, setShownScore] = useState<{ h: number; a: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const seen = useRef(0);

  const mySide = info.your_side;                 // "home" | "away" | null
  const byId = useMemo(() => Object.fromEntries(squad.map((p) => [p.id, p])), [squad]);

  useEffect(() => {
    const ws = new WebSocket(mpLiveWsUrl(code, info.key, token));
    wsRef.current = ws;
    ws.onopen = () => setConn("open");
    ws.onclose = () => setConn("closed");
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.kind === "snapshot") {
          const s: H2HSnapshot = data.snapshot;
          // Sound only for events we have not seen yet.
          s.events.slice(seen.current).forEach((e) => {   // horn fires when SHOWN
            if (e.type === "red" || e.type === "injury") sound.red();
          });
          seen.current = s.events.length;
          setSnap(s);
        } else if (data.kind === "final") {
          setFinished(true);
        } else if (data.kind === "error") {
          setErrMsg(data.message);
          setTimeout(() => setErrMsg(null), 4000);
        }
      } catch { /* malformed frame */ }
    };
    return () => ws.close();
  }, [code, info.key, token]);

  const send = (payload: Record<string, unknown>) =>
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify(payload));

  if (!snap) {
    return (
      <div className="card p-8 text-center">
        <div className="animate-pulse font-display text-xl">
          {conn === "closed" ? "Connection lost — refresh to rejoin" : "Walking out of the tunnel…"}
        </div>
      </div>
    );
  }

  const mine: H2HSide | null = mySide ? (mySide === "home" ? snap.home_side : snap.away_side) : null;
  const theirs: H2HSide | null = mySide ? (mySide === "home" ? snap.away_side : snap.home_side) : null;
  const lastEvent: MatchEvent | null = snap.events.length ? snap.events[snap.events.length - 1] : null;
  const shape = (side: H2HSide | null) => {
    const on = (side?.xi || []).map((i) => byId[i]).filter(Boolean);
    return on.length ? {
      d: on.filter((p) => p.position === "DEF").length || 4,
      m: on.filter((p) => p.position === "MID").length || 3,
      f: on.filter((p) => p.position === "FWD").length || 3,
    } : { d: 4, m: 3, f: 3 };
  };

  const grudgeCard = () => downloadShareCard({
    kind: "grudge",
    title: mySide && snapWinner(snap) === mine?.code ? "GRUDGE MATCH WON" : "GRUDGE MATCH",
    lines: snap.events.filter((e) => e.type === "goal").slice(0, 4)
      .map((e) => `⚽ ${e.scorer} ${e.minute}'`),
    won: !!mySide && snapWinner(snap) === mine?.code,
    vs: {
      homeCode: snap.home, awayCode: snap.away,
      homeGoals: snap.home_goals, awayGoals: snap.away_goals,
      homeManager: snap.home_side.manager, awayManager: snap.away_side.manager,
      pens: snap.penalties ? `${snap.home_pens}–${snap.away_pens}` : null,
    },
  });

  return (
    <div className="space-y-3">
      {/* scoreboard */}
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2 font-display text-2xl">
          <span className="text-3xl">{flag(snap.home)}</span>
          <span className="tabular-nums">
            {shownScore ? `${shownScore.h}:${shownScore.a}` : `${snap.home_goals}:${snap.away_goals}`}
          </span>
          <span className="text-3xl">{flag(snap.away)}</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className={`h-2 w-2 rounded-full ${conn === "open" ? "animate-pulse bg-red-500" : "bg-white/30"}`} />
          <span className="font-mono text-lg tabular-nums">{snap.minute}'</span>
          <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold">{snap.period}</span>
        </div>
        <div className="text-xs text-white/50">
          {snap.home_side.manager} <span className="text-gold">vs</span> {snap.away_side.manager}
          {!mySide && <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px]">SPECTATING</span>}
        </div>
        {errMsg && <div className="w-full rounded bg-red-500/15 px-2 py-1 text-xs text-red-300">{errMsg}</div>}
      </div>

      {/* live pitch: 2D dots or the 3D stadium */}
      <MatchView
        ourShape={shape(mine || snap.home_side)} oppShape={shape(theirs || snap.away_side)}
        ourSide={mySide || "home"}
        running={!snap.done && !snap.break} lastEvent={lastEvent}
        events={snap.events} homeTeam={snap.home}
        homeGoals={snap.home_goals} awayGoals={snap.away_goals} possession={0.5}
        onShownScore={(h, a) => setShownScore({ h, a })}
      />

      {/* breaks + FT */}
      <AnimatePresence>
        {snap.break && !snap.done && (
          <motion.div key="break" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="card p-5 text-center">
            <div className="font-display text-2xl tracking-wide text-gold">
              {snap.break === "HT" ? "HALF-TIME" : "EXTRA TIME"}
            </div>
            <div className="mt-1 text-sm text-white/60">
              Both managers ready up to resume (auto-resumes shortly).
            </div>
            <div className="mt-2 flex items-center justify-center gap-3 text-sm">
              <ReadyChip side={snap.home_side} />
              <ReadyChip side={snap.away_side} />
            </div>
            {mySide && !mine?.ready && (
              <button onClick={() => send({ action: "ready" })} className="btn-primary mt-3">✓ Ready</button>
            )}
          </motion.div>
        )}
        {(snap.done || finished) && (
          <motion.div key="ft" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="card p-5 text-center">
            <div className="font-display text-2xl tracking-wide text-gold">FULL TIME</div>
            <div className="mt-1 text-sm text-white/60">
              {names[snap.home]} {snap.home_goals} : {snap.away_goals} {names[snap.away]}
              {snap.penalties && ` — ${snap.home_pens}–${snap.away_pens} on penalties`}
            </div>
            <div className="mt-3 flex justify-center gap-2">
              <button onClick={grudgeCard} className="btn-ghost text-sm">🖼 Share card</button>
              <button onClick={onDone} className="btn-primary">Continue →</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* my dugout */}
      {mySide && mine && !snap.done && (
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-gold">Your dugout — changes apply live</div>
            <div className="text-xs text-white/40">avg stamina {mine.avg_stamina}%</div>
          </div>
          <Dial label="Mentality" options={MENTALITIES} value={mine.mentality} onPick={(v) => send({ action: "tactics", mentality: v })} />
          <Dial label="Tempo" options={TEMPOS} value={mine.tempo} onPick={(v) => send({ action: "tactics", tempo: v })} />
          <Dial label="Passing" options={PASSINGS} value={mine.passing} onPick={(v) => send({ action: "tactics", passing: v })} />
          <Dial label="Pressing" options={PRESSINGS} value={mine.pressing} onPick={(v) => send({ action: "tactics", pressing: v })} />
          <Dial label="Attack" options={STYLES} value={mine.attack_style} onPick={(v) => send({ action: "tactics", attack_style: v })} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 text-xs uppercase tracking-wide text-white/40">Game mgmt</span>
            <button onClick={() => send({ action: "tactics", time_wasting: !mine.time_wasting })}
              className={`rounded-lg px-3 py-1 text-sm font-semibold ${mine.time_wasting ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>
              ⏳ Time-wasting {mine.time_wasting ? "ON" : "off"}
            </button>
          </div>

          {/* subs */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-gold">Substitutions — {mine.subs_remaining} left</span>
              {subOut && <button onClick={() => setSubOut(null)} className="text-xs text-white/50">cancel</button>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                {mine.xi.map((id) => byId[id] && (
                  <button key={id} onClick={() => setSubOut(subOut === id ? null : id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm ${subOut === id ? "bg-gold/20 ring-1 ring-gold" : "bg-ink/50 hover:bg-white/10"}`}>
                    <span className="w-7 rounded bg-white/10 text-center text-[10px]">{byId[id].position}</span>
                    <span className="min-w-0 flex-1 truncate">{mine.injured.includes(id) && "🤕 "}{byId[id].name}</span>
                    <StaminaBar v={mine.stamina[id] ?? 100} />
                  </button>
                ))}
              </div>
              <div className={`space-y-1 ${subOut ? "" : "opacity-40"}`}>
                {mine.bench.map((id) => byId[id] && (
                  <button key={id} onClick={() => subOut && send({ action: "sub", out_id: subOut, in_id: id }) && setSubOut(null)}
                    className="flex w-full items-center gap-2 rounded-lg bg-ink/50 px-2 py-1 text-left text-sm hover:bg-white/10">
                    <span className="w-7 rounded bg-white/10 text-center text-[10px]">{byId[id].position}</span>
                    <span className="min-w-0 flex-1 truncate">{byId[id].name}</span>
                    <StaminaBar v={100} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          {theirs && (
            <div className="text-xs text-white/40">
              {theirs.manager}'s setup: <b className="text-white/70">{theirs.mentality}</b> · {theirs.tempo} tempo
              · {theirs.passing} passing · {theirs.pressing} press
              {theirs.time_wasting && " · ⏳ wasting time"}
              {theirs.red != null && <span className="text-emerald-300"> · down to 10!</span>}
            </div>
          )}
        </div>
      )}

      {/* ticker */}
      <div className="card max-h-44 space-y-1 overflow-y-auto p-3">
        {snap.events.length === 0 && <div className="text-xs text-white/30">Kick-off…</div>}
        {[...snap.events].reverse().slice(0, 14).map((e, i) => (
          <div key={`${e.minute}-${e.type}-${i}`}
            className={`flex items-center gap-2 text-sm ${mine && e.team === mine.code ? "" : "text-white/60"}`}>
            <span className="w-7 text-right font-mono text-xs text-white/40">{e.minute}'</span>
            <span>{evIcon(e)}</span>
            <span className="truncate">{evText(e, names)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function snapWinner(s: H2HSnapshot): string | null {
  if (s.home_goals > s.away_goals || (s.penalties && (s.home_pens ?? 0) > (s.away_pens ?? 0))) return s.home;
  if (s.away_goals > s.home_goals || (s.penalties && (s.away_pens ?? 0) > (s.home_pens ?? 0))) return s.away;
  return null;
}
function ReadyChip({ side }: { side: H2HSide }) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs ${side.ready ? "bg-pitch/30" : "bg-white/10 text-white/50"}`}>
      {flag(side.code)} {side.manager} {side.ready ? "✓ ready" : "…"}
    </span>
  );
}
function StaminaBar({ v }: { v: number }) {
  const col = v > 65 ? "bg-emerald-400" : v > 40 ? "bg-amber-400" : "bg-red-400";
  return (
    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-white/10">
      <span className={`block h-full ${col}`} style={{ width: `${v}%` }} />
    </span>
  );
}
function Dial({ label, options, value, onPick }: {
  label: string; options: { key: string; label: string }[]; value: string; onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 text-xs uppercase tracking-wide text-white/40">{label}</span>
      {options.map((o) => (
        <button key={o.key} onClick={() => onPick(o.key)}
          className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${value === o.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
function evIcon(e: MatchEvent): string {
  switch (e.type) {
    case "goal": return e.source === "penalty" ? "🎯" : "⚽";
    case "chance": return e.outcome === "saved" ? "🧤" : e.outcome === "woodwork" ? "🥅" : "❌";
    case "penalty_miss": return "❌";
    case "yellow": return "🟨";
    case "red": return "🟥";
    case "sub": return "🔁";
    case "injury": return "🤕";
    case "pens": return "🎯";
    default: return "•";
  }
}
function evText(e: MatchEvent, names: Record<string, string>): string {
  const t = names[e.team] || e.team;
  switch (e.type) {
    case "goal": return `GOAL! ${e.scorer} (${t})${e.assist ? ` — assist ${e.assist}` : ""}`;
    case "chance": return e.outcome === "saved" ? `${e.scorer}'s effort is saved!`
      : e.outcome === "woodwork" ? `${e.scorer} rattles the woodwork!` : `${e.scorer} shoots wide.`;
    case "penalty_miss": return `Penalty squandered (${t})!`;
    case "yellow": return `${e.scorer} is booked.`;
    case "red": return e.second_yellow ? `${e.scorer} — second yellow, off!` : `RED CARD — ${e.scorer} (${t})`;
    case "sub": return `Substitution (${t}): ${e.scorer} on for ${e.assist}.`;
    case "injury": return `${e.scorer} (${t}) is down injured!`;
    case "pens": return `Penalty shoot-out: ${e.scorer}.`;
    default: return e.scorer;
  }
}
