import { useEffect, useRef, useState } from "react";
import Confetti from "./Confetti";
import type { MatchEvent } from "../types";

/* Football-Manager-classic style 2D match view.
 *
 * Pure renderer: the simulation lives on the server (minute ticks); this
 * component interpolates 22 dots + a ball between formation anchors and
 * event-driven sequences — penalties and free kicks stage the ball at the
 * spot before the outcome, goals trigger a corner-flag celebration (and
 * confetti when it's YOUR goal). The same headless-sim / viewer split FM
 * itself uses — nothing rendered here can change the result.
 *
 * Coordinates: x 0..100 (home attacks left -> right), y 0..100.
 */

type Shape = { d: number; m: number; f: number };

interface Dot { x: number; y: number; tx: number; ty: number }
interface Flash { id: number; label: string; confetti: boolean }

const LINE_X_HOME = { GK: 4.5, DEF: 20, MID: 42, FWD: 64 };
const PULL = { GK: 0.02, DEF: 0.1, MID: 0.2, FWD: 0.28 };
const CELEBRATE_MS = 2400;

function anchors(shape: Shape, home: boolean): { x: number; y: number; line: keyof typeof PULL }[] {
  const rows: [keyof typeof LINE_X_HOME, number][] = [
    ["GK", 1], ["DEF", shape.d], ["MID", shape.m], ["FWD", shape.f],
  ];
  const out: { x: number; y: number; line: keyof typeof PULL }[] = [];
  rows.forEach(([line, n]) => {
    for (let i = 0; i < n; i++) {
      const x = home ? LINE_X_HOME[line] : 100 - LINE_X_HOME[line];
      out.push({ x, y: ((i + 1) / (n + 1)) * 100, line });
    }
  });
  return out;
}

export default function Pitch2D({
  ourShape, oppShape, ourSide, running, lastEvent, homeGoals, awayGoals, possession,
}: {
  ourShape: Shape;
  oppShape: Shape;
  ourSide: "home" | "away";
  running: boolean;
  lastEvent: MatchEvent | null;
  homeGoals: number;
  awayGoals: number;
  possession?: number; // 0..1 home-ball bias (cosmetic)
}) {
  const homeShape = ourSide === "home" ? ourShape : oppShape;
  const awayShape = ourSide === "away" ? ourShape : oppShape;

  const ball = useRef<Dot>({ x: 50, y: 50, tx: 50, ty: 50 });
  const homeDots = useRef<Dot[]>([]);
  const awayDots = useRef<Dot[]>([]);
  const wanderAt = useRef(0);
  const eventKey = useRef("");
  const celebrate = useRef<{ until: number; home: boolean } | null>(null);
  const staged = useRef<number[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [, force] = useState(0);

  const later = (fn: () => void, ms: number) => {
    staged.current.push(window.setTimeout(fn, ms));
  };
  useEffect(() => () => staged.current.forEach(window.clearTimeout), []);

  // (Re)build dot sets when shapes change (subs can reshape the team).
  useEffect(() => {
    homeDots.current = anchors(homeShape, true).map((a) => ({ x: a.x, y: a.y, tx: a.x, ty: a.y }));
  }, [homeShape.d, homeShape.m, homeShape.f]); // eslint-disable-line
  useEffect(() => {
    awayDots.current = anchors(awayShape, false).map((a) => ({ x: a.x, y: a.y, tx: a.x, ty: a.y }));
  }, [awayShape.d, awayShape.m, awayShape.f]); // eslint-disable-line

  // Event-driven sequences: goals, penalties, free kicks, cards.
  useEffect(() => {
    if (!lastEvent) return;
    const k = `${lastEvent.minute}-${lastEvent.type}-${lastEvent.scorer_id}-${lastEvent.team}`;
    if (k === eventKey.current) return;
    eventKey.current = k;

    const b = ball.current;
    const evHome = isHomeTeam(lastEvent);
    const ours = evHome === (ourSide === "home");
    const goalX = evHome ? 97 : 3;
    const spotX = evHome ? 88 : 12;
    const fkX = evHome ? 72 + Math.random() * 8 : 28 - Math.random() * 8;
    const show = (label: string, confetti = false, ttl = 1800) => {
      const id = performance.now();
      setFlash({ id, label, confetti });
      later(() => setFlash((f) => (f?.id === id ? null : f)), ttl);
    };
    const freeze = (ms: number) => { wanderAt.current = performance.now() + ms; };

    if (lastEvent.type === "goal") {
      const src = lastEvent.source;
      const bury = () => {
        b.tx = goalX; b.ty = 46 + Math.random() * 8;
        celebrate.current = { until: performance.now() + CELEBRATE_MS, home: evHome };
        show(
          src === "penalty" ? `🎯 PENALTY GOAL — ${lastEvent.scorer}`
            : src === "freekick" ? `🚀 FREE KICK GOAL — ${lastEvent.scorer}`
            : `⚽ GOAL — ${lastEvent.scorer}`,
          ours, CELEBRATE_MS,
        );
        // After the celebration: back to the centre spot for kick-off, both
        // teams reform (dots pull back to their anchors once the party ends),
        // short hold, then open play resumes.
        freeze(CELEBRATE_MS + 1500);
        later(() => { b.tx = 50; b.ty = 50; }, CELEBRATE_MS);
      };
      if (src === "penalty" || src === "freekick") {
        b.tx = src === "penalty" ? spotX : fkX;
        b.ty = src === "penalty" ? 50 : 25 + Math.random() * 50;
        show(src === "penalty" ? "🎯 Penalty…" : `🚀 Free kick — ${lastEvent.scorer}…`, false, 1000);
        freeze(3600);
        later(bury, 1000);
      } else {
        bury();
      }
    } else if (lastEvent.type === "penalty_miss") {
      b.tx = spotX; b.ty = 50;
      show("🎯 Penalty…", false, 1000);
      freeze(2800);
      later(() => {
        if (lastEvent.outcome === "saved") {
          b.tx = evHome ? 99 : 1; b.ty = 50; // into the keeper's arms
          show(`🧤 SAVED! ${lastEvent.scorer} is denied`, false, 1700);
        } else {
          b.tx = evHome ? 99 : 1; b.ty = Math.random() < 0.5 ? 16 : 84; // wide
          show(`❌ ${lastEvent.scorer} misses the penalty!`, false, 1700);
        }
      }, 1000);
    } else if (lastEvent.type === "chance") {
      if (lastEvent.set_piece === "freekick") {
        b.tx = fkX; b.ty = 25 + Math.random() * 50;
        show(`🚀 Free kick — ${lastEvent.scorer}`, false, 1200);
        freeze(2000);
        later(() => { b.tx = evHome ? 95 : 5; b.ty = 35 + Math.random() * 30; }, 900);
      } else {
        b.tx = evHome ? 86 : 14;
        b.ty = 40 + Math.random() * 20;
        freeze(1600);
      }
    } else if (lastEvent.type === "red" || lastEvent.type === "yellow") {
      show(`${lastEvent.type === "red" ? "🟥" : "🟨"} ${lastEvent.scorer}`, false, 1400);
    }
  }, [lastEvent, ourSide]); // eslint-disable-line

  // rAF animation loop — lerp dots toward targets, wander the ball.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (running) {
        const b = ball.current;
        if (now > wanderAt.current) {
          const bias = possession ?? 0.5;
          const cx = 28 + 44 * (Math.random() * 0.5 + bias * 0.5);
          b.tx = Math.max(6, Math.min(94, cx + (Math.random() - 0.5) * 26));
          b.ty = 12 + Math.random() * 76;
          wanderAt.current = now + 900 + Math.random() * 1100;
        }
        b.x += (b.tx - b.x) * Math.min(1, dt * 3.2);
        b.y += (b.ty - b.y) * Math.min(1, dt * 3.2);

        const celeb = celebrate.current && now < celebrate.current.until ? celebrate.current : null;
        if (celebrate.current && !celeb) celebrate.current = null;

        const move = (dots: Dot[], home: boolean, shape: Shape) => {
          const anc = anchors(shape, home);
          const slide = (b.x - 50) * 0.16;
          const partying = celeb !== null && celeb.home === home;
          const cornerX = celeb?.home ? 88 : 12;
          dots.forEach((d, i) => {
            const a = anc[i];
            if (!a) return;
            if (partying && a.line !== "GK") {
              // Mob the corner flag.
              d.tx = cornerX + ((i % 4) - 1.5) * 2.6;
              d.ty = 10 + Math.floor(i / 4) * 4 + Math.sin(now / 160 + i) * 1.8;
            } else {
              const pull = PULL[a.line];
              const wob = Math.sin(now / 700 + i * 1.7) * 1.6;
              d.tx = a.x + slide + (b.x - a.x) * pull;
              d.ty = a.y + (b.y - a.y) * pull * 1.5 + wob;
            }
            const speed = partying ? 3.4 : 2.4;
            d.x += (d.tx - d.x) * Math.min(1, dt * speed);
            d.y += (d.ty - d.y) * Math.min(1, dt * speed);
          });
        };
        move(homeDots.current, true, homeShape);
        move(awayDots.current, false, awayShape);
        force((c) => c + 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, homeShape, awayShape, possession]);

  const ourIsHome = ourSide === "home";
  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "16/10", background: "repeating-linear-gradient(90deg, #0a7d34 0 12.5%, #0c8c3a 12.5% 25%)" }}>
      {/* pitch markings */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-2 rounded border border-white/35" />
        <div className="absolute bottom-2 top-2 left-1/2 w-px bg-white/35" />
        <div className="absolute left-1/2 top-1/2 h-[34%] w-[21%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/35" />
        <div className="absolute left-2 top-1/2 h-[58%] w-[16%] -translate-y-1/2 border border-l-0 border-white/35" />
        <div className="absolute right-2 top-1/2 h-[58%] w-[16%] -translate-y-1/2 border border-r-0 border-white/35" />
        <div className="absolute left-2 top-1/2 h-[26%] w-[6%] -translate-y-1/2 border border-l-0 border-white/35" />
        <div className="absolute right-2 top-1/2 h-[26%] w-[6%] -translate-y-1/2 border border-r-0 border-white/35" />
        <div className="absolute left-[1px] top-1/2 h-[12%] w-[5px] -translate-y-1/2 bg-white/60" />
        <div className="absolute right-[1px] top-1/2 h-[12%] w-[5px] -translate-y-1/2 bg-white/60" />
      </div>

      {/* players */}
      {homeDots.current.map((d, i) => (
        <span key={`h${i}`} className="absolute h-[3.2%] w-[2%] min-h-[9px] min-w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md ring-1 ring-black/40"
          style={{ left: `${d.x}%`, top: `${d.y}%`, background: ourIsHome ? "#fbbf24" : "#60a5fa" }} />
      ))}
      {awayDots.current.map((d, i) => (
        <span key={`a${i}`} className="absolute h-[3.2%] w-[2%] min-h-[9px] min-w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md ring-1 ring-black/40"
          style={{ left: `${d.x}%`, top: `${d.y}%`, background: ourIsHome ? "#60a5fa" : "#fbbf24" }} />
      ))}
      {/* ball */}
      <span className="absolute h-[2%] w-[1.25%] min-h-[6px] min-w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg ring-1 ring-black/50"
        style={{ left: `${ball.current.x}%`, top: `${ball.current.y}%` }} />

      {/* confetti for OUR goals */}
      {flash?.confetti && <Confetti key={flash.id} pieces={140} />}

      {/* event banner */}
      {flash && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className={`rounded-xl px-5 py-2 font-display text-2xl tracking-wide shadow-xl ${
            flash.confetti ? "animate-bounce bg-gold text-ink" : "animate-pulse bg-ink/85 text-gold"}`}>
            {flash.label}
          </div>
        </div>
      )}
      <div className="absolute right-2 top-2 rounded bg-ink/70 px-2 py-0.5 font-display text-sm tabular-nums text-white/90">
        {homeGoals}:{awayGoals}
      </div>
      {!running && !flash && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <span className="rounded-lg bg-ink/80 px-4 py-1.5 text-sm font-semibold text-white/80">⏸ Paused</span>
        </div>
      )}
    </div>
  );
}

/** Is the event's team the home side of this fixture? (parent-set hint) */
function isHomeTeam(e: MatchEvent): boolean {
  return (e as any).__home === true;
}
