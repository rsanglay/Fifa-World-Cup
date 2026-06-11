import { useEffect, useRef, useState } from "react";
import Confetti from "./Confetti";
import type { MatchEvent } from "../types";

/* Football-Manager-classic style 2D match view — v2 mechanics.
 *
 * Pure renderer of the server's minute-tick event stream. v2 replaces the
 * random ball-wander with the intent-based pattern real engines use:
 *
 *  - Possession state machine: the ball is always carried by a player or in
 *    flight between two. Open play = pass chains with turnovers, biased by
 *    possession; passes fly at constant speed (with a little "lift").
 *  - Goals choreograph a build-up: pass into the box -> SHOT -> net ->
 *    corner-flag celebration -> back to the centre spot for kick-off.
 *  - Chances/saves/woodwork/penalties/free kicks all resolve visually.
 *  - Players run with clamped speeds (no rubber-banding), shape slides with
 *    the ball and compresses when defending.
 *
 * Nothing rendered here can change the result — sim stays server-side.
 * Coordinates: x 0..100 (home attacks left -> right), y 0..100.
 */

type Shape = { d: number; m: number; f: number };
type Line = "GK" | "DEF" | "MID" | "FWD";

interface Dot { x: number; y: number; tx: number; ty: number; line: Line }
interface Flight {
  fx: number; fy: number; tx: number; ty: number;
  t0: number; dur: number; kind: "pass" | "shot" | "place";
  onLand?: () => void;
}
interface Flash { id: number; label: string; confetti: boolean }

const LINE_X_HOME: Record<Line, number> = { GK: 4.5, DEF: 20, MID: 42, FWD: 64 };
const PULL: Record<Line, number> = { GK: 0.02, DEF: 0.1, MID: 0.2, FWD: 0.28 };
const RUN_SPEED: Record<Line, number> = { GK: 7, DEF: 13, MID: 15, FWD: 17 }; // %/s
const PARTY_SPEED = 26;
const PASS_SPEED = 36;   // %/s
const SHOT_SPEED = 90;
const PLACE_SPEED = 30;
const CELEBRATE_MS = 2400;

function anchors(shape: Shape, home: boolean): { x: number; y: number; line: Line }[] {
  const rows: [Line, number][] = [["GK", 1], ["DEF", shape.d], ["MID", shape.m], ["FWD", shape.f]];
  const out: { x: number; y: number; line: Line }[] = [];
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
  possession?: number; // 0..1 home-ball bias
}) {
  const homeShape = ourSide === "home" ? ourShape : oppShape;
  const awayShape = ourSide === "away" ? ourShape : oppShape;

  const ball = useRef({ x: 50, y: 50, lift: 0 });
  const flight = useRef<Flight | null>(null);
  const carrier = useRef<{ home: boolean; idx: number } | null>(null);
  const kickoffSide = useRef<boolean | null>(null); // who restarts after a goal
  const nextActionAt = useRef(0);
  const frozenUntil = useRef(0);
  const homeDots = useRef<Dot[]>([]);
  const awayDots = useRef<Dot[]>([]);
  const celebrate = useRef<{ until: number; home: boolean } | null>(null);
  const eventKey = useRef("");
  const staged = useRef<number[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [, force] = useState(0);

  const later = (fn: () => void, ms: number) => { staged.current.push(window.setTimeout(fn, ms)); };
  useEffect(() => () => staged.current.forEach(window.clearTimeout), []);

  useEffect(() => {
    homeDots.current = anchors(homeShape, true).map((a) => ({ ...a, tx: a.x, ty: a.y }));
  }, [homeShape.d, homeShape.m, homeShape.f]); // eslint-disable-line
  useEffect(() => {
    awayDots.current = anchors(awayShape, false).map((a) => ({ ...a, tx: a.x, ty: a.y }));
  }, [awayShape.d, awayShape.m, awayShape.f]); // eslint-disable-line

  /* ------------------------------------------------------------ ball flights */
  const fly = (tx: number, ty: number, speed: number, kind: Flight["kind"], onLand?: () => void) => {
    const b = ball.current;
    const dist = Math.hypot(tx - b.x, ty - b.y);
    carrier.current = null;
    flight.current = {
      fx: b.x, fy: b.y, tx, ty, t0: performance.now(),
      dur: Math.max(120, (dist / speed) * 1000), kind, onLand,
    };
  };
  const dotOf = (home: boolean, idx: number): Dot | undefined =>
    (home ? homeDots.current : awayDots.current)[idx];
  const freeze = (ms: number) => { frozenUntil.current = performance.now() + ms; };
  const show = (label: string, confetti = false, ttl = 1800) => {
    const id = performance.now();
    setFlash({ id, label, confetti });
    later(() => setFlash((f) => (f?.id === id ? null : f)), ttl);
  };

  /* Pick a pass target for `home` team: prefer progressing the ball. */
  const pickReceiver = (home: boolean, exclude: number | null): number => {
    const dots = home ? homeDots.current : awayDots.current;
    const dir = home ? 1 : -1;
    const bx = ball.current.x;
    let best = -1, bestW = -1;
    dots.forEach((d, i) => {
      if (i === exclude || d.line === "GK") return;
      const progress = (d.x - bx) * dir;                  // forward = good
      const near = 40 - Math.min(40, Math.hypot(d.x - bx, d.y - ball.current.y));
      const w = 8 + Math.max(0, progress) * 2.2 + near * 0.5 + Math.random() * 26;
      if (w > bestW) { bestW = w; best = i; }
    });
    return best < 0 ? 1 : best;
  };

  /* One open-play decision: keep passing, or turn the ball over. */
  const openPlay = (now: number) => {
    const bias = possession ?? 0.5;
    let side: boolean;
    if (carrier.current) side = carrier.current.home;
    else if (kickoffSide.current !== null) { side = kickoffSide.current; kickoffSide.current = null; }
    else side = Math.random() < bias;

    const favoured = side ? bias : 1 - bias;             // 0..1, higher = keeps ball more
    const turnover = Math.random() > 0.55 + favoured * 0.38;
    if (turnover && carrier.current) {
      // Loose ball: nearest opponent picks it up.
      const opp = !side;
      const dots = opp ? homeDots.current : awayDots.current;
      let best = 1, bd = 1e9;
      dots.forEach((d, i) => {
        if (d.line === "GK") return;
        const dd = Math.hypot(d.x - ball.current.x, d.y - ball.current.y);
        if (dd < bd) { bd = dd; best = i; }
      });
      carrier.current = { home: opp, idx: best };
      nextActionAt.current = now + 360 + Math.random() * 380;
      return;
    }
    const idx = pickReceiver(side, carrier.current?.idx ?? null);
    const d = dotOf(side, idx);
    if (!d) return;
    const dir = side ? 1 : -1;
    fly(
      Math.max(3, Math.min(97, d.x + dir * 1.5)),
      Math.max(4, Math.min(96, d.y + (Math.random() - 0.5) * 3)),
      PASS_SPEED, "pass",
      () => {
        carrier.current = { home: side, idx };
        nextActionAt.current = performance.now() + 300 + Math.random() * 450;
      },
    );
  };

  /* ----------------------------------------------------- event choreography */
  useEffect(() => {
    if (!lastEvent) return;
    const k = `${lastEvent.minute}-${lastEvent.type}-${lastEvent.scorer_id}-${lastEvent.team}`;
    if (k === eventKey.current) return;
    eventKey.current = k;

    const evHome = (lastEvent as any).__home === true;
    const ours = evHome === (ourSide === "home");
    const dir = evHome ? 1 : -1;
    const goalMouth = { x: evHome ? 98.5 : 1.5, y: 47 + Math.random() * 6 };
    const boxEdge = { x: evHome ? 84 : 16, y: 32 + Math.random() * 36 };
    const penSpot = { x: evHome ? 88 : 12, y: 50 };
    const fkSpot = { x: evHome ? 70 + Math.random() * 9 : 30 - Math.random() * 9, y: 22 + Math.random() * 56 };
    const gkPos = { x: evHome ? 97 : 3, y: 50 };

    const celebrateGoal = (label: string) => {
      celebrate.current = { until: performance.now() + CELEBRATE_MS, home: evHome };
      show(label, ours, CELEBRATE_MS);
      later(() => {
        // Kick-off: centre spot, conceding side restarts.
        fly(50, 50, PLACE_SPEED, "place", () => {
          kickoffSide.current = !evHome;
          nextActionAt.current = performance.now() + 700;
        });
      }, CELEBRATE_MS - 200);
      freeze(CELEBRATE_MS + 1500);
    };

    if (lastEvent.type === "goal") {
      const src = lastEvent.source;
      const label =
        src === "penalty" ? `🎯 PENALTY GOAL — ${lastEvent.scorer}`
          : src === "freekick" ? `🚀 FREE KICK GOAL — ${lastEvent.scorer}`
          : `⚽ GOAL — ${lastEvent.scorer}`;
      freeze(9000);
      if (src === "penalty" || src === "freekick") {
        const spot = src === "penalty" ? penSpot : fkSpot;
        fly(spot.x, spot.y, PLACE_SPEED, "place", () => {
          show(src === "penalty" ? "🎯 Penalty…" : `🚀 Free kick — ${lastEvent.scorer}…`, false, 950);
          later(() => fly(goalMouth.x, goalMouth.y, SHOT_SPEED, "shot",
            () => celebrateGoal(label)), 1000);
        });
      } else {
        // Build-up: ball into the box, then the finish.
        fly(boxEdge.x, boxEdge.y, PASS_SPEED + 8, "pass", () => {
          later(() => fly(goalMouth.x, goalMouth.y, SHOT_SPEED, "shot",
            () => celebrateGoal(label)), 260);
        });
      }
    } else if (lastEvent.type === "penalty_miss") {
      freeze(5200);
      fly(penSpot.x, penSpot.y, PLACE_SPEED, "place", () => {
        show("🎯 Penalty…", false, 950);
        later(() => {
          if (lastEvent.outcome === "saved") {
            fly(gkPos.x, gkPos.y, SHOT_SPEED, "shot", () => {
              show(`🧤 SAVED! ${lastEvent.scorer} is denied`, false, 1700);
              // Keeper clears upfield.
              later(() => fly(50 - dir * 14, 20 + Math.random() * 60, PASS_SPEED, "pass",
                () => { carrier.current = null; nextActionAt.current = performance.now() + 300; }), 1100);
            });
          } else {
            fly(evHome ? 99 : 1, Math.random() < 0.5 ? 14 : 86, SHOT_SPEED, "shot", () => {
              show(`❌ ${lastEvent.scorer} misses the penalty!`, false, 1700);
              later(() => fly(gkPos.x, 50, PLACE_SPEED, "place",
                () => { carrier.current = null; nextActionAt.current = performance.now() + 500; }), 1200);
            });
          }
        }, 1000);
      });
    } else if (lastEvent.type === "chance") {
      const fk = lastEvent.set_piece === "freekick";
      freeze(fk ? 4200 : 3000);
      const start = fk ? fkSpot : boxEdge;
      fly(start.x, start.y, fk ? PLACE_SPEED : PASS_SPEED + 6, fk ? "place" : "pass", () => {
        if (fk) show(`🚀 Free kick — ${lastEvent.scorer}`, false, 950);
        later(() => {
          if (lastEvent.outcome === "saved") {
            fly(gkPos.x, gkPos.y, SHOT_SPEED, "shot", () =>
              later(() => fly(50 - dir * 10, 25 + Math.random() * 50, PASS_SPEED, "pass",
                () => { carrier.current = null; nextActionAt.current = performance.now() + 300; }), 800));
          } else if (lastEvent.outcome === "woodwork") {
            fly(evHome ? 98.5 : 1.5, Math.random() < 0.5 ? 42 : 58, SHOT_SPEED, "shot", () =>
              // Rebound off the post back into play.
              fly(boxEdge.x - dir * 8, 30 + Math.random() * 40, PASS_SPEED + 10, "pass",
                () => { carrier.current = null; nextActionAt.current = performance.now() + 250; }));
          } else {
            fly(evHome ? 99.5 : 0.5, Math.random() < 0.5 ? 18 : 82, SHOT_SPEED, "shot", () =>
              later(() => fly(gkPos.x, 50, PLACE_SPEED, "place",
                () => { carrier.current = null; nextActionAt.current = performance.now() + 600; }), 700));
          }
        }, fk ? 1000 : 240);
      });
    } else if (lastEvent.type === "red" || lastEvent.type === "yellow") {
      show(`${lastEvent.type === "red" ? "🟥" : "🟨"} ${lastEvent.scorer}`, false, 1400);
    }
  }, [lastEvent, ourSide]); // eslint-disable-line

  /* -------------------------------------------------------------- animation */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (running) {
        const b = ball.current;

        // Ball: in flight, carried, or awaiting the next open-play action.
        const fl = flight.current;
        if (fl) {
          const t = Math.min(1, (now - fl.t0) / fl.dur);
          const ease = fl.kind === "shot" ? t : t * (2 - t); // passes decelerate, shots don't
          b.x = fl.fx + (fl.tx - fl.fx) * ease;
          b.y = fl.fy + (fl.ty - fl.fy) * ease;
          b.lift = fl.kind === "place" ? 0 : Math.sin(Math.PI * t) * (fl.kind === "shot" ? 0.25 : 0.8);
          if (t >= 1) { flight.current = null; b.lift = 0; fl.onLand?.(); }
        } else if (carrier.current) {
          const d = dotOf(carrier.current.home, carrier.current.idx);
          if (d) {
            const dir = carrier.current.home ? 1 : -1;
            b.x += (d.x + dir * 1.4 - b.x) * Math.min(1, dt * 10);
            b.y += (d.y - b.y) * Math.min(1, dt * 10);
          }
        }
        if (!flight.current && now > frozenUntil.current && now > nextActionAt.current) {
          openPlay(now);
        }

        // Players: targets from anchors + ball pull, clamped running speeds.
        const celeb = celebrate.current && now < celebrate.current.until ? celebrate.current : null;
        if (celebrate.current && !celeb) celebrate.current = null;
        const possHome = carrier.current ? carrier.current.home : (flight.current ? b.x < 50 : true);

        const move = (dots: Dot[], home: boolean, shape: Shape) => {
          const anc = anchors(shape, home);
          const defending = possHome !== home;
          const slide = (b.x - 50) * 0.16 + (defending ? (home ? -3.5 : 3.5) : (home ? 2 : -2));
          const partying = celeb !== null && celeb.home === home;
          const cornerX = celeb?.home ? 88 : 12;
          dots.forEach((d, i) => {
            const a = anc[i];
            if (!a) return;
            if (partying && a.line !== "GK") {
              d.tx = cornerX + ((i % 4) - 1.5) * 2.6;
              d.ty = 10 + Math.floor(i / 4) * 4 + Math.sin(now / 160 + i) * 1.8;
            } else {
              const pull = PULL[a.line];
              const wob = Math.sin(now / 700 + i * 1.7) * 1.2;
              d.tx = a.x + slide + (b.x - a.x) * pull;
              d.ty = a.y + (b.y - a.y) * pull * 1.5 + wob;
            }
            const dx = d.tx - d.x, dy = d.ty - d.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 0.01) {
              const vmax = partying ? PARTY_SPEED : RUN_SPEED[a.line];
              const ease = Math.min(1, dist / 3);          // soften arrival
              const stepLen = Math.min(dist, vmax * dt * (0.35 + 0.65 * ease) * (dist > 10 ? 1.5 : 1));
              d.x += (dx / dist) * stepLen;
              d.y += (dy / dist) * stepLen;
            }
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
  }, [running, homeShape, awayShape, possession]); // eslint-disable-line

  const ourIsHome = ourSide === "home";
  const b = ball.current;
  const ballScale = 1 + b.lift * 0.9;
  const carrierRef = carrier.current;

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "16/10", background: "repeating-linear-gradient(90deg, #0a7d34 0 12.5%, #0c8c3a 12.5% 25%)" }}>
      {/* pitch markings */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(255,255,255,0.05), rgba(0,0,0,0.18))" }} />
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
      {homeDots.current.map((d, i) => {
        const hasBall = carrierRef?.home === true && carrierRef.idx === i;
        return (
          <span key={`h${i}`}
            className={`absolute h-[3.2%] w-[2%] min-h-[9px] min-w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md ring-1 ${hasBall ? "ring-2 ring-white" : "ring-black/40"}`}
            style={{ left: `${d.x}%`, top: `${d.y}%`, background: ourIsHome ? "#fbbf24" : "#60a5fa" }} />
        );
      })}
      {awayDots.current.map((d, i) => {
        const hasBall = carrierRef?.home === false && carrierRef.idx === i;
        return (
          <span key={`a${i}`}
            className={`absolute h-[3.2%] w-[2%] min-h-[9px] min-w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md ring-1 ${hasBall ? "ring-2 ring-white" : "ring-black/40"}`}
            style={{ left: `${d.x}%`, top: `${d.y}%`, background: ourIsHome ? "#60a5fa" : "#fbbf24" }} />
        );
      })}

      {/* ball (with flight "lift" and a soft shadow) */}
      <span className="absolute -translate-x-1/2 rounded-full bg-black/30 blur-[1px]"
        style={{ left: `${b.x}%`, top: `${b.y + 1.2}%`, width: "1.1%", height: "1.2%", minWidth: 5, minHeight: 4 }} />
      <span className="absolute h-[2%] w-[1.25%] min-h-[6px] min-w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg ring-1 ring-black/50"
        style={{ left: `${b.x}%`, top: `${b.y - b.lift * 1.6}%`, transform: `translate(-50%,-50%) scale(${ballScale})` }} />

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
