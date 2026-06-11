import { useEffect, useRef, useState } from "react";
import Confetti from "./Confetti";
import { MatchScene, type SceneFlash, type SceneShape } from "../lib/matchScene";
import type { MatchEvent } from "../types";

/* Football-Manager-classic style 2D match view — canvas renderer.
 *
 * Pure renderer of the shared MatchScene choreography model. v3 draws the
 * whole frame to ONE <canvas> (pitch cached offscreen, players/ball/trail on
 * top), so the 60fps hot path never touches React or the DOM — that is the
 * difference between "web page with moving divs" and FM-smooth. Banners,
 * score and confetti remain HTML overlays (they change rarely).
 */
export default function Pitch2D({
  ourShape, oppShape, ourSide, running, lastEvent, homeGoals, awayGoals, possession, scene,
}: {
  ourShape: SceneShape;
  oppShape: SceneShape;
  ourSide: "home" | "away";
  running: boolean;
  lastEvent: MatchEvent | null;
  homeGoals: number;
  awayGoals: number;
  possession?: number; // 0..1 home-ball bias
  scene: MatchScene;   // shared with the 3D view via MatchView
}) {
  const homeShape = ourSide === "home" ? ourShape : oppShape;
  const awayShape = ourSide === "away" ? ourShape : oppShape;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pitchLayer = useRef<HTMLCanvasElement | null>(null);
  const trail = useRef<{ x: number; y: number }[]>([]);
  const [flash, setFlash] = useState<SceneFlash | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => { scene.onFlash = setFlash; }, [scene]);
  useEffect(() => { scene.setShapes(homeShape, awayShape); },
    [homeShape.d, homeShape.m, homeShape.f, awayShape.d, awayShape.m, awayShape.f]); // eslint-disable-line
  useEffect(() => { scene.possession = possession ?? 0.5; }, [possession]); // eslint-disable-line

  /* ------------------------------------------------- canvas render loop */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const ourIsHome = ourSide === "home";

    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(2, Math.round(r.width * dpr));
      H = Math.max(2, Math.round(r.height * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        pitchLayer.current = drawPitchLayer(W, H);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const px = (x: number) => (x / 100) * W;
    const py = (y: number) => (y / 100) * H;
    const R = () => Math.max(4.5 * dpr, W * 0.010);      // player radius

    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (runningRef.current) {
        scene.step(now, dt);
        const t = trail.current;
        const lastP = t[t.length - 1];
        if (!lastP || Math.hypot(scene.ball.x - lastP.x, scene.ball.y - lastP.y) > 0.7) {
          t.push({ x: scene.ball.x, y: scene.ball.y });
          if (t.length > 8) t.shift();
        }
      }

      // ---- draw ----
      if (pitchLayer.current) ctx.drawImage(pitchLayer.current, 0, 0);
      else ctx.clearRect(0, 0, W, H);

      // trail
      const tr = trail.current;
      for (let i = 0; i < tr.length; i++) {
        ctx.globalAlpha = 0.05 + (i / tr.length) * 0.22;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(px(tr[i].x), py(tr[i].y), 1.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // players
      const car = scene.carrier;
      const drawTeam = (dots: typeof scene.homeDots, home: boolean) => {
        const outfield = home
          ? (ourIsHome ? "#fbbf24" : "#60a5fa")
          : (ourIsHome ? "#60a5fa" : "#fbbf24");
        const gk = home ? "#34d399" : "#e879b9";
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          const x = px(d.x), y = py(d.y), r = R();
          ctx.beginPath();
          ctx.arc(x, y + r * 0.35, r * 0.95, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(0,0,0,0.25)";          // soft drop shadow
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = d.line === "GK" ? gk : outfield;
          ctx.fill();
          const hasBall = car?.home === home && car.idx === i;
          ctx.lineWidth = (hasBall ? 2 : 1) * dpr;
          ctx.strokeStyle = hasBall ? "#ffffff" : "rgba(0,0,0,0.4)";
          ctx.stroke();
        }
      };
      drawTeam(scene.homeDots, true);
      drawTeam(scene.awayDots, false);

      // ball: shadow stays on the turf, the ball lifts and scales in flight
      const b = scene.ball;
      const br = Math.max(3 * dpr, W * 0.006);
      ctx.beginPath();
      ctx.arc(px(b.x), py(b.y) + br * 1.1, br * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fill();
      const scale = 1 + b.lift * 0.9;
      ctx.beginPath();
      ctx.arc(px(b.x), py(b.y) - b.lift * H * 0.016, br * scale, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.stroke();

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [scene, ourSide]);

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "16/10" }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

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

/* The static pitch (stripes + markings + vignette), rendered once per size
 * change to an offscreen canvas — the per-frame loop just blits it. */
function drawPitchLayer(W: number, H: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;

  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? "#0c8c3a" : "#0a7d34";
    g.fillRect((i * W) / 8, 0, W / 8 + 1, H);
  }
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.7);
  vg.addColorStop(0, "rgba(255,255,255,0.05)");
  vg.addColorStop(1, "rgba(0,0,0,0.18)");
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);

  const m = Math.round(W * 0.012);            // outer margin
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = Math.max(1, W / 900);
  g.strokeRect(m, m, W - 2 * m, H - 2 * m);
  g.beginPath(); g.moveTo(W / 2, m); g.lineTo(W / 2, H - m); g.stroke();
  g.beginPath(); g.arc(W / 2, H / 2, H * 0.17, 0, Math.PI * 2); g.stroke();

  const boxH = H * 0.58, boxW = W * 0.16;
  const sixH = H * 0.26, sixW = W * 0.06;
  g.strokeRect(m, (H - boxH) / 2, boxW, boxH);
  g.strokeRect(W - m - boxW, (H - boxH) / 2, boxW, boxH);
  g.strokeRect(m, (H - sixH) / 2, sixW, sixH);
  g.strokeRect(W - m - sixW, (H - sixH) / 2, sixW, sixH);
  // penalty spots + arcs
  g.fillStyle = "rgba(255,255,255,0.5)";
  [[W * 0.11, H / 2], [W * 0.89, H / 2]].forEach(([x, y]) => {
    g.beginPath(); g.arc(x, y, Math.max(1.5, W / 600), 0, Math.PI * 2); g.fill();
  });
  g.beginPath(); g.arc(W * 0.11, H / 2, H * 0.155, -0.9, 0.9); g.stroke();
  g.beginPath(); g.arc(W * 0.89, H / 2, H * 0.155, Math.PI - 0.9, Math.PI + 0.9); g.stroke();
  // goals
  g.fillStyle = "rgba(255,255,255,0.6)";
  g.fillRect(0, H / 2 - H * 0.06, Math.max(2, W * 0.004), H * 0.12);
  g.fillRect(W - Math.max(2, W * 0.004), H / 2 - H * 0.06, Math.max(2, W * 0.004), H * 0.12);
  return c;
}
