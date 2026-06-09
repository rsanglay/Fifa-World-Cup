import { useMemo, useState } from "react";
import PlayerPhoto from "./PlayerPhoto";
import { useEsc } from "../hooks/useEsc";
import type { Player } from "../types";

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "5-3-2": [5, 3, 2],
};
const ROW_Y: Record<string, number> = { GK: 88, DEF: 66, MID: 44, FWD: 20 };

type Slot = { pos: "GK" | "DEF" | "MID" | "FWD"; index: number };

export default function PitchLineup({
  squad, selected, formation, onChange, onFormation, unavailable,
}: {
  squad: Player[];
  selected: string[];
  formation: string;
  onChange: (ids: string[]) => void;
  onFormation: (f: string) => void;
  unavailable?: Set<string>;
}) {
  const [picking, setPicking] = useState<Slot | null>(null);
  const [d, m, f] = FORMATIONS[formation] || FORMATIONS["4-3-3"];
  const need: Record<string, number> = { GK: 1, DEF: d, MID: m, FWD: f };
  const byId = useMemo(() => Object.fromEntries(squad.map((p) => [p.id, p])), [squad]);

  // Selected ids grouped by position, in selection order.
  const selByPos = useMemo(() => {
    const g: Record<string, string[]> = { GK: [], DEF: [], MID: [], FWD: [] };
    selected.forEach((id) => { const p = byId[id]; if (p) g[p.position]?.push(id); });
    return g;
  }, [selected, byId]);

  const slotPlayer = (pos: string, i: number) => selByPos[pos]?.[i];

  const rebuild = (next: Record<string, string[]>) => {
    onChange([...next.GK, ...next.DEF, ...next.MID, ...next.FWD].filter(Boolean));
  };

  const assign = (slot: Slot, id: string | null) => {
    const next: Record<string, string[]> = {
      GK: [...selByPos.GK], DEF: [...selByPos.DEF], MID: [...selByPos.MID], FWD: [...selByPos.FWD],
    };
    // Remove the id from anywhere it already sits (avoid dupes).
    if (id) (["GK", "DEF", "MID", "FWD"] as const).forEach((p) => { next[p] = next[p].filter((x) => x !== id); });
    const arr = next[slot.pos];
    if (id) arr[slot.index] = id;
    else arr.splice(slot.index, 1);
    next[slot.pos] = arr.filter(Boolean);
    rebuild(next);
    setPicking(null);
  };

  const slots: { slot: Slot; x: number; y: number; id?: string }[] = [];
  (["GK", "DEF", "MID", "FWD"] as const).forEach((pos) => {
    const n = need[pos];
    for (let i = 0; i < n; i++) {
      slots.push({ slot: { pos, index: i }, x: ((i + 1) / (n + 1)) * 100, y: ROW_Y[pos], id: slotPlayer(pos, i) });
    }
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-white/60">Formation:</span>
        {Object.keys(FORMATIONS).map((fm) => (
          <button key={fm} onClick={() => onFormation(fm)}
            className={`rounded-lg px-3 py-1 text-sm font-semibold ${formation === fm ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>{fm}</button>
        ))}
        <span className="ml-auto text-xs text-white/40">Tap a position to pick a player</span>
      </div>

      {/* Pitch */}
      <div className="relative mx-auto aspect-[3/4] w-full max-w-md overflow-hidden rounded-2xl border border-white/10"
        style={{ background: "repeating-linear-gradient(0deg, #0a7d34 0 8%, #0c8c3a 8% 16%)" }}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30" />
          <div className="absolute left-0 right-0 top-1/2 h-px bg-white/30" />
          <div className="absolute left-1/2 top-0 h-16 w-32 -translate-x-1/2 border border-t-0 border-white/30" />
          <div className="absolute bottom-0 left-1/2 h-16 w-32 -translate-x-1/2 border border-b-0 border-white/30" />
        </div>
        {slots.map(({ slot, x, y, id }, i) => {
          const p = id ? byId[id] : undefined;
          return (
            <button key={i} onClick={() => setPicking(slot)}
              className="absolute flex w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${x}%`, top: `${y}%` }}>
              {p ? (
                <>
                  <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={40} />
                  <span className="mt-0.5 max-w-[64px] truncate rounded bg-ink/80 px-1 text-[9px] font-medium">{lastName(p.name)}</span>
                  <span className="rounded bg-gold/90 px-1 text-[9px] font-bold text-ink">{p.rating}</span>
                </>
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-white/40 bg-black/20 text-lg text-white/60">+</div>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-center text-xs text-white/40">{selected.length}/11 selected</div>

      {picking && (
        <PositionPicker
          pos={picking.pos} squad={squad} selected={selected}
          unavailable={unavailable} currentId={slotPlayer(picking.pos, picking.index)}
          onPick={(id) => assign(picking, id)} onClose={() => setPicking(null)} />
      )}
    </div>
  );
}

function PositionPicker({ pos, squad, selected, unavailable, currentId, onPick, onClose }: {
  pos: string; squad: Player[]; selected: string[]; unavailable?: Set<string>; currentId?: string;
  onPick: (id: string | null) => void; onClose: () => void;
}) {
  useEsc(onClose);
  const label: Record<string, string> = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" };
  const players = squad.filter((p) => p.position === pos).sort((a, b) => b.rating - a.rating);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur sm:items-center" onClick={onClose}>
      <div className="card max-h-[70vh] w-full max-w-md overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <div className="font-display text-xl text-gold">PICK A {label[pos].toUpperCase()}</div>
          {currentId && <button onClick={() => onPick(null)} className="text-xs text-red-300">Remove</button>}
        </div>
        <div className="space-y-1">
          {players.map((p) => {
            const banned = unavailable?.has(p.id);
            const inXI = selected.includes(p.id) && p.id !== currentId;
            return (
              <button key={p.id} disabled={banned} onClick={() => onPick(p.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  p.id === currentId ? "bg-pitch/40 ring-1 ring-pitch" : banned ? "cursor-not-allowed opacity-40" : inXI ? "bg-white/5 opacity-60" : "bg-ink/50 hover:bg-white/10"}`}>
                <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{p.name}{banned && " 🚫"}{inXI && " ·  in XI"}</div>
                  <div className="truncate text-[10px] text-white/30">{p.club}</div>
                </div>
                <span className="rounded bg-ink px-1 text-xs font-bold text-gold">{p.rating}</span>
              </button>
            );
          })}
        </div>
        <button onClick={onClose} className="btn-ghost mt-3 w-full text-sm">Done</button>
      </div>
    </div>
  );
}

function lastName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}
