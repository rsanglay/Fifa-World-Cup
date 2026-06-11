import { useEffect, useState } from "react";
import type { PlayerRating } from "../types";

/* Post-match ratings panel — full width after the final whistle.
 * Photo placeholder (initials circle), name, position, minutes, 1-10 rating
 * counting up over 600ms. Man of the Match gets the gold card border. */

function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function ratingColour(r: number): string {
  if (r >= 8) return "#00d4aa";
  if (r >= 7) return "#7ee787";
  if (r >= 6) return "#e3b341";
  return "#e63946";
}

function CountUp({ value, duration = 600 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(value * e * 10) / 10);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown.toFixed(1)}</>;
}

export default function RatingsPanel({ ratings }: { ratings: PlayerRating[] }) {
  if (!ratings?.length) return null;
  return (
    <div className="card w-full p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-xl tracking-wide text-txt-primary">PLAYER RATINGS</h3>
        <span className="text-[10px] text-txt-secondary">model-based match ratings — not official</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ratings.map((r, i) => (
          <div key={r.player_id}
            className="flex items-center gap-3 rounded-xl px-3 py-2 animate-count-up"
            style={{
              animationDelay: `${i * 45}ms`,
              background: "rgba(255,255,255,0.04)",
              border: r.motm ? "1.5px solid #d4af37" : "1px solid rgba(255,255,255,0.06)",
              boxShadow: r.motm ? "0 0 14px rgba(212,175,55,0.35)" : undefined,
            }}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
              style={{ background: "#1f2733", color: "#f0f6fc", border: "1px solid rgba(255,255,255,0.15)" }}>
              {initials(r.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-txt-primary">
                {r.name} {r.motm && <span title="Man of the Match">🏅</span>}
              </div>
              <div className="text-[10px] text-txt-secondary">
                {r.role} · {r.minutes}' {r.goals > 0 && `· ⚽${r.goals}`} {r.assists > 0 && `· 🅰${r.assists}`}
              </div>
            </div>
            <div className="font-display text-3xl tabular-nums"
              style={{ color: ratingColour(r.rating) }}>
              <CountUp value={r.rating} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
