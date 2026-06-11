import { flag } from "../api/client";
import type { ManagedState } from "../types";

/* FM-style "Next Up" screen between matches: opponent card (flag, Elo, last-5
 * form), your squad's form/injury/suspension situation, the team morale bar,
 * and the two CTAs — straight to the match or rotate the squad first. */

const MORALE_COLOUR: Record<string, string> = {
  "Very Good": "#00d4aa", Good: "#7ee787", Poor: "#e3b341", Crisis: "#e63946",
};

function FormDots({ form }: { form: string[] }) {
  if (!form?.length) return <span className="text-[10px] text-txt-secondary">no results yet</span>;
  return (
    <span className="flex items-center gap-1">
      {form.map((f, i) => (
        <span key={i}
          className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
          style={{
            background: f === "W" ? "#00d4aa" : f === "D" ? "rgba(255,255,255,0.25)" : "#e63946",
            color: f === "D" ? "#f0f6fc" : "#0d1117",
          }}>
          {f}
        </span>
      ))}
    </span>
  );
}

export default function NextUp({
  state, team, onContinue, onRotate,
}: {
  state: ManagedState;
  team: string;
  onContinue: () => void;
  onRotate: () => void;
}) {
  const nf = state.next_fixture;
  if (!nf) return null;
  const names = state.team_names;
  const injured = state.squad.filter((p) => p.injured);
  const suspended = state.squad.filter((p) => p.suspended);
  const morale = state.morale || { avg_form: 0.7, label: "Good" as const };
  const lowForm = state.squad.filter((p) => (p.form ?? 0.7) < 0.5);

  return (
    <div className="card space-y-4 p-5">
      <div className="text-[10px] font-bold uppercase tracking-widest text-txt-secondary">Next up</div>

      {/* opponent header */}
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-5xl">{flag(nf.opponent)}</span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-3xl tracking-wide text-txt-primary">
            {names[nf.opponent] || nf.opponent}
          </div>
          <div className="text-xs text-txt-secondary">{nf.stage}{nf.date ? ` · ${nf.date}` : ""}</div>
        </div>
        <div className="text-center">
          <div className="font-display text-2xl text-accent">{nf.opponent_elo ?? "—"}</div>
          <div className="text-[9px] uppercase text-txt-secondary">Elo rating</div>
        </div>
        <div className="text-center">
          <div className="mb-1 text-[9px] uppercase text-txt-secondary">Form (last 5)</div>
          <FormDots form={nf.opponent_form || []} />
        </div>
      </div>

      {/* morale bar */}
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="uppercase tracking-wider text-txt-secondary">Squad morale</span>
          <span className="font-bold" style={{ color: MORALE_COLOUR[morale.label] }}>{morale.label}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full"
            style={{
              width: `${Math.round(morale.avg_form * 100)}%`,
              background: MORALE_COLOUR[morale.label],
              transition: "width 600ms ease",
            }} />
        </div>
      </div>

      {/* availability report */}
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="rounded-xl bg-white/5 p-2">
          <div className="mb-1 font-bold text-txt-secondary">🩹 Injuries</div>
          {injured.length === 0 ? <span className="text-txt-secondary">none</span>
            : injured.map((p) => (
              <div key={p.id} className="text-danger">{p.name} ({p.injured_rounds} match{(p.injured_rounds || 0) > 1 ? "es" : ""})</div>
            ))}
        </div>
        <div className="rounded-xl bg-white/5 p-2">
          <div className="mb-1 font-bold text-txt-secondary">🟥 Suspensions</div>
          {suspended.length === 0 ? <span className="text-txt-secondary">none</span>
            : suspended.map((p) => <div key={p.id} className="text-danger">{p.name}</div>)}
        </div>
        <div className="rounded-xl bg-white/5 p-2">
          <div className="mb-1 font-bold text-txt-secondary">📉 Out of form</div>
          {lowForm.length === 0 ? <span className="text-txt-secondary">everyone is sharp</span>
            : lowForm.slice(0, 4).map((p) => <div key={p.id} className="text-amber-300">{p.name}</div>)}
        </div>
      </div>

      {/* your form strip */}
      <div className="flex items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-txt-secondary">Your form</span>
        <FormDots form={state.form} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onRotate} className="btn-ghost">🔁 Rotate squad</button>
        <button onClick={onContinue} className="btn-primary">▶ Continue to match</button>
      </div>
    </div>
  );
}
