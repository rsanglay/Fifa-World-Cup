import { useState } from "react";

const POS_COLOR: Record<string, string> = {
  GK: "from-amber-500/40 to-amber-700/40",
  DEF: "from-sky-500/40 to-sky-700/40",
  MID: "from-emerald-500/40 to-emerald-700/40",
  FWD: "from-rose-500/40 to-rose-700/40",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function PlayerPhoto({
  name,
  photoUrl,
  position = "MID",
  size = 48,
}: {
  name: string;
  photoUrl?: string;
  position?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const show = photoUrl && !failed;
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-full bg-gradient-to-br ${
        POS_COLOR[position] || POS_COLOR.MID
      } ring-1 ring-white/10`}
      style={{ width: size, height: size }}
    >
      {show ? (
        <img
          src={photoUrl}
          alt={name}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-bold text-white/90"
          style={{ fontSize: size * 0.34 }}
        >
          {initials(name)}
        </div>
      )}
    </div>
  );
}
