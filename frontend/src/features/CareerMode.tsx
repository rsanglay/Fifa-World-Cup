import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { api, flag } from "../api/client";
import LineupBuilderDnD from "../components/LineupBuilderDnD";
import LiveMatchWS from "../components/live/LiveMatchWS";
import NextUp from "../components/NextUp";
import RatingsPanel from "../components/RatingsPanel";
import Confetti from "../components/Confetti";
import EventCard from "../components/EventCard";
import ShareButton from "../components/ShareButton";
import TopScorers from "../components/TopScorers";
import { downloadShareCard } from "../lib/shareCard";
import { profileStore } from "../lib/profileStore";
import { sound } from "../lib/sound";
import { careerStore } from "../lib/careerStore";
import type { ManagedMatch, ManagedSquadPlayer, ManagedState } from "../types";

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "5-3-2": [5, 3, 2],
};
const MENTALITIES = [
  { key: "defensive", label: "Defensive", icon: "🛡️" },
  { key: "balanced", label: "Balanced", icon: "⚖️" },
  { key: "attacking", label: "Attacking", icon: "⚔️" },
];

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

type UIPhase = "next" | "lineup" | "live" | "result";

export default function CareerMode({ team, onExit, resumeSession }: { team: string; onExit: () => void; resumeSession?: string }) {
  const [sid, setSid] = useState("");
  const [matchSid, setMatchSid] = useState<string | null>(null);
  const [initialFrame, setInitialFrame] = useState<any>(null);
  const [state, setState] = useState<ManagedState | null>(null);
  const [xi, setXi] = useState<string[]>([]);
  const [formation, setFormation] = useState("4-3-3");
  const [mentality, setMentality] = useState("balanced");
  const [lastStamina, setLastStamina] = useState<Record<string, number> | undefined>();
  const [preview, setPreview] = useState<{ win: number; draw: number; lose: number; your_key: string; opp_key: string } | null>(null);
  const [ui, setUi] = useState<UIPhase>("next");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onReady = (r: { session_id: string; state: ManagedState }) => {
      setSid(r.session_id); setState(r.state); setXi(pickXI(r.state.squad, "4-3-3"));
      careerStore.setActive({ sessionId: r.session_id, team, teamName: r.state.team_name });
      if (r.state.live && !r.state.live.done) {
        // A live match is in progress: reopen the WebSocket match session.
        // (Skip on an old backend mid-deploy — no ws_path means no WS route.)
        api.manageLiveStart(r.session_id, [], "balanced").then((res) => {
          if (res.session_id && res.ws_path) {
            setMatchSid(res.session_id);
            setInitialFrame((res as any).frame || null);
            setUi("live");
          }
        }).catch(() => undefined);
      }
    };
    const p = resumeSession
      ? api.manageGet(resumeSession).catch(() => api.manageStart(team))
      : api.manageStart(team);
    p.then(onReady).catch((e) => setError(String(e?.message || e)));
  }, [team, resumeSession]);

  // Record completed careers to the trophy cabinet, then clear the active run.
  const recorded = useRef(false);
  useEffect(() => {
    if (state?.done && !recorded.current) {
      recorded.current = true;
      careerStore.addRecord({
        team, teamName: state.team_name,
        outcome: state.won ? "Champions" : roundName(state.eliminated_round || "groups"),
        won: state.won, avgRating: state.avg_rating, achievements: state.achievements.length,
        when: state.team_name,
      });
      careerStore.clearActive();
      profileStore.recordCareer(state, team);
    }
  }, [state?.done]); // eslint-disable-line

  const [softError, setSoftError] = useState<string | null>(null);
  const suspended = useMemo(() => new Set((state?.squad || []).filter((p) => p.suspended || p.injured).map((p) => p.id)), [state]);
  useEffect(() => { if (xi.some((id) => id && suspended.has(id))) setXi((c) => c.map((id) => (suspended.has(id) ? "" : id))); }, [suspended]); // eslint-disable-line

  // Fetch pre-match preview when XI / mentality change pre-match.
  const xiClean = useMemo(() => xi.filter(Boolean), [xi]);
  useEffect(() => {
    if ((ui === "lineup" || ui === "next") && sid && xiClean.length === 11) {
      api.managePreview(sid, xiClean, mentality).then((r) => setPreview(r.preview)).catch(() => setPreview(null));
    }
  }, [ui, sid, xiClean, mentality]); // eslint-disable-line

  if (error) return <div className="card p-6 text-center text-danger">{error} <button onClick={onExit} className="btn-ghost ml-2">Back</button></div>;
  if (!state) return <div className="skel h-64" />;

  const names = state.team_names;
  const kickOff = () => {
    if (xiClean.length !== 11) { setUi("lineup"); return; }
    setBusy(true);
    setSoftError(null);
    api.manageLiveStart(sid, xiClean, mentality)
      .then((r) => {
        // Version-skew guard: an old backend (mid-deploy) answers without the
        // WebSocket session — fail with a clear message instead of letting
        // the socket spin against a route that does not exist yet.
        if (r.session_id && !r.ws_path) {
          setSoftError("The match server is running an older version (deploy in progress). Try again in a couple of minutes.");
          setUi("lineup");
        } else if (r.session_id) {
          setMatchSid(r.session_id);
          setInitialFrame((r as any).frame || null);
          setUi("live");
        }
        setBusy(false);
      })
      .catch((e) => {
        // 422 = suspended/injured players named in the XI: back to the builder.
        const d = e?.message || String(e);
        setSoftError(typeof d === "string" ? d : "Ineligible players in the starting XI.");
        setBusy(false);
        setUi("lineup");
      });
  };
  const nextMatch = () => {
    setUi("next"); setPreview(null); setMentality("balanced");
    setXi(pickXI(state.squad, formation));
  };

  return (
    <div className="space-y-4">
      <CareerHeader state={state} team={team} onExit={onExit} />

      {state.done ? (
        <DoneScreen state={state} team={team} onExit={onExit} />
      ) : ui === "next" ? (
        <NextUp state={state} team={team}
          onContinue={kickOff} onRotate={() => setUi("lineup")} />
      ) : ui === "lineup" ? (
        <>
          <div className="card flex flex-wrap items-center gap-3 p-3">
            <span className="text-sm text-txt-secondary">Mentality:</span>
            {MENTALITIES.map((m) => (
              <button key={m.key} onClick={() => setMentality(m.key)}
                className={`rounded-full px-3 py-1 text-sm font-semibold ${mentality === m.key ? "bg-accent text-ink" : "bg-white/5 text-txt-secondary hover:bg-white/10"}`}>
                {m.icon} {m.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {preview && (
                <span className="hidden text-xs text-txt-secondary sm:inline">
                  Win <b className="text-accent">{(preview.win * 100).toFixed(0)}%</b> · Draw {(preview.draw * 100).toFixed(0)}% · Lose <b className="text-danger">{(preview.lose * 100).toFixed(0)}%</b>
                </span>
              )}
              <span className={`text-sm ${xiClean.length === 11 ? "text-accent" : "text-txt-secondary"}`}>{xiClean.length}/11</span>
              <button onClick={() => setXi(pickXI(state.squad, formation))} className="btn-ghost text-sm">Auto</button>
              <button onClick={kickOff} disabled={xiClean.length !== 11 || busy} className="btn-primary">
                {busy ? "…" : "▶ Kick off"}
              </button>
            </div>
          </div>
          {softError && <div className="card p-3 text-sm text-danger">🚫 {softError}</div>}
          <LineupBuilderDnD
            squad={state.squad} selected={xi} formation={formation}
            onChange={setXi}
            onFormation={(f: string) => { setFormation(f); setXi(pickXI(state.squad, f)); }}
            unavailable={suspended} lastStamina={lastStamina}
          />
        </>
      ) : ui === "live" && matchSid ? (
        <LiveMatchWS
          matchSid={matchSid} initialFrame={initialFrame}
          squad={state.squad} names={names} team={team}
          onDone={(st, stamina) => {
            setState(st); setMatchSid(null); setInitialFrame(null);
            setLastStamina(stamina); setUi("result");
          }}
        />
      ) : (
        <ResultPhase state={state} team={team} names={names} onNext={nextMatch} />
      )}

      {(ui === "next" || ui === "lineup") && !state.done && (
        <>
          {state.pending_event && (
            <EventCard event={state.pending_event}
              onChoose={async (choice) => {
                const r = await api.manageEvent(sid, choice);
                setState(r.state);
                return r.outcome;
              }} />
          )}
          {state.news && state.news.length > 0 && (
            <div className="card p-3 text-xs text-white/60">
              {state.news.slice(-3).map((n, i) => <div key={i} className="py-0.5">{n}</div>)}
            </div>
          )}
          <SquadConditionPanel squad={state.squad} xi={xi} />
          <GroupMini state={state} names={names} team={team} />
          <div className="grid gap-4 md:grid-cols-2">
            <TopScorers rows={state.top_scorers || []} highlightTeam={team} />
            <TopScorers rows={state.team_scorers || []} highlightTeam={team} title="YOUR SCORERS" />
          </div>
          {state.journey.length > 0 && <Journey matches={state.journey} names={names} team={team} title="YOUR RUN" />}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- header */
function CareerHeader({ state, team, onExit }: { state: ManagedState; team: string; onExit: () => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <button onClick={onExit} className="btn-ghost text-sm">← Exit</button>
      <span className="text-3xl">{flag(team)}</span>
      <div className="flex-1">
        <div className="font-display text-xl">{state.team_name}</div>
        <div className="text-[11px] text-white/50">🎯 {state.expectation.label}</div>
      </div>
      {state.form.length > 0 && (
        <div className="flex items-center gap-1">
          {state.form.map((f, i) => (
            <span key={i} className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${f === "W" ? "bg-pitch text-white" : f === "D" ? "bg-white/20" : "bg-red-500/40"}`}>{f}</span>
          ))}
        </div>
      )}
      {state.avg_rating != null && (
        <div className="text-center">
          <div className="font-display text-xl text-gold">{state.avg_rating}</div>
          <div className="text-[9px] text-white/40">avg rating</div>
        </div>
      )}
    </div>
  );
}

function ResultPhase({ state, team, names, onNext }: { state: ManagedState; team: string; names: Record<string, string>; onNext: () => void }) {
  const mm = state.last_managed_match!;
  const us = mm.home === team ? mm.home_goals : mm.away_goals;
  const them = mm.home === team ? mm.away_goals : mm.home_goals;
  const won = mm.winner === team;
  useEffect(() => { if (won) sound.fanfare(); }, []); // eslint-disable-line
  return (
    <div className="space-y-3">
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className={`card p-6 text-center ${won ? "ring-1 ring-gold" : ""}`}>
        <div className="text-xs uppercase tracking-wider text-white/40">Full time</div>
        <div className="mt-1 flex items-center justify-center gap-3 font-display text-5xl">
          <span>{flag(mm.home)}</span>{mm.home_goals}<span className="text-white/30">:</span>{mm.away_goals}<span>{flag(mm.away)}</span>
        </div>
        {mm.penalties && <div className="mt-1 text-sm text-gold">{mm.home_pens}–{mm.away_pens} on penalties</div>}
        <div className="mt-2 text-lg font-semibold">{won ? "Win! 🎉" : us === them ? "Draw" : "Defeat"}</div>
        {state.ratings.length > 0 && <div className="mt-1 text-sm text-white/50">Your match rating: <span className="text-gold">{state.ratings[state.ratings.length - 1]}</span></div>}
        <button onClick={onNext} className="btn-primary mt-4">{state.done ? "See outcome" : "Continue →"}</button>
      </motion.div>
      {(state.last_ratings?.length ?? 0) > 0 && <RatingsPanel ratings={state.last_ratings!} />}
      {state.last_round.length > 1 && <Journey matches={state.last_round.filter((m) => !(m.home === team || m.away === team))} names={names} team={team} title="ELSEWHERE THIS ROUND" />}
    </div>
  );
}

/* --------------------------------------------------------------- shared */
function ScoreRow({ m, names, team }: { m: ManagedMatch; names: Record<string, string>; team: string }) {
  const isMine = team === m.home || team === m.away;
  const hw = m.home_goals > m.away_goals || (m.penalties && (m.home_pens ?? 0) > (m.away_pens ?? 0));
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${isMine ? "bg-pitch/20 ring-1 ring-pitch/40" : "bg-ink/40"}`}>
      <div className={`flex flex-1 items-center justify-end gap-2 text-right ${hw ? "font-bold" : "text-white/60"}`}>
        <span className="truncate text-sm">{names[m.home] || m.home}</span><span>{flag(m.home)}</span>
      </div>
      <span className="rounded bg-ink px-2 py-0.5 font-display tabular-nums">{m.home_goals}:{m.away_goals}</span>
      <div className={`flex flex-1 items-center gap-2 ${!hw && m.home_goals !== m.away_goals ? "font-bold" : "text-white/60"}`}>
        <span>{flag(m.away)}</span><span className="truncate text-sm">{names[m.away] || m.away}</span>
      </div>
    </div>
  );
}
function Journey({ matches, names, team, title }: { matches: ManagedMatch[]; names: Record<string, string>; team: string; title: string }) {
  if (!matches.length) return null;
  return (
    <div>
      <h3 className="mb-2 font-display text-lg tracking-wide">{title}</h3>
      <div className="grid gap-1.5 md:grid-cols-2">{matches.map((m, i) => <ScoreRow key={i} m={m} names={names} team={team} />)}</div>
    </div>
  );
}
function GroupMini({ state, names, team }: { state: ManagedState; names: Record<string, string>; team: string }) {
  return (
    <div className="card p-3">
      <div className="mb-1 font-display text-lg text-gold">GROUP {state.group}</div>
      <table className="w-full text-sm"><tbody>
        {state.group_table.map((r, i) => (
          <tr key={r.code} className={r.code === team ? "text-gold" : i < 2 ? "text-white" : "text-white/50"}>
            <td className="py-1">{flag(r.code)} {names[r.code] || r.code}</td>
            <td className="text-center text-white/40">{r.played}</td>
            <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
            <td className="text-center font-bold">{r.points}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function DoneScreen({ state, team, onExit }: { state: ManagedState; team: string; onExit: () => void }) {
  const won = state.won;
  const names = state.team_names;
  const verdict = won ? "🏆 WORLD CHAMPIONS!" : state.eliminated_round === "groups" ? "Out in the group stage" : `Knocked out in the ${roundName(state.eliminated_round || "")}`;
  return (
    <div className="space-y-4">
      {won && <Confetti />}
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className={`card p-8 text-center ${won ? "ring-2 ring-gold" : ""}`}>
        <div className="text-6xl">{flag(team)}</div>
        <div className="mt-2 font-display text-4xl tracking-wide">{state.team_name}</div>
        <div className={`mt-2 text-2xl font-bold ${won ? "text-gold" : "text-white/80"}`}>{verdict}</div>
        {state.review && <div className="mt-1 text-sm text-white/60">{state.review}</div>}
        {state.avg_rating != null && <div className="mt-1 text-xs text-white/40">Avg match rating {state.avg_rating} · {state.journey.length} matches managed</div>}
        {state.achievements.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {state.achievements.map((a) => <span key={a} className="rounded-full bg-white/10 px-3 py-1 text-xs">🏅 {a}</span>)}
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button onClick={() => downloadShareCard({
            kind: "career", title: state.won ? "WORLD CHAMPIONS" : verdict,
            teamCode: team, teamName: state.team_name,
            lines: [
              `Avg rating ${state.avg_rating ?? "—"} · ${state.journey.length} matches`,
              ...(state.achievements.slice(0, 3).map((a) => `🏅 ${a}`)),
            ],
            won: state.won,
          })} className="btn-ghost text-sm">🖼 Save share card</button>
          <ShareButton info={{
            headline: `MANAGED ${state.team_name.toUpperCase()}`,
            championCode: won ? team : (state.champion || team), championName: won ? state.team_name : (state.champion_name || ""),
            lines: [verdict.replace(/^[^A-Za-z]+/, "")],
            url: window.location.origin + "/simulator",
            shareText: won ? `🏆 I managed ${state.team_name} to World Cup glory, match by match!` : `I managed ${state.team_name} at the World Cup — ${verdict.replace(/^[^A-Za-z]+/, "").toLowerCase()}.`,
          }} />
        </div>
        <button onClick={onExit} className="btn-ghost mt-3 text-sm">← New career</button>
      </motion.div>
      <div className="grid gap-4 md:grid-cols-2">
        <TopScorers rows={state.top_scorers || []} highlightTeam={team} />
        <TopScorers rows={state.team_scorers || []} highlightTeam={team} title="YOUR SCORERS" />
      </div>
      <Journey matches={state.journey} names={names} team={team} title="YOUR RUN" />
    </div>
  );
}

/* Squad condition: who is sharp, who is cooked, who is sulking. */
function SquadConditionPanel({ squad, xi }: { squad: ManagedSquadPlayer[]; xi: string[] }) {
  const [open, setOpen] = useState(false);
  const sel = new Set(xi);
  const rows = [...squad].sort((a, b) => (b.condition_pct ?? 100) - (a.condition_pct ?? 100));
  const flagged = squad.filter((p) => (p.fatigue ?? 0) >= 55 || (p.sharpness ?? 100) <= 55);
  return (
    <div className="card p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <span className="font-display text-lg tracking-wide">💪 SQUAD CONDITION</span>
        <span className="text-xs text-white/40">
          {flagged.length > 0 ? `${flagged.length} player(s) need attention` : "all fresh"} {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {rows.map((p) => (
            <div key={p.id} className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${sel.has(p.id) ? "bg-pitch/15" : "bg-ink/40"}`}>
              <span className="w-7 rounded bg-white/10 text-center text-[9px]">{p.position}</span>
              <span className="min-w-0 flex-1 truncate">{p.injured ? "🤕 " : ""}{p.name}</span>
              <CondBar label="SHP" value={p.sharpness ?? 100} good={70} />
              <CondBar label="FAT" value={100 - (p.fatigue ?? 0)} good={50} />
              <CondBar label="MOR" value={p.morale ?? 70} good={55} />
              <span className={`w-9 text-right font-bold tabular-nums ${(p.condition_pct ?? 100) >= 98 ? "text-emerald-300" : (p.condition_pct ?? 100) >= 92 ? "text-amber-300" : "text-red-300"}`}>
                {p.condition_pct ?? 100}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function CondBar({ label, value, good }: { label: string; value: number; good: number }) {
  const col = value >= good + 20 ? "bg-emerald-400" : value >= good ? "bg-amber-400" : "bg-red-400";
  return (
    <span className="flex items-center gap-1" title={label}>
      <span className="text-[8px] text-white/30">{label}</span>
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-white/10">
        <span className={`block h-full ${col}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
    </span>
  );
}
function roundName(r: string): string {
  return { groups: "group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", F: "Final" }[r] || r;
}
