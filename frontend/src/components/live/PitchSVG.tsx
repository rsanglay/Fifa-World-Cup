/* FM-style top-down pitch — pure SVG markings (no canvas), dark green turf
 * with white lines. Reused by the live 2D match view, the mini-radar and the
 * drag-and-drop lineup builder (static). */
export default function PitchSVG({ className, idSuffix = "" }: { className?: string; idSuffix?: string }) {
  const stripes = Array.from({ length: 10 }, (_, i) => i);
  const gid = `turf${idSuffix}`;
  return (
    <svg viewBox="0 0 100 64" preserveAspectRatio="none"
      className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1f6a31" />
          <stop offset="100%" stopColor="#174f24" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="100" height="64" fill="#1a5c2a" />
      {stripes.map((i) => (
        <rect key={i} x={i * 10} y="0" width="10" height="64"
          fill={i % 2 ? "#1a5c2a" : "#1d6430"} />
      ))}
      <rect x="0" y="0" width="100" height="64" fill={`url(#${gid})`} opacity="0.35" />
      <g stroke="#ffffff" strokeOpacity="0.75" strokeWidth="0.35" fill="none">
        {/* touchline + halfway + centre */}
        <rect x="1.5" y="1.5" width="97" height="61" />
        <line x1="50" y1="1.5" x2="50" y2="62.5" />
        <circle cx="50" cy="32" r="7.3" />
        {/* penalty boxes */}
        <rect x="1.5" y="15.4" width="13.2" height="33.2" />
        <rect x="85.3" y="15.4" width="13.2" height="33.2" />
        {/* six-yard boxes */}
        <rect x="1.5" y="24.2" width="4.6" height="15.6" />
        <rect x="93.9" y="24.2" width="4.6" height="15.6" />
        {/* penalty arcs */}
        <path d="M 14.7 26.2 A 7.3 7.3 0 0 1 14.7 37.8" />
        <path d="M 85.3 26.2 A 7.3 7.3 0 0 0 85.3 37.8" />
      </g>
      <g fill="#ffffff" fillOpacity="0.85">
        <circle cx="50" cy="32" r="0.55" />
        <circle cx="10.4" cy="32" r="0.5" />
        <circle cx="89.6" cy="32" r="0.5" />
      </g>
      {/* goals */}
      <rect x="0.2" y="28.2" width="1.3" height="7.6" fill="#ffffff" fillOpacity="0.9" />
      <rect x="98.5" y="28.2" width="1.3" height="7.6" fill="#ffffff" fillOpacity="0.9" />
    </svg>
  );
}
