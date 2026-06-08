import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { flag } from "../api/client";
import { sound } from "../lib/sound";
import type { KnockoutMatch } from "../types";

/* Animated single match: a clock ticks up and goals pop at their minute, then
   a penalty shootout if the match needed one. Used for the Final. */
export default function LiveMatch({
  match,
  names,
  durationMs = 7000,
}: {
  match: KnockoutMatch;
  names: Record<string, string>;
  durationMs?: number;
}) {
  const fullTime = match.extra_time ? 120 : 90;
  const events = (match.events || []).slice().sort((a, b) => a.minute - b.minute);
  const [clock, setClock] = useState(0);
  const [shootout, setShootout] = useState(false);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setClock(Math.round(t * fullTime));
      if (t < 1) raf = requestAnimationFrame(tick);
      else if (match.penalties) setTimeout(() => setShootout(true), 500);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [match, durationMs, fullTime]);

  const shown = events.filter((e) => e.minute <= clock);
  const goals = shown.filter((e) => e.type !== "red");
  const hg = goals.filter((e) => e.team === match.home).length;
  const ag = goals.filter((e) => e.team === match.away).length;

  // Play a cue as each event is revealed by the ticking clock.
  const seen = useRef(0);
  useEffect(() => {
    if (shown.length > seen.current) {
      const latest = shown[shown.length - 1];
      if (latest?.type === "red") sound.red();
      else sound.goal();
    }
    seen.current = shown.length;
  }, [shown.length]);

  return (
    <div className="card relative overflow-hidden p-6">
      <div className="absolute right-4 top-3 flex items-center gap-1 text-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="font-mono tabular-nums text-white/70">
          {clock}'{clock >= 90 && clock < fullTime ? " (ET)" : ""}
        </span>
      </div>

      <div className="grid grid-cols-3 items-center gap-2">
        <Team code={match.home || ""} name={names[match.home || ""] || match.home || ""} />
        <div className="text-center">
          <motion.div
            key={`${hg}-${ag}`}
            initial={{ scale: 1.4 }}
            animate={{ scale: 1 }}
            className="font-display text-6xl tabular-nums"
          >
            {hg}<span className="text-white/30">:</span>{ag}
          </motion.div>
        </div>
        <Team code={match.away || ""} name={names[match.away || ""] || match.away || ""} />
      </div>

      {/* Goal feed */}
      <div className="mt-5 min-h-[60px] space-y-1">
        <AnimatePresence>
          {shown.map((e, i) => (
            <motion.div
              key={`${e.minute}-${i}`}
              initial={{ opacity: 0, x: e.team === match.home ? -20 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex items-center gap-2 text-sm ${
                e.team === match.away ? "flex-row-reverse text-right" : ""
              }`}
            >
              <span className="text-white/40">{e.minute}'</span>
              <span>{e.type === "red" ? "🟥" : "⚽"}</span>
              <span className="font-medium">{e.scorer}</span>
              {e.assist && <span className="text-[11px] text-white/30">({e.assist})</span>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {shootout && match.penalties && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-xl bg-ink/70 p-4 text-center"
        >
          <div className="text-xs uppercase tracking-widest text-gold">Penalty shootout</div>
          <div className="mt-2 font-display text-4xl tabular-nums">
            {match.home_pens} <span className="text-white/30">–</span> {match.away_pens}
          </div>
          <div className="mt-1 text-sm text-white/60">
            {flag(match.winner || "")} {names[match.winner || ""]} win on penalties
          </div>
        </motion.div>
      )}
    </div>
  );
}

function Team({ code, name }: { code: string; name: string }) {
  return (
    <div className="text-center">
      <div className="text-6xl">{flag(code)}</div>
      <div className="mt-1 font-semibold">{name}</div>
    </div>
  );
}
