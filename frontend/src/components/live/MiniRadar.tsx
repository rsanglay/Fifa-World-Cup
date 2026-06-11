import type { PlayerPos } from "../../types";

/* FM "overview" mini-radar: 120×80 mini-pitch with pure position dots.
 * Pinned top-right of the match view, visible even when the event log is
 * scrolled away. */
export default function MiniRadar({
  positions, ball,
}: {
  positions: PlayerPos[];
  ball: [number, number];
}) {
  return (
    <div className="pointer-events-none rounded-md border border-white/15 shadow-lg"
      style={{ width: 120, height: 80, background: "rgba(13,17,23,0.55)", backdropFilter: "blur(4px)" }}
      aria-label="Match overview radar">
      <svg viewBox="0 0 120 80" width={120} height={80}>
        <rect x="1" y="1" width="118" height="78" rx="3" fill="#1a5c2a" opacity="0.9" />
        <line x1="60" y1="1" x2="60" y2="79" stroke="#fff" strokeOpacity="0.35" strokeWidth="0.8" />
        <circle cx="60" cy="40" r="8" fill="none" stroke="#fff" strokeOpacity="0.3" strokeWidth="0.8" />
        <rect x="1" y="22" width="13" height="36" fill="none" stroke="#fff" strokeOpacity="0.3" strokeWidth="0.8" />
        <rect x="106" y="22" width="13" height="36" fill="none" stroke="#fff" strokeOpacity="0.3" strokeWidth="0.8" />
        {positions.map((p) => (
          <circle key={p.player_id}
            cx={(p.x / 100) * 118 + 1} cy={(p.y / 100) * 78 + 1} r={2.2}
            fill={p.team === "home" ? "#f0f6fc" : "#e05252"} />
        ))}
        <circle cx={(ball[0] / 100) * 118 + 1} cy={(ball[1] / 100) * 78 + 1} r={2}
          fill="#ffd60a" stroke="#000" strokeOpacity="0.4" strokeWidth="0.5" />
      </svg>
    </div>
  );
}
