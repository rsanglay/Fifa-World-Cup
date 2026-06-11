import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { flag } from "../../api/client";
import { useLiveSocket } from "../../hooks/useLiveSocket";
import { crowd, isMuted, setMuted, sound } from "../../lib/sound";
import RatingsPanel from "../RatingsPanel";
import EventFeed from "./EventFeed";
import HUDBar from "./HUDBar";
import LivePitch2D from "./LivePitch2D";
import MiniRadar from "./MiniRadar";

// Three.js (~130KB gzip) loads only when someone actually presses 3D.
const LivePitch3D = lazy(() => import("./LivePitch3D"));
import type {
  LiveFrame, ManagedSquadPlayer, ManagedState,
} from "../../types";

/* FM × EAFC live match screen, fully server-pushed over WebSocket.
 * The server ticks one game-minute every 500ms; this component renders the
 * frame stream, hosts the tactics/substitution panels, and runs the stadium
 * sound stage. No polling anywhere. */

const MENTALITIES = [
  { key: "defensive", label: "Defensive", icon: "🛡️" },
  { key: "balanced", label: "Balanced", icon: "⚖️" },
  { key: "attacking", label: "Attacking", icon: "⚔️" },
];
const TEMPOS = [
  { key: "slow", label: "Slow build-up" }, { key: "balanced", label: "Balanced" },
  { key: "fast", label: "Fast & direct" }];
const PASSINGS = [
  { key: "short", label: "Short passing" }, { key: "mixed", label: "Mixed" },
  { key: "direct", label: "Direct passing" }];
const PRESSINGS = [
  { key: "low_block", label: "Low block" }, { key: "mid", label: "Mid press" },
  { key: "high", label: "High press" }];
const ATTACK_STYLES = [
  { key: "balanced", label: "Balanced attack" },
  { key: "target_man", label: "🎯 Target man" },
  { key: "false_nine", label: "🎭 False nine" }];
const PRESETS: { name: string; icon: string; t: Record<string, string> }[] = [
  { name: "Tiki-Taka", icon: "🎨", t: { mentality: "balanced", tempo: "slow", passing: "short", pressing: "high" } },
  { name: "Gegenpress", icon: "⚡", t: { mentality: "attacking", tempo: "fast", passing: "mixed", pressing: "high" } },
  { name: "Counter-Attack", icon: "🗡️", t: { mentality: "defensive", tempo: "fast", passing: "direct", pressing: "low_block" } },
  { name: "Route One", icon: "🚀", t: { mentality: "balanced", tempo: "fast", passing: "direct", pressing: "mid" } },
  { name: "Park the Bus", icon: "🚌", t: { mentality: "defensive", tempo: "slow", passing: "direct", pressing: "low_block" } },
];

export default function LiveMatchWS({
  matchSid, initialFrame, squad, names, team, onDone,
}: {
  matchSid: string;
  initialFrame: LiveFrame | null;
  squad: ManagedSquadPlayer[];
  names: Record<string, string>;
  team: string;
  onDone: (state: ManagedState, lastStamina?: Record<string, number>) => void;
}) {
  const { frame: liveFrame, snapshot, feed, finalState, attempts, connected, failed, send } =
    useLiveSocket(matchSid);
  const frame = liveFrame || initialFrame;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [dim, setDim] = useState<"2d" | "3d">(
    () => (localStorage.getItem("wc26_view_dim") as "2d" | "3d") || "2d");
  const [panel, setPanel] = useState<"tactics" | "subs" | null>(null);
  const [subOut, setSubOut] = useState<string | null>(null);
  const [mute, setMute] = useState(isMuted());
  const kicked = useRef(false);
  const soundedKey = useRef("");

  const byId = useMemo(() => Object.fromEntries(squad.map((p) => [p.id, p])), [squad]);
  const snap = snapshot || frame?.snapshot || null;
  const done = !!snap?.done;
  const atBreak = snap?.break || null;

  // Kick off automatically once the socket is live (server starts paused).
  useEffect(() => {
    if (connected && !kicked.current && !done) {
      kicked.current = true;
      send({ action: "resume" });
      setPlaying(true);
    }
  }, [connected, done, send]);

  // Server auto-pauses at HT/ET/FT — mirror it locally.
  useEffect(() => {
    if (atBreak || done) setPlaying(false);
  }, [atBreak, done]);

  // Stadium atmosphere + cue sounds from the frame's event stream.
  useEffect(() => {
    if (!mute) crowd.start();
    return () => crowd.stop();
  }, [mute]);
  useEffect(() => {
    if (!frame?.events?.length) return;
    const key = `${frame.minute}-${frame.events.length}-${feed.length}`;
    if (key === soundedKey.current) return;
    soundedKey.current = key;
    for (const e of frame.events) {
      if (e.type === "GOAL" || e.type === "goal") { sound.goal(); crowd.roar(); }
      else if (e.type === "SHOT") crowd.excite(1);
      else if (e.type === "CORNER") crowd.excite(0.5);
      else if (e.type === "red" || e.type === "RED" || e.type === "injury" || e.type === "INJURY") {
        sound.red(); crowd.groan();
      }
    }
  }, [frame, feed.length]);
  useEffect(() => {
    if (atBreak === "HT" || atBreak === "ET") sound.whistle();
    if (done) sound.fullTimeWhistle();
  }, [atBreak, done]);

  // Forced decision when one of ours goes down injured.
  useEffect(() => {
    if (frame?.events?.some((e) => (e.type === "INJURY" || e.type === "injury") && e.team === team)) {
      setPanel("subs");
    }
  }, [frame, team]);

  if (!frame || !snap) {
    // Pre-first-frame state: never hang silently — show what the socket is
    // doing and give a way out when the session is unrecoverable.
    return (
      <div className="card flex h-64 flex-col items-center justify-center gap-3 text-txt-secondary">
        {failed ? (
          <>
            <div className="text-danger">Couldn't reach the match session.</div>
            <div className="max-w-md text-center text-xs">
              The server doesn't know this match (it may have restarted, or the
              30-minute reconnect window passed). Go back and kick off again.
            </div>
            <button className="btn-primary" onClick={() => window.location.reload()}>↻ Reload</button>
          </>
        ) : (
          <>
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span>{attempts > 0 ? `Reconnecting (attempt ${attempts}/5)…` : "Connecting to the match…"}</span>
          </>
        )}
      </div>
    );
  }

  const home = snap.home, away = snap.away;
  const setTactics = (t: Record<string, string | boolean>) => send({ action: "tactics", ...t });
  const makeSub = (outId: string, inId: string) => {
    send({ action: "sub", out_id: outId, in_id: inId });
    setSubOut(null);
  };
  const togglePlay = () => {
    if (done) return;
    const next = !playing;
    send({ action: next ? "resume" : "pause" });
    setPlaying(next);
  };
  const pickSpeed = (s: number) => { setSpeed(s); send({ action: "speed", speed: s }); };
  const pickDim = (d: "2d" | "3d") => { setDim(d); localStorage.setItem("wc26_view_dim", d); };
  const toggleMute = () => {
    const next = !mute;
    setMuted(next); setMute(next);
    if (!next) crowd.start();
  };

  const us = snap.our_side === "home"
    ? { gf: snap.home_goals, ga: snap.away_goals }
    : { gf: snap.away_goals, ga: snap.home_goals };
  const ratings = snap.player_ratings || finalState?.last_ratings || [];

  return (
    <div className="space-y-3">
      {/* FM-style scoreboard bar */}
      <div className="scoreboard">
        <span className="text-3xl">{flag(home)}</span>
        <span className="team">{names[home] || home}</span>
        <span className="score tabular-nums">{snap.home_goals}–{snap.away_goals}</span>
        <span className="team">{names[away] || away}</span>
        <span className="text-3xl">{flag(away)}</span>
        <div className="ml-4 flex items-center gap-1 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
          <span className="font-display text-2xl tabular-nums text-txt-primary">{frame.minute}'</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-txt-secondary">
            {frame.match_phase}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!done && (
            <button onClick={togglePlay} className="btn-primary text-sm">
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
          )}
          {[1, 2, 4].map((s) => (
            <button key={s} onClick={() => pickSpeed(s)}
              className={`rounded-full px-2 py-1 text-xs ${speed === s ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary"}`}>
              {s}×
            </button>
          ))}
          <button onClick={() => { setPanel(panel === "tactics" ? null : "tactics"); }}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${panel === "tactics" ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary"}`}>
            📋 Tactics
          </button>
          <button onClick={() => { setPanel(panel === "subs" ? null : "subs"); }}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${panel === "subs" ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary"}`}>
            🔁 Subs <span className="text-[10px] opacity-70">({snap.subs_remaining})</span>
          </button>
        </div>
      </div>

      {/* reconnect overlay */}
      {attempts > 0 && !failed && (
        <div className="card flex items-center justify-center gap-3 p-3 text-sm text-txt-secondary">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Reconnecting (attempt {attempts}/5)…
        </div>
      )}
      {failed && (
        <div className="card p-3 text-center text-sm text-danger">
          Connection lost. Refresh the page — your match is kept alive for 30 minutes.
        </div>
      )}

      {/* main stage: event feed | pitch */}
      <div className="flex gap-3">
        <div className="hidden md:block" style={{ height: "auto" }}>
          <EventFeed feed={feed} names={names} ourTeam={team} />
        </div>
        <div className="relative min-w-0 flex-1">
          {dim === "3d" ? (
            <Suspense fallback={
              <div className="flex w-full items-center justify-center rounded-2xl border border-white/10 bg-ink/60"
                style={{ aspectRatio: "16/9" }}>
                <span className="animate-pulse font-display text-lg text-txt-secondary">Building the stadium…</span>
              </div>
            }>
              <LivePitch3D frame={frame} away={away} running={playing && !done} />
            </Suspense>
          ) : (
            <LivePitch2D frame={frame} home={home} away={away} running={playing && !done} />
          )}
          {/* mini-radar — always visible top-right */}
          <div className="absolute right-2 top-2 z-30">
            <MiniRadar positions={frame.player_positions || []} ball={frame.ball_xy || [50, 50]} />
          </div>
          <div className="absolute bottom-2 left-2 z-30 flex gap-1">
            {(["2d", "3d"] as const).map((d) => (
              <button key={d} onClick={() => pickDim(d)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold backdrop-blur ${
                  dim === d ? "bg-accent text-ink" : "bg-ink/60 text-txt-secondary hover:bg-ink/80"}`}>
                {d === "2d" ? "2D" : "🏟 3D"}
              </button>
            ))}
            <button onClick={toggleMute} title="Crowd + effects"
              className="rounded-full bg-ink/60 px-2 py-0.5 text-[10px] font-bold text-txt-secondary backdrop-blur hover:bg-ink/80">
              {mute ? "🔇" : "🔊"}
            </button>
          </div>
        </div>
      </div>

      {/* bottom HUD */}
      <HUDBar minute={frame.minute} phase={frame.match_phase}
        homeGoals={snap.home_goals} awayGoals={snap.away_goals}
        home={names[home] || home} away={names[away] || away}
        stats={frame.stats || null} />

      {/* break / FT banners */}
      <AnimatePresence>
        {atBreak === "HT" && !playing && !done && (
          <Banner key="ht" title="HALF-TIME" sub="Adjust your approach, make changes, then resume.">
            <MentalityRow value={snap.mentality} onPick={(m) => setTactics({ mentality: m })} />
            <button onClick={togglePlay} className="btn-primary mt-3">▶ Second half</button>
          </Banner>
        )}
        {atBreak === "ET" && !playing && !done && (
          <Banner key="et" title="EXTRA TIME"
            sub={`Level at ${snap.home_goals}:${snap.away_goals} after 90 — 30 more minutes.`}>
            <MentalityRow value={snap.mentality} onPick={(m) => setTactics({ mentality: m })} />
            <button onClick={togglePlay} className="btn-primary mt-3">▶ Play extra time</button>
          </Banner>
        )}
        {done && (
          <Banner key="ft"
            title={us.gf > us.ga || (snap.penalties && wonPens(snap)) ? "FULL TIME — YOU WIN! 🎉"
              : us.gf === us.ga && !snap.penalties ? "FULL TIME — DRAW" : "FULL TIME"}
            sub={snap.penalties
              ? `${snap.home_pens}–${snap.away_pens} on penalties`
              : `${names[home]} ${snap.home_goals} : ${snap.away_goals} ${names[away]}`}>
            <button onClick={() => finalState && onDone(finalState, snap.stamina)} disabled={!finalState}
              className="btn-primary mt-2">
              Continue →
            </button>
          </Banner>
        )}
      </AnimatePresence>

      {/* post-match ratings */}
      {done && ratings.length > 0 && <RatingsPanel ratings={ratings} />}

      {/* tactics panel */}
      {panel === "tactics" && !done && (
        <div className="card space-y-3 p-4">
          <div className="text-xs uppercase tracking-wider text-accent">Match tactics — applied immediately</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const active = Object.entries(p.t).every(([k, v]) => (snap as any)[k] === v);
              return (
                <button key={p.name} onClick={() => setTactics(p.t)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${active ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
                  {p.icon} {p.name}
                </button>
              );
            })}
          </div>
          <DialRow label="Mentality" options={MENTALITIES.map((m) => ({ key: m.key, label: `${m.icon} ${m.label}` }))}
            value={snap.mentality} onPick={(v) => setTactics({ mentality: v })} />
          <DialRow label="Tempo" options={TEMPOS} value={snap.tempo} onPick={(v) => setTactics({ tempo: v })} />
          <DialRow label="Passing" options={PASSINGS} value={snap.passing} onPick={(v) => setTactics({ passing: v })} />
          <DialRow label="Pressing" options={PRESSINGS} value={snap.pressing} onPick={(v) => setTactics({ pressing: v })} />
          <DialRow label="Attack" options={ATTACK_STYLES} value={snap.attack_style} onPick={(v) => setTactics({ attack_style: v })} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-20 text-xs uppercase tracking-wide text-txt-secondary">Game mgmt</span>
            <button onClick={() => setTactics({ time_wasting: !snap.time_wasting })}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${snap.time_wasting ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
              ⏳ Time-wasting {snap.time_wasting ? "ON" : "off"}
            </button>
          </div>
          <div className="text-xs text-txt-secondary">
            Opposition: <b className="text-txt-primary">{snap.opp_mentality}</b>
            {snap.our_red != null && <span className="text-danger"> · You are down to 10 men ({snap.our_red}').</span>}
            {snap.opp_red != null && <span className="text-accent"> · They are down to 10 men ({snap.opp_red}').</span>}
          </div>
        </div>
      )}

      {/* substitutions panel */}
      {panel === "subs" && !done && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-accent">
              Substitutions — {snap.subs_remaining} remaining
            </div>
            {subOut && <button onClick={() => setSubOut(null)} className="text-xs text-txt-secondary">cancel</button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[10px] uppercase text-txt-secondary">
                On the pitch {subOut ? "" : "— pick who comes OFF"}
              </div>
              <div className="space-y-1">
                {snap.xi.map((id) => (
                  <PlayerRow key={id} p={byId[id]} stamina={snap.stamina[id]}
                    form={snap.form?.[id]} active={subOut === id}
                    dim={!!subOut && subOut !== id} hurt={snap.injured.includes(id)}
                    onClick={() => setSubOut(subOut === id ? null : id)} />
                ))}
              </div>
            </div>
            <div className={subOut ? "" : "opacity-40"}>
              <div className="mb-1 text-[10px] uppercase text-txt-secondary">
                Bench {subOut ? "— pick who comes ON" : ""}
              </div>
              <div className="space-y-1">
                {snap.bench.map((id) => (
                  <PlayerRow key={id} p={byId[id]} stamina={100} form={snap.form?.[id]} fresh
                    onClick={() => subOut && snap.subs_remaining > 0 && makeSub(subOut, id)} />
                ))}
              </div>
            </div>
          </div>
          {snap.subs.length > 0 && (
            <div className="mt-2 text-[11px] text-txt-secondary">
              {snap.subs.map((s, i) => <span key={i} className="mr-3">↕️ {s.minute}' {s.in} ↔ {s.out}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function wonPens(s: { our_side: string; home_pens: number | null; away_pens: number | null }): boolean {
  const ours = s.our_side === "home" ? s.home_pens : s.away_pens;
  const theirs = s.our_side === "home" ? s.away_pens : s.home_pens;
  return (ours ?? 0) > (theirs ?? 0);
}

export function formDotColour(form?: number): string {
  if (form == null) return "#8b949e";
  return form >= 0.7 ? "#00d4aa" : form >= 0.5 ? "#e3b341" : "#e63946";
}

function DialRow({ label, options, value, onPick }: {
  label: string; options: { key: string; label: string }[]; value: string; onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 text-xs uppercase tracking-wide text-txt-secondary">{label}</span>
      {options.map((o) => (
        <button key={o.key} onClick={() => onPick(o.key)}
          className={`rounded-full px-3 py-1 text-sm font-semibold ${value === o.key ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
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
          className={`rounded-full px-3 py-1.5 text-sm font-semibold ${value === m.key ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
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
      <div className="font-display text-3xl tracking-wide text-accent">{title}</div>
      {sub && <div className="mt-1 text-sm text-txt-secondary">{sub}</div>}
      <div className="mt-3">{children}</div>
    </motion.div>
  );
}

function PlayerRow({ p, stamina, form, active, dim, fresh, hurt, onClick }: {
  p?: ManagedSquadPlayer; stamina?: number; form?: number; active?: boolean;
  dim?: boolean; fresh?: boolean; hurt?: boolean; onClick?: () => void;
}) {
  if (!p) return null;
  const st = stamina ?? 100;
  const col = st > 65 ? "bg-emerald-400" : st > 40 ? "bg-amber-400" : "bg-red-400";
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition
        ${active ? "bg-accent/20 ring-1 ring-accent" : dim ? "opacity-40" : "bg-ink/50 hover:bg-white/10"}`}>
      <span className="w-7 rounded bg-white/10 text-center text-[10px]">{p.position}</span>
      <span className="h-2 w-2 shrink-0 rounded-full" title={`form ${form ?? "—"}`}
        style={{ background: formDotColour(form) }} />
      <span className="min-w-0 flex-1 truncate">{hurt && "🩹 "}{p.name}</span>
      <span className="text-xs font-bold text-accent">{p.rating}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
        <span className={`block h-full ${col}`} style={{ width: `${fresh ? 100 : st}%` }} />
      </span>
    </button>
  );
}
