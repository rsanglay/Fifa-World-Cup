import { useMemo, useState } from "react";
import PitchSVG from "./live/PitchSVG";
import type { ManagedSquadPlayer } from "../types";

/* Drag-and-drop lineup builder — an interactive pitch instead of the old
 * dropdown + list. Formation slots are drop targets (native HTML5 DnD with
 * tap-to-assign fallback); player cards are drag sources showing name,
 * rating, form dot and suspension/injury state. Position-fit per slot and
 * the lineup strength score (0-100, mirrors the server's Elo-delta formula)
 * update live as you build. */

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "5-3-2": [5, 3, 2],
};

// Slot roles per group size — must match the server's role templates.
const DEF_ROLES: Record<number, string[]> = {
  3: ["CB", "CB", "CB"], 4: ["LB", "CB", "CB", "RB"], 5: ["LB", "CB", "CB", "CB", "RB"] };
const MID_ROLES: Record<number, string[]> = {
  2: ["DM", "CM"], 3: ["DM", "CM", "AM"], 4: ["DM", "CM", "CM", "AM"], 5: ["DM", "DM", "CM", "AM", "AM"] };
const FWD_ROLES: Record<number, string[]> = {
  1: ["CF"], 2: ["CF", "CF"], 3: ["LW", "CF", "RW"] };

// Position-fit %: player natural position vs slot role (GK in GK = 100,
// GK shoved up front = 30).
const FIT: Record<string, Record<string, number>> = {
  GK:  { GK: 100, CB: 30, LB: 30, RB: 30, DM: 30, CM: 30, AM: 30, LW: 30, RW: 30, CF: 30 },
  DEF: { GK: 25, CB: 100, LB: 92, RB: 92, DM: 75, CM: 60, AM: 45, LW: 40, RW: 40, CF: 35 },
  MID: { GK: 25, CB: 55, LB: 70, RB: 70, DM: 100, CM: 100, AM: 95, LW: 80, RW: 80, CF: 65 },
  FWD: { GK: 25, CB: 40, LB: 45, RB: 45, DM: 40, CM: 60, AM: 85, LW: 100, RW: 100, CF: 100 },
};
const fitFor = (p: ManagedSquadPlayer, role: string) => FIT[p.position]?.[role] ?? 50;

interface Slot {
  key: string;
  role: string;
  group: "GK" | "DEF" | "MID" | "FWD";
  x: number;     // % across (attack to the right)
  y: number;     // % down
}

function buildSlots(formation: string): Slot[] {
  const [d, m, f] = FORMATIONS[formation] || FORMATIONS["4-3-3"];
  const slots: Slot[] = [{ key: "GK-0", role: "GK", group: "GK", x: 6, y: 50 }];
  const row = (n: number, roles: string[], group: Slot["group"], x: number) => {
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? 50 : 12 + (i / (n - 1)) * 76;
      slots.push({ key: `${group}-${i}`, role: roles[i] || "CM", group, x, y });
    }
  };
  row(d, DEF_ROLES[d] || DEF_ROLES[4], "DEF", 24);
  row(m, MID_ROLES[m] || MID_ROLES[3], "MID", 50);
  row(f, FWD_ROLES[f] || FWD_ROLES[3], "FWD", 78);
  return slots;
}

export const formColour = (form?: number) =>
  form == null ? "#8b949e" : form >= 0.7 ? "#00d4aa" : form >= 0.5 ? "#e3b341" : "#e63946";

export default function LineupBuilderDnD({
  squad, selected, formation, onChange, onFormation, unavailable, lastStamina,
}: {
  squad: ManagedSquadPlayer[];
  selected: string[];                       // slot-ordered ids (GK, DEF…, MID…, FWD…)
  formation: string;
  onChange: (ids: string[]) => void;
  onFormation: (f: string) => void;
  unavailable: Set<string>;
  lastStamina?: Record<string, number>;     // stamina at last final whistle
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [tapId, setTapId] = useState<string | null>(null);
  const [hoverSlot, setHoverSlot] = useState<string | null>(null);

  const slots = useMemo(() => buildSlots(formation), [formation]);
  const byId = useMemo(() => Object.fromEntries(squad.map((p) => [p.id, p])), [squad]);

  // selected is slot-ordered: index i -> slots[i]
  const assignment = useMemo(() => {
    const m = new Map<string, string>();       // slot key -> player id
    slots.forEach((s, i) => { if (selected[i]) m.set(s.key, selected[i]); });
    return m;
  }, [slots, selected]);

  const place = (slotKey: string, pid: string) => {
    const p = byId[pid];
    if (!p || unavailable.has(pid)) return;
    // Slot-ordered array with "" holes — the parent filters before submit.
    const next = slots.map((s) => (s.key === slotKey ? pid
      : assignment.get(s.key) === pid ? "" : (assignment.get(s.key) || "")));
    onChange(next);
    setDragId(null); setTapId(null); setHoverSlot(null);
  };
  const clearSlot = (slotKey: string) => {
    onChange(slots.map((s) => (s.key === slotKey ? "" : (assignment.get(s.key) || ""))));
  };

  // Lineup strength 0-100: avg(rating × fit) of filled slots vs the squad's
  // best XI average — the same shape as the server's Elo-delta formula, so
  // what you see here is what feeds the match engine.
  const strength = useMemo(() => {
    const filled = slots.map((s) => ({ s, p: byId[assignment.get(s.key) || ""] }))
      .filter((x) => x.p) as { s: Slot; p: ManagedSquadPlayer }[];
    if (filled.length < 11) return null;
    const eff = filled.reduce((acc, { s, p }) => acc + p.rating * (fitFor(p, s.role) / 100), 0) / 11;
    const best = [...squad].sort((a, b) => b.rating - a.rating).slice(0, 11)
      .reduce((a, p) => a + p.rating, 0) / 11;
    return Math.max(0, Math.min(100, Math.round((eff / best) * 100)));
  }, [slots, assignment, byId, squad]);

  const activeId = dragId || tapId;
  const pool = [...squad].sort((a, b) =>
    a.position === b.position ? b.rating - a.rating
      : ["GK", "DEF", "MID", "FWD"].indexOf(a.position) - ["GK", "DEF", "MID", "FWD"].indexOf(b.position));
  const placedIds = new Set(assignment.values());

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div>
        {/* formation + strength header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {Object.keys(FORMATIONS).map((fm) => (
            <button key={fm} onClick={() => onFormation(fm)}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${formation === fm ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
              {fm}
            </button>
          ))}
          <div className="ml-auto text-right">
            <div className="font-display text-2xl leading-none"
              style={{ color: strength == null ? "#8b949e" : strength >= 95 ? "#00d4aa" : strength >= 85 ? "#e3b341" : "#e63946" }}>
              {strength == null ? "—" : strength}
            </div>
            <div className="text-[9px] uppercase text-txt-secondary">lineup strength → Elo</div>
          </div>
        </div>

        {/* the pitch (static SVG, slots as drop targets) */}
        <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
          style={{ aspectRatio: "100/64" }}>
          <PitchSVG className="absolute inset-0 h-full w-full" idSuffix="-builder" />
          {slots.map((s) => {
            const pid = assignment.get(s.key);
            const p = pid ? byId[pid] : undefined;
            const fit = activeId && byId[activeId] ? fitFor(byId[activeId], s.role) : null;
            return (
              <div key={s.key}
                onDragOver={(e) => { e.preventDefault(); setHoverSlot(s.key); }}
                onDragLeave={() => setHoverSlot((h) => (h === s.key ? null : h))}
                onDrop={(e) => { e.preventDefault(); if (dragId) place(s.key, dragId); }}
                onClick={() => {
                  if (tapId) place(s.key, tapId);
                  else if (p) clearSlot(s.key);
                }}
                className="absolute z-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
                style={{ left: `${s.x}%`, top: `${s.y}%` }}>
                <div className="flex flex-col items-center gap-0.5">
                  <div className={`flex h-11 w-11 items-center justify-center rounded-full border-2 text-[10px] font-bold transition ${
                    hoverSlot === s.key ? "scale-110" : ""}`}
                    style={{
                      borderColor: activeId
                        ? (fit ?? 0) >= 90 ? "#00d4aa" : (fit ?? 0) >= 60 ? "#e3b341" : "#e63946"
                        : "rgba(255,255,255,0.5)",
                      background: p ? "rgba(13,17,23,0.85)" : "rgba(13,17,23,0.45)",
                      color: "#f0f6fc",
                    }}
                    title={p ? `${p.name} — ${s.role}` : `Empty ${s.role} slot`}>
                    {p ? (
                      <span className="px-0.5 text-center leading-tight">
                        {p.name.split(" ").slice(-1)[0].slice(0, 8)}
                      </span>
                    ) : s.role}
                  </div>
                  {/* live position-fit while dragging */}
                  {activeId && (
                    <span className="rounded-full px-1.5 text-[9px] font-bold"
                      style={{
                        background: (fit ?? 0) >= 90 ? "#00d4aa" : (fit ?? 0) >= 60 ? "#e3b341" : "#e63946",
                        color: "#0d1117",
                      }}>
                      {fit}%
                    </span>
                  )}
                  {p && !activeId && (
                    <span className="rounded-full bg-black/50 px-1.5 text-[9px] font-bold text-accent">
                      {p.rating}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 text-[10px] text-txt-secondary">
          Drag a player onto a slot (or tap player → tap slot). Tap a filled slot to clear it.
        </div>
      </div>

      {/* squad pool: drag sources */}
      <div className="card max-h-[480px] overflow-y-auto p-2">
        <div className="flex items-baseline justify-between px-1 pb-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-txt-secondary">
            Squad — {selected.filter(Boolean).length}/11 picked
          </span>
          <span className="text-[9px] text-txt-secondary">ratings are modelled, not official</span>
        </div>
        <div className="space-y-1">
          {pool.map((p) => {
            const out = unavailable.has(p.id);
            const placed = placedIds.has(p.id);
            const st = lastStamina?.[p.id];
            return (
              <div key={p.id}
                draggable={!out}
                onDragStart={(e) => { setDragId(p.id); e.dataTransfer.setData("text/plain", p.id); }}
                onDragEnd={() => { setDragId(null); setHoverSlot(null); }}
                onClick={() => !out && setTapId(tapId === p.id ? null : p.id)}
                title={out ? (p.suspended ? "Suspended" : "Injured") : `${p.name} (${p.position})`}
                className={`flex select-none items-center gap-2 rounded-xl px-2 py-1.5 text-sm transition ${
                  out ? "cursor-not-allowed opacity-60"
                    : tapId === p.id ? "cursor-grab bg-accent/20 ring-1 ring-accent"
                    : placed ? "cursor-grab bg-pitch/20"
                    : "cursor-grab bg-ink/50 hover:bg-white/10"}`}>
                <span className="w-8 rounded bg-white/10 text-center text-[10px]">{p.position}</span>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                  title={`form ${(p.form ?? 0.7).toFixed(2)}`}
                  style={{ background: formColour(p.form) }} />
                <span className={`min-w-0 flex-1 truncate ${out && p.suspended ? "text-danger line-through" : ""}`}>
                  {p.injured ? "🩹 " : ""}{p.name}
                </span>
                {st != null && (
                  <span className="h-1.5 w-10 overflow-hidden rounded-full bg-white/10" title={`stamina last match ${st}%`}>
                    <span className={`block h-full ${st > 65 ? "bg-emerald-400" : st > 40 ? "bg-amber-400" : "bg-red-400"}`}
                      style={{ width: `${st}%` }} />
                  </span>
                )}
                <span className="text-xs font-bold text-accent">{p.rating}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
