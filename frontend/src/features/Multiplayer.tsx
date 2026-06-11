import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { api, flag } from "../api/client";
import PitchLineup from "../components/PitchLineup";
import Confetti from "../components/Confetti";
import MPLiveMatch from "../components/MPLiveMatch";
import TopScorers from "../components/TopScorers";
import { mpStore } from "../lib/mpStore";
import { profileStore } from "../lib/profileStore";
import { downloadShareCard } from "../lib/shareCard";
import { sound } from "../lib/sound";
import type { ManagedSquadPlayer, MPMatch, MPState, Player, Team } from "../types";

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "5-3-2": [5, 3, 2],
};
const MENTALITIES = [
  { key: "defensive", label: "Defensive", icon: "🛡️" },
  { key: "balanced", label: "Balanced", icon: "⚖️" },
  { key: "attacking", label: "Attacking", icon: "⚔️" },
];
const POLL_MS = 2500;

function pickXI(squad: ManagedSquadPlayer[], formation: string): string[] {
  const [d, m, f] = FORMATIONS[formation];
  const need: Record<string, number> = { GK: 1, DEF: d, MID: m, FWD: f };
  const avail = squad.filter((p) => !p.suspended && !p.injured);
  const out: string[] = [];
  (["GK", "DEF", "MID", "FWD"] as const).forEach((pos) => {
    out.push(...avail.filter((p) => p.position === pos).sort((a, b) => b.rating - a.rating).slice(0, need[pos]).map((p) => p.id));
  });
  return out;
}

export default function Multiplayer() {
  const saved = mpStore.get();
  const [session, setSession] = useState(saved);
  const [state, setState] = useState<MPState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inLive, setInLive] = useState<string | null>(null);   // live match key

  useEffect(() => {
    if (!session) return;
    api.mpState(session.code, session.token)
      .then((r) => setState(r.state))
      .catch(() => { mpStore.clear(); setSession(null); });
  }, [session?.code]); // eslint-disable-line

  // Poll while in a room — paused while inside a live match (WS drives that).
  useEffect(() => {
    if (!session || inLive) return;
    const id = setInterval(() => {
      api.mpState(session.code, session.token).then((r) => setState(r.state)).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [session?.code, inLive]); // eslint-disable-line

  // Record finished tournaments to the manager profile (once).
  const recorded = useRef(false);
  useEffect(() => {
    if (state?.done && !recorded.current) {
      recorded.current = true;
      profileStore.recordMultiplayer(state);
    }
  }, [state?.done]); // eslint-disable-line

  const enter = (code: string, token: string, name: string, team: string, st: MPState) => {
    mpStore.set({ code, token, name, team });
    setSession({ code, token, name, team });
    setState(st);
    setError(null);
  };
  const leave = () => { mpStore.clear(); setSession(null); setState(null); setInLive(null); };

  if (!session || !state) {
    return <EntryScreen onEnter={enter} error={error} setError={setError} />;
  }

  // Inside a live grudge match (playing or spectating).
  if (inLive) {
    const info = state.live_h2h.find((l) => l.key === inLive);
    if (info) {
      return (
        <MPLiveMatch code={session.code} token={session.token} info={info}
          squad={state.you.squad} names={state.team_names}
          onDone={() => {
            setInLive(null);
            api.mpState(session.code, session.token).then((r) => setState(r.state)).catch(() => {});
          }} />
      );
    }
    setInLive(null);
  }

  return (
    <RoomScreen session={session} state={state} onState={setState} onLeave={leave}
      onEnterLive={setInLive} />
  );
}

/* ============================== entry screen ============================== */
function EntryScreen({ onEnter, error, setError }: {
  onEnter: (code: string, token: string, name: string, team: string, st: MPState) => void;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState(profileStore.get().name || "");
  const [team, setTeam] = useState("");
  const [code, setCode] = useState("");
  const [taken, setTaken] = useState<string[]>([]);
  const [joinDraft, setJoinDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  // Create options.
  const [draft, setDraft] = useState(false);
  const [deadline, setDeadline] = useState(0);          // minutes; 0 = off

  useEffect(() => {
    if (tab !== "join" || code.trim().length !== 5) { setTaken([]); setJoinDraft(false); return; }
    api.mpPreview(code.trim().toUpperCase())
      .then((p) => {
        setTaken(p.taken_teams);
        setJoinDraft(!!p.draft);
        setError(p.joinable ? null : "That room already kicked off.");
      })
      .catch(() => setTaken([]));
  }, [code, tab]); // eslint-disable-line

  const needsTeam = tab === "create" ? !draft : !joinDraft;
  const go = () => {
    if (!name.trim() || (needsTeam && !team)) return;
    setBusy(true);
    profileStore.setName(name.trim());
    const p = tab === "create"
      ? api.mpCreate(name.trim(), draft ? null : team,
          { draft, deadline_minutes: deadline })
      : api.mpJoin(code.trim().toUpperCase(), name.trim(), joinDraft ? null : team);
    p.then((r) => onEnter(r.code, r.token, name.trim(), team, r.state))
      .catch((e) => { setError(friendly(e)); setBusy(false); });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="card p-6 text-center">
        <div className="font-display text-3xl tracking-wide">🆚 MULTIPLAYER WORLD CUP</div>
        <p className="mx-auto mt-2 max-w-xl text-sm text-white/60">
          Create a private tournament, share the room code, and each manage a nation
          through the same World Cup. When your teams meet, the match is played LIVE —
          both managers in the dugout, minute by minute.
        </p>
        <div className="mt-3 text-xs text-white/40">
          Just want to call results? <Link to="/predictions" className="text-gold underline">Run a prediction league →</Link>
          <span className="mx-2">·</span>
          <Link to="/profile" className="text-gold underline">Your manager profile</Link>
        </div>
      </div>

      <div className="flex justify-center gap-1">
        {(["create", "join"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setError(null); }}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === t ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
            {t === "create" ? "Create tournament" : "Join with a code"}
          </button>
        ))}
      </div>

      <div className="card space-y-4 p-5">
        {tab === "join" && (
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-white/40">Room code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={5}
              placeholder="e.g. K3QF7"
              className="mt-1 w-full rounded-lg bg-ink/60 px-3 py-2 font-display text-xl tracking-[0.3em] outline-none ring-1 ring-white/10 focus:ring-gold" />
          </label>
        )}
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-white/40">Your manager name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24}
            placeholder="e.g. Raazik"
            className="mt-1 w-full rounded-lg bg-ink/60 px-3 py-2 outline-none ring-1 ring-white/10 focus:ring-gold" />
        </label>
        {tab === "create" && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-ink/40 p-3 text-sm">
            <button onClick={() => setDraft((d) => !d)}
              className={`rounded-lg px-3 py-1 font-semibold ${draft ? "bg-gold text-ink" : "bg-white/5 text-white/70"}`}>
              🎲 Draft mode {draft ? "ON" : "off"}
            </button>
            <span className="text-xs text-white/40">nations picked in a randomized draft</span>
            <span className="ml-auto flex items-center gap-1 text-xs text-white/40">
              ⏰ Round deadline
              <select value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}
                className="rounded bg-ink/60 px-1 py-0.5 text-xs outline-none ring-1 ring-white/10">
                <option value={0}>none</option>
                <option value={10}>10 min</option>
                <option value={60}>1 hour</option>
                <option value={360}>6 hours</option>
                <option value={1440}>24 hours</option>
              </select>
            </span>
          </div>
        )}
        {needsTeam ? (
          <TeamPicker value={team} onChange={setTeam} taken={taken} />
        ) : (
          <div className="rounded-lg bg-ink/40 p-3 text-sm text-white/50">
            🎲 Draft room — nations are picked once everyone is in.
          </div>
        )}
        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <button onClick={go} disabled={busy || !name.trim() || (needsTeam && !team) || (tab === "join" && code.trim().length !== 5)}
          className="btn-primary w-full">
          {busy ? "…" : tab === "create" ? "🏆 Create room" : "→ Join tournament"}
        </button>
      </div>
    </div>
  );
}

function TeamPicker({ value, onChange, taken }: { value: string; onChange: (c: string) => void; taken: string[] }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { api.teams().then(setTeams).catch(() => {}); }, []);
  const takenSet = useMemo(() => new Set(taken), [taken]);
  const shown = useMemo(
    () => teams.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()) || t.code.includes(q.toUpperCase())),
    [teams, q]);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-white/40">Pick your nation</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
          className="rounded-lg bg-ink/60 px-2 py-1 text-xs outline-none ring-1 ring-white/10 focus:ring-gold" />
      </div>
      <div className="mt-2 grid max-h-64 grid-cols-2 gap-1 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4">
        {shown.map((t) => {
          const isTaken = takenSet.has(t.code);
          return (
            <button key={t.code} disabled={isTaken} onClick={() => onChange(t.code)}
              title={isTaken ? "Already managed by another player" : t.name}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                value === t.code ? "bg-gold text-ink" :
                isTaken ? "bg-white/5 text-white/25 line-through" : "bg-white/5 text-white/80 hover:bg-white/10"}`}>
              <span className="text-lg">{flag(t.code)}</span>
              <span className="truncate">{t.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =============================== room screen ============================== */
function RoomScreen({ session, state, onState, onLeave, onEnterLive }: {
  session: { code: string; token: string; name: string; team: string };
  state: MPState;
  onState: (s: MPState) => void;
  onLeave: () => void;
  onEnterLive: (key: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<{ code: string; state: MPState }>) =>
    p.then((r) => { onState(r.state); setError(null); }).catch((e) => setError(friendly(e)));

  return (
    <div className="space-y-4">
      <RoomHeader state={state} onLeave={onLeave} />
      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      {state.awaiting_live && <LiveBanner state={state} onEnterLive={onEnterLive} />}
      {state.phase === "lobby" ? (
        <Lobby state={state} onStart={() => act(api.mpStart(session.code, session.token))}
          onSwitch={(team) => act(api.mpSwitchTeam(session.code, session.token, team))} />
      ) : state.phase === "draft" ? (
        <DraftBoard state={state}
          onPick={(team) => act(api.mpDraftPick(session.code, session.token, team))} />
      ) : state.done ? (
        <FinalScreen state={state} onLeave={onLeave} />
      ) : state.you.needs_lineup && !state.awaiting_live ? (
        <LineupSubmit state={state}
          onSubmit={(xi, mentality) => act(api.mpSubmit(session.code, session.token, xi, mentality))} />
      ) : (
        <WaitingScreen state={state}
          onPredict={(picks) => act(api.mpPredict(session.code, session.token, picks))} />
      )}
      {state.phase !== "lobby" && state.phase !== "draft" && <ChatPanel state={state}
        onSend={(text) => act(api.mpChat(session.code, session.token, text))} />}
    </div>
  );
}

function RoomHeader({ state, onLeave }: { state: MPState; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  const stage = state.phase === "lobby" ? "Lobby"
    : state.phase === "draft" ? "Draft in progress"
    : state.phase === "group" ? `Group stage · Matchday ${state.matchday}`
    : state.phase === "knockout" ? state.ko_label : "Final whistle";
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <button onClick={onLeave} className="btn-ghost text-sm">← Leave</button>
      <span className="text-3xl">{state.you.team ? flag(state.you.team) : "🎲"}</span>
      <div className="flex-1">
        <div className="font-display text-xl">{state.you.team_name || state.you.name}</div>
        <div className="text-[11px] text-white/50">{state.you.name} · {stage}</div>
      </div>
      <Countdown deadlineAt={state.deadline_at} />
      {state.you.form.length > 0 && (
        <div className="flex items-center gap-1">
          {state.you.form.map((f, i) => (
            <span key={i} className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${f === "W" ? "bg-pitch text-white" : f === "D" ? "bg-white/20" : "bg-red-500/40"}`}>{f}</span>
          ))}
        </div>
      )}
      <button
        onClick={() => { navigator.clipboard?.writeText(state.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="rounded-lg bg-ink/60 px-3 py-1.5 font-display text-lg tracking-[0.25em] text-gold ring-1 ring-gold/40 hover:bg-ink"
        title="Copy room code">
        {copied ? "COPIED!" : state.code}
      </button>
    </div>
  );
}

function Countdown({ deadlineAt }: { deadlineAt: number | null }) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  if (!deadlineAt) return null;
  const left = Math.max(0, deadlineAt - now);
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = Math.floor(left % 60);
  const txt = h > 0 ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, "0")}`;
  return (
    <span className={`rounded-lg px-2 py-1 text-xs font-bold tabular-nums ${left < 120 ? "bg-red-500/20 text-red-300" : "bg-white/10 text-white/60"}`}>
      ⏰ {txt}
    </span>
  );
}

function LiveBanner({ state, onEnterLive }: { state: MPState; onEnterLive: (key: string) => void }) {
  return (
    <div className="card border border-gold/40 p-4">
      <div className="font-display text-lg tracking-wide text-gold">🔥 GRUDGE MATCH IN PROGRESS</div>
      <div className="mt-2 space-y-2">
        {state.live_h2h.map((lv) => (
          <div key={lv.key} className="flex flex-wrap items-center gap-3 rounded-lg bg-ink/50 px-3 py-2">
            <span className="text-xl">{flag(lv.home)}</span>
            <span className="font-display tabular-nums">{lv.home_goals}:{lv.away_goals}</span>
            <span className="text-xl">{flag(lv.away)}</span>
            <span className="text-xs text-white/50">{lv.home_manager} vs {lv.away_manager} · {lv.minute}'</span>
            <button onClick={() => onEnterLive(lv.key)} className="btn-primary ml-auto text-sm">
              {lv.your_side ? "⚽ Take the dugout" : "👀 Watch live"}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-white/40">
        The round reveals once the live match finishes.
      </div>
    </div>
  );
}

/* --------------------------------- lobby --------------------------------- */
function Lobby({ state, onStart, onSwitch }: { state: MPState; onStart: () => void; onSwitch: (team: string) => void }) {
  const you = state.you;
  const draftRoom = !!state.draft;
  const taken = state.players.filter((p) => !p.is_you && p.team).map((p) => p.team as string);
  const [picking, setPicking] = useState(false);
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-lg tracking-wide">MANAGERS IN THE ROOM</h3>
          <span className="text-xs text-white/40">
            {draftRoom && "🎲 draft room · "}
            {state.deadline_minutes > 0 && `⏰ ${state.deadline_minutes}min rounds · `}
            {state.players.length}/12
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {state.players.map((p) => (
            <div key={p.name} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${p.is_you ? "bg-pitch/20 ring-1 ring-pitch/40" : "bg-ink/40"}`}>
              <span className="text-2xl">{p.team ? flag(p.team) : "🎲"}</span>
              <div className="flex-1">
                <div className="text-sm font-semibold">{p.name} {p.host && <span className="text-[10px] text-gold">HOST</span>}</div>
                <div className="text-xs text-white/50">{p.team_name || "drafting later"}</div>
              </div>
              {p.is_you && <span className="text-[10px] text-white/40">YOU</span>}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!draftRoom && (
            <button onClick={() => setPicking((v) => !v)} className="btn-ghost text-sm">
              {picking ? "Keep " + (you.team_name || "") : "↺ Switch team"}
            </button>
          )}
          {you.host ? (
            <button onClick={onStart} className="btn-primary ml-auto">
              {draftRoom ? "🎲 Start the draft" : "▶ Start tournament"}
            </button>
          ) : (
            <span className="ml-auto animate-pulse text-sm text-white/50">Waiting for the host to start…</span>
          )}
        </div>
        {picking && !draftRoom && (
          <div className="mt-3">
            <TeamPicker value={you.team || ""} taken={taken} onChange={(t) => { onSwitch(t); setPicking(false); }} />
          </div>
        )}
      </div>
      <div className="card p-4 text-sm text-white/60">
        📣 Share the code <span className="font-display tracking-widest text-gold">{state.code}</span> —
        friends open this page, hit “Join with a code”, and you all play the same World Cup.
        The unmanaged nations are run by the AI.
      </div>
    </div>
  );
}

/* --------------------------------- draft ---------------------------------- */
function DraftBoard({ state, onPick }: { state: MPState; onPick: (team: string) => void }) {
  const d = state.draft!;
  const [team, setTeam] = useState("");
  return (
    <div className="space-y-4">
      <div className="card p-5 text-center">
        <div className="font-display text-2xl tracking-wide">🎲 NATION DRAFT</div>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {d.order.map((n, i) => (
            <span key={n} className={`rounded-full px-3 py-1 text-sm ${i === d.position ? "bg-gold text-ink font-bold" : i < d.position ? "bg-pitch/30" : "bg-white/10 text-white/50"}`}>
              {i + 1}. {n}
            </span>
          ))}
        </div>
        <div className="mt-3 text-lg">
          {d.your_turn ? <span className="font-bold text-gold">You're on the clock! Pick your nation.</span>
            : <span className="animate-pulse text-white/60">{d.on_clock} is on the clock…</span>}
        </div>
      </div>
      {d.your_turn && (
        <div className="card space-y-3 p-4">
          <TeamPicker value={team} onChange={setTeam} taken={d.taken} />
          <button onClick={() => team && onPick(team)} disabled={!team} className="btn-primary w-full">
            ✓ Draft {team || "…"}
          </button>
        </div>
      )}
      <div className="card p-3">
        <div className="mb-1 font-display text-sm tracking-wide text-white/60">PICKS SO FAR</div>
        <div className="flex flex-wrap gap-2">
          {state.players.filter((p) => p.team).map((p) => (
            <span key={p.name} className="rounded-lg bg-ink/50 px-2 py-1 text-sm">
              {flag(p.team!)} {p.team_name} <span className="text-white/40">— {p.name}</span>
            </span>
          ))}
          {!state.players.some((p) => p.team) && <span className="text-xs text-white/30">none yet</span>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- lineup submit ----------------------------- */
function LineupSubmit({ state, onSubmit }: { state: MPState; onSubmit: (xi: string[], mentality: string) => void }) {
  const you = state.you;
  const [formation, setFormation] = useState("4-3-3");
  const [xi, setXi] = useState<string[]>(() => pickXI(you.squad, "4-3-3"));
  const [mentality, setMentality] = useState("balanced");
  const [busy, setBusy] = useState(false);
  const unavailable = useMemo(() => new Set(you.squad.filter((p) => p.suspended || p.injured).map((p) => p.id)), [you.squad]);
  const nf = you.next_fixture;
  const grudge = nf?.opp_manager;

  return (
    <>
      <div className={`card p-4 ${grudge ? "ring-1 ring-gold" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-gold">{nf?.stage}</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
              vs <span className="text-2xl">{flag(nf?.opponent || "")}</span> {state.team_names[nf?.opponent || ""]}
            </div>
            {grudge && (
              <div className="mt-1 text-sm text-gold">🔥 GRUDGE MATCH vs {grudge} — played LIVE, dugout to dugout</div>
            )}
          </div>
          <WaitingChips state={state} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-white/50">Mentality:</span>
          {MENTALITIES.map((m) => (
            <button key={m.key} onClick={() => setMentality(m.key)}
              className={`rounded-lg px-3 py-1 text-sm font-semibold ${mentality === m.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
              {m.icon} {m.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <span className={`text-sm ${xi.length === 11 ? "text-gold" : "text-white/40"}`}>{xi.length}/11</span>
            <button onClick={() => setXi(pickXI(you.squad, formation))} className="btn-ghost text-sm">Auto</button>
            <button disabled={xi.length !== 11 || busy}
              onClick={() => { setBusy(true); onSubmit(xi, mentality); }}
              className="btn-primary">{busy ? "…" : "✓ Lock in lineup"}</button>
          </div>
        </div>
        {unavailable.size > 0 && (
          <div className="mt-2 text-xs text-red-300">
            {you.squad.some((p) => p.suspended) && <>🚫 {you.squad.filter((p) => p.suspended).map((p) => p.name).join(", ")} </>}
            {you.squad.some((p) => p.injured) && <>🤕 {you.squad.filter((p) => p.injured).map((p) => `${p.name} (${p.injured_rounds})`).join(", ")}</>}
          </div>
        )}
      </div>
      <PitchLineup squad={you.squad as unknown as Player[]} selected={xi} formation={formation}
        onChange={setXi} onFormation={(f: string) => { setFormation(f); setXi(pickXI(you.squad, f)); }}
        unavailable={unavailable} />
      <RoundResults state={state} />
      <GroupMini state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Standings state={state} />
        <TopScorers rows={state.top_scorers} highlightTeam={state.you.team} />
      </div>
    </>
  );
}

/* ------------------------------ waiting room ------------------------------ */
function WaitingScreen({ state, onPredict }: { state: MPState; onPredict: (picks: Record<string, string>) => void }) {
  const out = !state.you.alive;
  return (
    <div className="space-y-4">
      <div className="card p-5 text-center">
        {out ? (
          <>
            <div className="text-lg font-semibold text-white/80">You're out — but still in the game 👀</div>
            <div className="mt-1 text-sm text-white/50">
              {state.you.eliminated_round === "groups" ? "Eliminated in the group stage."
                : `Knocked out in the ${roundName(state.you.eliminated_round || "")}.`}{" "}
              Call the remaining results below to climb the prediction standings.
            </div>
          </>
        ) : (
          <>
            <div className="text-lg font-semibold">Lineup locked in ✓</div>
            <div className="mt-1 animate-pulse text-sm text-white/50">
              Waiting on {state.waiting_on.length ? state.waiting_on.join(", ") : "the next round"}…
            </div>
          </>
        )}
        <div className="mt-3"><WaitingChips state={state} /></div>
      </div>
      <PredictionPicker state={state} onPredict={onPredict} />
      <RoundResults state={state} />
      <GroupMini state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Standings state={state} />
        <TopScorers rows={state.top_scorers} highlightTeam={state.you.team} />
      </div>
      <H2H state={state} />
    </div>
  );
}

function PredictionPicker({ state, onPredict }: { state: MPState; onPredict: (picks: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  const yours = state.you.predictions || {};
  if (!state.predictable.length) return null;
  const undecided = state.predictable.filter((m) => !yours[m.key]).length;
  return (
    <div className="card p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <span className="font-display text-lg tracking-wide">🔮 CALL THE OTHER MATCHES</span>
        <span className="text-xs text-white/40">
          +1 pt per correct call · {undecided > 0 ? `${undecided} open` : "all called"} {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="mt-2 grid gap-1.5 md:grid-cols-2">
          {state.predictable.map((m) => (
            <div key={m.key} className="flex items-center gap-2 rounded-lg bg-ink/40 px-2 py-1.5 text-sm">
              <span className="flex min-w-0 flex-1 items-center justify-end gap-1 truncate text-right">
                {state.team_names[m.home]} {flag(m.home)}
              </span>
              <span className="flex gap-0.5">
                {(["H", "D", "A"] as const).map((pick) => (
                  <button key={pick} onClick={() => onPredict({ [m.key]: pick })}
                    className={`h-7 w-7 rounded text-xs font-bold ${yours[m.key] === pick ? "bg-gold text-ink" : "bg-white/5 text-white/50 hover:bg-white/15"}`}>
                    {pick === "H" ? "1" : pick === "D" ? "X" : "2"}
                  </button>
                ))}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                {flag(m.away)} {state.team_names[m.away]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaitingChips({ state }: { state: MPState }) {
  if (state.phase === "lobby" || state.phase === "draft" || state.done) return null;
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {state.players.filter((p) => p.alive && p.team).map((p) => (
        <span key={p.name}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${p.submitted ? "bg-pitch/30 text-white" : "bg-white/10 text-white/50"}`}>
          {flag(p.team!)} {p.name} {p.submitted ? "✓" : "…"}
        </span>
      ))}
    </div>
  );
}

/* --------------------------------- chat ----------------------------------- */
function ChatPanel({ state, onSend }: { state: MPState; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [state.chat.length]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="card p-3">
      <div className="mb-1 font-display text-sm tracking-wide text-white/60">💬 TRASH TALK</div>
      <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
        {state.chat.length === 0 && <div className="text-xs text-white/30">Silence before the storm…</div>}
        {state.chat.map((m, i) => (
          <div key={i} className={`text-sm ${m.system ? "text-white/40 italic" : ""}`}>
            {!m.system && (
              <span className="font-semibold text-gold">
                {m.team ? `${flag(m.team)} ` : ""}{m.name}:{" "}
              </span>
            )}
            {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="mt-2 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Say it to their face…"
          className="min-w-0 flex-1 rounded-lg bg-ink/60 px-3 py-1.5 text-sm outline-none ring-1 ring-white/10 focus:ring-gold" />
        <button onClick={send} className="btn-ghost text-sm">Send</button>
      </div>
    </div>
  );
}

/* ------------------------------ shared panels ----------------------------- */
function ScoreRow({ m, state }: { m: MPMatch; state: MPState }) {
  const names = state.team_names;
  const mine = state.you.team === m.home || state.you.team === m.away;
  const grudge = m.home_manager && m.away_manager;
  const hw = m.home_goals > m.away_goals || (m.penalties && (m.home_pens ?? 0) > (m.away_pens ?? 0));
  const tag = (mgr?: string | null) => mgr ? <span className="text-[9px] text-gold"> {mgr}</span> : null;
  return (
    <div className={`rounded-lg px-3 py-2 ${mine ? "bg-pitch/20 ring-1 ring-pitch/40" : grudge ? "bg-gold/10 ring-1 ring-gold/40" : "bg-ink/40"}`}>
      <div className="flex items-center gap-2">
        <div className={`flex flex-1 items-center justify-end gap-2 text-right ${hw ? "font-bold" : "text-white/60"}`}>
          <span className="truncate text-sm">{names[m.home] || m.home}{tag(m.home_manager)}</span><span>{flag(m.home)}</span>
        </div>
        <span className="rounded bg-ink px-2 py-0.5 font-display tabular-nums">{m.home_goals}:{m.away_goals}</span>
        <div className={`flex flex-1 items-center gap-2 ${!hw && m.home_goals !== m.away_goals ? "font-bold" : "text-white/60"}`}>
          <span>{flag(m.away)}</span><span className="truncate text-sm">{names[m.away] || m.away}{tag(m.away_manager)}</span>
        </div>
      </div>
      {m.penalties && <div className="mt-0.5 text-center text-[10px] text-gold">{m.home_pens}–{m.away_pens} pens</div>}
      {(m.events || []).filter((e) => e.type === "goal").length > 0 && (
        <div className="mt-1 text-center text-[10px] text-white/40">
          {(m.events || []).filter((e) => e.type === "goal").map((e, i) => (
            <span key={i}>{i > 0 && " · "}⚽ {e.scorer} {e.minute}'</span>
          ))}
        </div>
      )}
    </div>
  );
}

function RoundResults({ state }: { state: MPState }) {
  if (!state.last_round.length) return null;
  const label = state.phase === "group"
    ? `MATCHDAY ${Math.max(1, (state.matchday || 1) - 1)} RESULTS`
    : "LAST ROUND";
  return (
    <div>
      <h3 className="mb-2 font-display text-lg tracking-wide">{label}</h3>
      <div className="grid gap-1.5 md:grid-cols-2">
        {state.last_round.map((m, i) => <ScoreRow key={i} m={m} state={state} />)}
      </div>
    </div>
  );
}

function GroupMini({ state }: { state: MPState }) {
  if (!state.group_table.length) return null;
  return (
    <div className="card p-3">
      <div className="mb-1 font-display text-lg text-gold">GROUP {state.you.group}</div>
      <table className="w-full text-sm"><tbody>
        {state.group_table.map((r, i) => (
          <tr key={r.code} className={r.code === state.you.team ? "text-gold" : i < 2 ? "text-white" : "text-white/50"}>
            <td className="py-1">{flag(r.code)} {state.team_names[r.code] || r.code}</td>
            <td className="text-center text-white/40">{r.played}</td>
            <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
            <td className="text-center font-bold">{r.points}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function Standings({ state }: { state: MPState }) {
  if (state.players.length < 2) return null;
  return (
    <div className="card p-3">
      <div className="mb-2 font-display text-lg tracking-wide">MANAGER LEADERBOARD</div>
      <div className="space-y-1.5">
        {state.standings.map((s) => (
          <div key={s.name} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${s.alive ? "bg-ink/40" : "bg-ink/20 opacity-60"}`}>
            <span className="text-xl">{flag(s.team)}</span>
            <span className="text-sm font-semibold">{s.name}</span>
            <span className="flex-1 truncate text-xs text-white/40">{s.team_name}</span>
            {s.pred_points > 0 && <span className="text-xs text-white/50" title="prediction points">🔮 {s.pred_points}</span>}
            <span className={`text-xs ${s.alive ? "text-pitch" : "text-white/40"}`}>{s.progress}</span>
            <span className="flex gap-0.5">
              {s.form.map((f, i) => (
                <span key={i} className={`flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold ${f === "W" ? "bg-pitch text-white" : f === "D" ? "bg-white/20" : "bg-red-500/40"}`}>{f}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function H2H({ state }: { state: MPState }) {
  if (!state.h2h.length) return null;
  return (
    <div>
      <h3 className="mb-2 font-display text-lg tracking-wide">🔥 GRUDGE MATCHES</h3>
      <div className="grid gap-1.5 md:grid-cols-2">
        {state.h2h.map((m, i) => <ScoreRow key={i} m={m} state={state} />)}
      </div>
    </div>
  );
}

/* ------------------------------ final screen ------------------------------ */
function FinalScreen({ state, onLeave }: { state: MPState; onLeave: () => void }) {
  const youWon = !!state.you.team && state.champion === state.you.team;
  useEffect(() => { if (youWon) sound.fanfare(); }, [youWon]);
  const card = () => downloadShareCard({
    kind: "multiplayer",
    title: youWon ? "I BEAT MY FRIENDS TO THE WORLD CUP" : "WORLD CHAMPIONS",
    teamCode: state.champion || undefined,
    teamName: state.champion_name || undefined,
    lines: [
      state.champion_manager ? `Managed by ${state.champion_manager}` : "The AI lifted the trophy…",
      ...state.standings.slice(0, 3).map((s, i) => `${["🥇", "🥈", "🥉"][i] || "·"} ${s.name} — ${s.progress}`),
    ],
    won: youWon,
  });
  return (
    <div className="space-y-4">
      {youWon && <Confetti />}
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        className={`card p-8 text-center ${youWon ? "ring-2 ring-gold" : ""}`}>
        <div className="text-6xl">{flag(state.champion || "")}</div>
        <div className="mt-2 font-display text-4xl tracking-wide">{state.champion_name}</div>
        <div className="mt-1 text-2xl font-bold text-gold">WORLD CHAMPIONS</div>
        {state.champion_manager && (
          <div className="mt-2 text-lg">
            🏆 Managed by <span className="font-semibold text-gold">{state.champion_manager}</span>
            {youWon && " — that's you!"}
          </div>
        )}
        {!state.champion_manager && (
          <div className="mt-2 text-sm text-white/50">The AI takes the trophy this time…</div>
        )}
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={card} className="btn-ghost text-sm">🖼 Save share card</button>
          <Link to="/profile" className="btn-ghost text-sm">🎖 Profile</Link>
          <button onClick={onLeave} className="btn-primary">← New tournament</button>
        </div>
      </motion.div>
      <div className="grid gap-4 md:grid-cols-2">
        <Standings state={state} />
        <TopScorers rows={state.top_scorers} highlightTeam={state.you.team} />
      </div>
      <H2H state={state} />
      <RoundResults state={state} />
    </div>
  );
}

function roundName(r: string): string {
  return { groups: "group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", F: "Final" }[r] || r;
}

function friendly(e: any): string {
  const msg = String(e?.message || e);
  if (/^\d{3} \//.test(msg)) return "That didn't work — check the room code and try again.";
  return msg;
}
