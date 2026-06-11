import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { api, flag } from "../api/client";
import Confetti from "../components/Confetti";
import { downloadShareCard } from "../lib/shareCard";
import { profileStore } from "../lib/profileStore";
import type { PLState } from "../types";

const KEY = "wc26_pl_session";
const POLL_MS = 2500;

interface PLSession { code: string; token: string; name: string }
const store = {
  get(): PLSession | null {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  },
  set(s: PLSession) { localStorage.setItem(KEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(KEY); },
};

export default function PredictionLeague() {
  const [session, setSession] = useState(store.get());
  const [state, setState] = useState<PLState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    api.plState(session.code, session.token)
      .then((r) => setState(r.state))
      .catch(() => { store.clear(); setSession(null); });
  }, [session?.code]); // eslint-disable-line

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      api.plState(session.code, session.token).then((r) => setState(r.state)).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [session?.code]); // eslint-disable-line

  const act = (p: Promise<{ code: string; state: PLState }>) =>
    p.then((r) => { setState(r.state); setError(null); }).catch((e) => setError(String(e?.message || e)));

  if (!session || !state) {
    return <Entry error={error} setError={setError}
      onEnter={(code, token, name, st) => { store.set({ code, token, name }); setSession({ code, token, name }); setState(st); }} />;
  }

  const leave = () => { store.clear(); setSession(null); setState(null); };

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <button onClick={leave} className="btn-ghost text-sm">← Leave</button>
        <span className="text-2xl">🔮</span>
        <div className="flex-1">
          <div className="font-display text-xl">Prediction league</div>
          <div className="text-[11px] text-white/50">
            {state.phase === "lobby" ? "Lobby" : state.phase === "group" ? `Matchday ${state.matchday}` : state.phase === "knockout" ? state.ko_label : "Finished"}
            {" · "}{state.you.name} · {state.you.points} pts
          </div>
        </div>
        <span className="rounded-lg bg-ink/60 px-3 py-1.5 font-display text-lg tracking-[0.25em] text-gold ring-1 ring-gold/40"
          onClick={() => navigator.clipboard?.writeText(state.code)} role="button" title="Copy code">
          {state.code}
        </span>
      </div>
      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {state.phase === "lobby" ? (
        <div className="card p-5">
          <h3 className="mb-3 font-display text-lg tracking-wide">PLAYERS</h3>
          <div className="flex flex-wrap gap-2">
            {state.members.map((m) => (
              <span key={m.name} className="rounded-lg bg-ink/50 px-3 py-1.5 text-sm">
                {m.name} {m.host && <span className="text-[10px] text-gold">HOST</span>}
              </span>
            ))}
          </div>
          {state.you.host ? (
            <button onClick={() => session && act(api.plStart(session.code, session.token))} className="btn-primary mt-4">
              ▶ Start the league
            </button>
          ) : (
            <div className="mt-4 animate-pulse text-sm text-white/50">Waiting for the host…</div>
          )}
          <div className="mt-3 text-xs text-white/40">
            Everyone predicts every match of a simulated World Cup, round by round.
            Correct result = 2 pts, exact goal margin = +1.
          </div>
        </div>
      ) : state.done ? (
        <Final state={state} onLeave={leave} />
      ) : (
        <Round state={state} onSubmit={(picks) => session && act(api.plPredict(session.code, session.token, picks))} />
      )}

      <Leaderboard state={state} />
    </div>
  );
}

function Entry({ onEnter, error, setError }: {
  onEnter: (code: string, token: string, name: string, st: PLState) => void;
  error: string | null; setError: (e: string | null) => void;
}) {
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState(profileStore.get().name || "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const go = () => {
    if (!name.trim()) return;
    setBusy(true);
    profileStore.setName(name.trim());
    const p = tab === "create" ? api.plCreate(name.trim())
      : api.plJoin(code.trim().toUpperCase(), name.trim());
    p.then((r) => onEnter(r.code, r.token, name.trim(), r.state))
      .catch((e) => { setError(String(e?.message || e)); setBusy(false); });
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card p-6 text-center">
        <div className="font-display text-3xl tracking-wide">🔮 PREDICTION LEAGUE</div>
        <p className="mx-auto mt-2 max-w-lg text-sm text-white/60">
          No squads, no tactics — just football brains. Everyone predicts every match
          of the same simulated World Cup; the round plays once all picks are in.
        </p>
        <div className="mt-2 text-xs text-white/40">
          Want to actually manage a nation against friends? <Link to="/multiplayer" className="text-gold underline">Multiplayer tournament →</Link>
        </div>
      </div>
      <div className="flex justify-center gap-1">
        {(["create", "join"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setError(null); }}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === t ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
            {t === "create" ? "Create league" : "Join with a code"}
          </button>
        ))}
      </div>
      <div className="card space-y-4 p-5">
        {tab === "join" && (
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={5}
            placeholder="ROOM CODE"
            className="w-full rounded-lg bg-ink/60 px-3 py-2 font-display text-xl tracking-[0.3em] outline-none ring-1 ring-white/10 focus:ring-gold" />
        )}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24}
          placeholder="Your name"
          className="w-full rounded-lg bg-ink/60 px-3 py-2 outline-none ring-1 ring-white/10 focus:ring-gold" />
        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <button onClick={go} disabled={busy || !name.trim() || (tab === "join" && code.length !== 5)}
          className="btn-primary w-full">
          {busy ? "…" : tab === "create" ? "🔮 Create league" : "→ Join league"}
        </button>
      </div>
    </div>
  );
}

function Round({ state, onSubmit }: { state: PLState; onSubmit: (picks: Record<string, { result: string; margin?: number }>) => void }) {
  const [picks, setPicks] = useState<Record<string, { result: string; margin?: number }>>(state.you.predictions || {});
  const names = state.team_names;
  const total = state.round_matches.length;
  const made = Object.keys(picks).length;
  const submitted = state.you.predicted;

  const set = (key: string, result: string) =>
    setPicks((p) => ({ ...p, [key]: { ...(p[key] || {}), result } }));
  const setMargin = (key: string, margin: number) =>
    setPicks((p) => p[key] ? { ...p, [key]: { ...p[key], margin } } : p);

  if (submitted) {
    return (
      <div className="card p-5 text-center">
        <div className="text-lg font-semibold">Predictions locked ✓</div>
        <div className="mt-1 animate-pulse text-sm text-white/50">
          Waiting on {state.waiting_on.length ? state.waiting_on.join(", ") : "the simulation"}…
        </div>
        {Object.keys(state.last_round_points).length > 0 && (
          <div className="mt-2 text-xs text-white/50">
            Last round: {Object.entries(state.last_round_points).map(([n, p]) => `${n} +${p}`).join(" · ")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card space-y-2 p-4">
      <div className="flex items-center justify-between">
        <div className="font-display text-lg tracking-wide">
          {state.round_matches[0]?.stage?.toUpperCase()} — CALL EVERY MATCH
        </div>
        <span className={`text-sm ${made === total ? "text-gold" : "text-white/40"}`}>{made}/{total}</span>
      </div>
      <div className="grid gap-1.5 md:grid-cols-2">
        {state.round_matches.map((m) => {
          const pick = picks[m.key];
          return (
            <div key={m.key} className="rounded-lg bg-ink/40 px-2 py-1.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex min-w-0 flex-1 items-center justify-end gap-1 truncate text-right">
                  {names[m.home]} {flag(m.home)}
                </span>
                <span className="flex gap-0.5">
                  {(m.knockout ? ["H", "A"] : ["H", "D", "A"]).map((r) => (
                    <button key={r} onClick={() => set(m.key, r)}
                      className={`h-7 w-7 rounded text-xs font-bold ${pick?.result === r ? "bg-gold text-ink" : "bg-white/5 text-white/50 hover:bg-white/15"}`}>
                      {r === "H" ? "1" : r === "D" ? "X" : "2"}
                    </button>
                  ))}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                  {flag(m.away)} {names[m.away]}
                </span>
              </div>
              {pick?.result && pick.result !== "D" && (
                <div className="mt-1 flex items-center justify-center gap-1 text-[10px] text-white/40">
                  margin
                  {[1, 2, 3].map((g) => (
                    <button key={g} onClick={() => setMargin(m.key, g)}
                      className={`h-5 w-5 rounded text-[10px] font-bold ${pick.margin === g ? "bg-gold/70 text-ink" : "bg-white/5 text-white/40"}`}>
                      {g}
                    </button>
                  ))}
                  <span className="ml-1">+1 pt if exact</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button onClick={() => onSubmit(picks)} disabled={made < total} className="btn-primary w-full">
        {made < total ? `Call all ${total} matches to lock in` : "✓ Lock in predictions"}
      </button>
    </div>
  );
}

function Leaderboard({ state }: { state: PLState }) {
  if (!state.leaderboard.length) return null;
  return (
    <div className="card p-3">
      <div className="mb-2 font-display text-lg tracking-wide">LEADERBOARD</div>
      <div className="space-y-1">
        {state.leaderboard.map((r, i) => (
          <div key={r.name} className="flex items-center gap-2 rounded-lg bg-ink/40 px-3 py-1.5 text-sm">
            <span className="w-6 text-white/40">{["🥇", "🥈", "🥉"][i] || `${i + 1}.`}</span>
            <span className="flex-1 font-semibold">{r.name}</span>
            <span className="text-xs text-white/40">{r.exact} exact</span>
            <span className="font-display text-gold tabular-nums">{r.points}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Final({ state, onLeave }: { state: PLState; onLeave: () => void }) {
  const top = state.leaderboard[0];
  const youWon = top?.name === state.you.name;
  return (
    <div className="space-y-4">
      {youWon && <Confetti />}
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        className={`card p-8 text-center ${youWon ? "ring-2 ring-gold" : ""}`}>
        <div className="text-5xl">{flag(state.champion || "")}</div>
        <div className="mt-2 font-display text-2xl">{state.champion_name} win the World Cup</div>
        <div className="mt-3 text-xl font-bold text-gold">🔮 {top?.name} wins the league with {top?.points} pts</div>
        <div className="mt-4 flex justify-center gap-2">
          <button onClick={() => downloadShareCard({
            kind: "prediction",
            title: youWon ? "I CALLED IT" : `${top?.name} CALLED IT`,
            teamCode: state.champion || undefined,
            teamName: state.champion_name || undefined,
            lines: state.leaderboard.slice(0, 3).map((r, i) => `${["🥇", "🥈", "🥉"][i]} ${r.name} — ${r.points} pts`),
            won: youWon,
          })} className="btn-ghost text-sm">🖼 Share card</button>
          <button onClick={onLeave} className="btn-primary">← New league</button>
        </div>
      </motion.div>
    </div>
  );
}
