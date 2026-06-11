import { useEffect, useRef } from "react";
import PitchSVG from "./PitchSVG";
import type { LiveFrame, PlayerPos } from "../../types";

/* 2D live pitch — pure renderer of server frames.
 *
 * The SVG draws the turf; every player dot is a DOM element (18px circle)
 * with an accessible title, positioned through CSS transforms so movement
 * between server frames glides with
 *   transition: transform 450ms cubic-bezier(0.25, 0.46, 0.45, 0.94)
 * The ball is lerped to its new target over 300ms with requestAnimationFrame.
 * Home = white with navy number; away = team colour with white number. */

const TEAM_COLOURS: Record<string, string> = {
  BRA: "#ffd700", ARG: "#75aadb", FRA: "#1f4fa3", GER: "#222222",
  ESP: "#c60b1e", ENG: "#cf081f", POR: "#046a38", NED: "#ff7f00",
  MEX: "#006847", USA: "#3c3b6e", CAN: "#d80621", ITA: "#008c45",
  BEL: "#e30613", CRO: "#ed1c24", URU: "#7ab8e6", COL: "#fcd116",
  JPN: "#1d2c5b", KOR: "#cd2e3a", MAR: "#c1272d", SEN: "#00853f",
};
const teamColour = (code: string) => TEAM_COLOURS[code] || "#d04a4a";

export default function LivePitch2D({
  frame, home, away, running,
}: {
  frame: LiveFrame;
  home: string;
  away: string;
  running: boolean;
}) {
  const ballRef = useRef<HTMLDivElement>(null);
  const ballPos = useRef<{ x: number; y: number }>({ x: 50, y: 50 });
  const ballAnim = useRef<number>(0);

  // Ball: 300ms requestAnimationFrame lerp toward each frame's ball_xy.
  useEffect(() => {
    const [tx, ty] = frame.ball_xy || [50, 50];
    const from = { ...ballPos.current };
    const start = performance.now();
    const DUR = 300;
    cancelAnimationFrame(ballAnim.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DUR);
      const e = 1 - (1 - t) * (1 - t);          // ease-out
      const x = from.x + (tx - from.x) * e;
      const y = from.y + (ty - from.y) * e;
      ballPos.current = { x, y };
      if (ballRef.current) {
        ballRef.current.style.transform =
          `translate(calc(${x} * 1cqw - 50%), calc(${y * 0.64} * 1cqh - 50%))`;
      }
      if (t < 1) ballAnim.current = requestAnimationFrame(step);
    };
    ballAnim.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(ballAnim.current);
  }, [frame.ball_xy?.[0], frame.ball_xy?.[1]]); // eslint-disable-line

  const positions: PlayerPos[] = frame.player_positions || [];

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "100/64", containerType: "size" }}>
      <PitchSVG className="absolute inset-0 h-full w-full" idSuffix="-live" />

      {positions.map((p) => {
        const isHome = p.team === "home";
        const bg = isHome ? "#f0f6fc" : teamColour(away);
        const fg = isHome ? "#0d1b3d" : "#f0f6fc";
        return (
          <div key={p.player_id}
            className="player-dot absolute left-0 top-0 z-10"
            style={{
              transform: `translate(calc(${p.x} * 1cqw - 50%), calc(${p.y * 0.64} * 1cqh - 50%))`,
            }}>
            <div title={`${p.name} · ${p.role} (${isHome ? home : away})`}
              className="flex items-center justify-center rounded-full shadow-md"
              style={{
                width: 18, height: 18, background: bg, color: fg,
                fontSize: 9, fontWeight: 800,
                border: `1.5px solid ${isHome ? "#0d1b3d" : "rgba(255,255,255,0.85)"}`,
                boxShadow: "0 2px 4px rgba(0,0,0,0.45)",
              }}>
              {p.number || ""}
            </div>
          </div>
        );
      })}

      {/* the ball: 12px yellow with a drop shadow, rAF-lerped */}
      <div ref={ballRef} className="absolute left-0 top-0 z-20"
        style={{ transform: "translate(calc(50 * 1cqw - 50%), calc(32 * 1cqh - 50%))" }}>
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, #fff7c2, #ffd60a 70%)",
          boxShadow: "0 3px 6px rgba(0,0,0,0.55)",
          border: "1px solid rgba(0,0,0,0.35)",
        }} />
      </div>

      {!running && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30">
          <span className="rounded-full bg-ink/80 px-4 py-1.5 text-sm font-semibold text-txt-primary/80">
            ⏸ Paused
          </span>
        </div>
      )}
    </div>
  );
}
