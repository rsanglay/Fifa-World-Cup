import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, flag } from "../api/client";
import LineupPicker from "../components/LineupPicker";
import Confetti from "../components/Confetti";
import ShareButton from "../components/ShareButton";
import { sound } from "../lib/sound";
import { careerStore } from "../lib/careerStore";
import type { ManagedMatch, ManagedSquadPlayer, ManagedState, MatchEvent, Player } from "../types";

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
  const avail = squad.filter((p) => !p.suspended);
  const out: string[] = [];
  (["GK", "DEF", "MID", "FWD"] as const).forEach((pos) => {
    out.push(...avail.filter((p) => p.position === pos).sort((a, b) => b.rating - a.rating).slice(0, need[pos]).map((p) => p.id));
  });
  return out;
}

type UIPhase = "select" | "firsthalf" | "halftime" | "secondhalf" | "result";

export default function CareerMode({ team, onExit, resumeSession }: { team: string; onExit: () => void; resumeSession?: string }) {
  const [sid, setSid] = useState("");
  const [state, setState] = useState<ManagedState | null>(null);
  const [xi, setXi] = useState<string[]>([]);
  const [formation, setFormation] = useState("4-3-3");
  const [mentality, setMentality] = useState("balanced");
  const [secondMentality, setSecondMentality] = useState("balanced");
  const [preview, setPreview] = useState<{ win: number; draw: number; lose: number; your_key: string; opp_key: string } | null>(null);
  const [ui, setUi] = useState<UIPhase>("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onReady = (r: { session_id: string; state: ManagedState }) => {
      setSid(r.session_id); setState(r.state); setXi(pickXI(r.state.squad, "4-3-3"));
      careerStore.setActive({ sessionId: r.session_id, team, teamName: r.state.team_name });
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
    }
  }, [state?.done]); // eslint-disable-line

  const suspended = useMemo(() => new Set((state?.squad || []).filter((p) => p.suspended).map((p) => p.id)), [state]);
  useEffect(() => { if (xi.some((id) => suspended.has(id))) setXi((c) => c.filter((id) => !suspended.has(id))); }, [suspended]); // eslint-disable-line

  // Fetch pre-match preview when XI / mentality change in select phase.
  useEffect(() => {
    if (ui === "select" && sid && xi.length === 11) {
      api.managePreview(sid, xi, mentality).then((r) => setPreview(r.preview)).catch(() => setPreview(null));
    }
  }, [ui, sid, xi, mentality]); // eslint-disable-line

  if (error) return <div className="card p-6 text-center text-red-300">{error} <button onClick={onExit} className="btn-ghost ml-2">Back</button></div>;
  if (!state) return <div className="skel h-64" />;

  const names = state.team_names;
  const kickOff = () => {
    if (xi.length !== 11) return;
    setBusy(true);
    api.managePlay(sid, xi, mentality).then((r) => { setState(r.state); setSecondMentality(mentality); setUi("firsthalf"); setBusy(false); })
      .catch((e) => { setError(String(e?.message || e)); setBusy(false); });
  };
  const resume = () => {
    setBusy(true);
    api.manageSecondHalf(sid, secondMentality).then((r) => { setState(r.state); setUi("secondhalf"); setBusy(false); })
      .catch((e) => { setError(String(e?.message || e)); setBusy(false); });
  };
  const nextMatch = () => {
    setUi("select"); setPreview(null); setMentality("balanced");
    setXi(pickXI(state.squad, formation));
  };

  return (
    <div className="space-y-4">
      <CareerHeader state={state} team={team} onExit={onExit} />

      {state.done ? (
        <DoneScreen state={state} team={team} onExit={onExit} />
      ) : ui === "select" ? (
        <SelectPhase
          state={state} xi={xi} formation={formation} mentality={mentality} preview={preview}
          suspended={suspended} busy={busy}
          onToggle={(id: string) => setXi((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
          onFormation={(f: string) => { setFormation(f); setXi(pickXI(state.squad, f)); }}
          onMentality={setMentality} onAuto={() => setXi(pickXI(state.squad, formation))} onKickOff={kickOff}
        />
      ) : ui === "firsthalf" && state.half_time ? (
        <SegmentMatch key="fh" events={state.half_time.events} home={state.half_time.home} away={state.half_time.away}
          names={names} start={0} end={45} onDone={() => setUi("halftime")} />
      ) : ui === "halftime" && state.half_time ? (
        <HalfTime state={state} secondMentality={secondMentality} setSecondMentality={setSecondMentality} onResume={resume} busy={busy} />
      ) : ui === "secondhalf" && state.last_managed_match ? (
        <SegmentMatch key="sh" events={state.last_managed_match.events || []} home={state.last_managed_match.home} away={state.last_managed_match.away}
          names={names} start={45} end={maxMinute(state.last_managed_match)} onDone={() => setUi("result")} />
      ) : (
        <ResultPhase state={state} team={team} names={names} onNext={nextMatch} />
      )}

      {ui === "select" && !state.done && (
        <>
          <GroupMini state={state} names={names} team={team} />
          {state.journey.length > 0 && <Journey matches={state.journey} names={names} team={team} title="YOUR RUN" />}
        </>
      )}
    </div>
  );
}

function maxMinute(m: ManagedMatch): number {
  const mx = Math.max(90, ...(m.events || []).map((e) => e.minute));
  return mx > 90 ? 120 : 90;
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

/* ------------------------------------------------------------- select phase */
function SelectPhase({ state, xi, formation, mentality, preview, suspended, busy, onToggle, onFormation, onMentality, onAuto, onKickOff }: any) {
  const names = state.team_names;
  const nf = state.next_fixture;
  return (
    <>
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-gold">{nf?.stage}</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
              vs <span className="text-2xl">{flag(nf?.opponent || "")}</span> {names[nf?.opponent || ""]}
            </div>
          </div>
          {preview && (
            <div className="flex gap-2 text-center text-xs">
              {[["Win", preview.win, "text-emerald-400"], ["Draw", preview.draw, "text-white/60"], ["Lose", preview.lose, "text-red-400"]].map(([l, v, c]) => (
                <div key={l as string} className="rounded-lg bg-ink/60 px-3 py-1">
                  <div className={`font-display text-lg ${c}`}>{((v as number) * 100).toFixed(0)}%</div>
                  <div className="text-[9px] text-white/40">{l}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {preview && (
          <div className="mt-2 text-xs text-white/40">⭐ {preview.your_key} <span className="text-white/25">vs</span> {preview.opp_key}</div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-white/50">Mentality:</span>
          {MENTALITIES.map((m) => (
            <button key={m.key} onClick={() => onMentality(m.key)}
              className={`rounded-lg px-3 py-1 text-sm font-semibold ${mentality === m.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
              {m.icon} {m.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <span className={`text-sm ${xi.length === 11 ? "text-gold" : "text-white/40"}`}>{xi.length}/11</span>
            <button onClick={onAuto} className="btn-ghost text-sm">Auto</button>
            <button onClick={onKickOff} disabled={xi.length !== 11 || busy} className="btn-primary">
              {busy ? "…" : "▶ Kick off"}
            </button>
          </div>
        </div>
        {suspended.size > 0 && (
          <div className="mt-2 text-xs text-red-300">🚫 {state.squad.filter((p: any) => p.suspended).map((p: any) => p.name).join(", ")}</div>
        )}
      </div>
      <LineupPicker squad={state.squad as unknown as Player[]} selected={xi} formation={formation} onToggle={onToggle} onFormation={onFormation} unavailable={suspended} />
    </>
  );
}

/* ------------------------------------------------------------- live segment */
function SegmentMatch({ events, home, away, names, start, end, onDone }: {
  events: MatchEvent[]; home: string; away: string; names: Record<string, string>; start: number; end: number; onDone: () => void;
}) {
  const [clock, setClock] = useState(start);
  const seen = useRef(0);
  const done = useRef(false);
  useEffect(() => {
    const t0 = performance.now();
    const dur = 4500;
    let raf = 0;
    const tick = (now: number) => {
      const f = Math.min(1, (now - t0) / dur);
      setClock(Math.round(start + f * (end - start)));
      if (f < 1) raf = requestAnimationFrame(tick);
      else if (!done.current) { done.current = true; setTimeout(onDone, 700); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line

  const shown = events.filter((e) => e.minute <= clock);
  const goals = shown.filter((e) => e.type !== "red");
  const hg = goals.filter((e) => e.team === home).length;
  const ag = goals.filter((e) => e.team === away).length;
  useEffect(() => {
    if (shown.length > seen.current) {
      const l = shown[shown.length - 1];
      if (l?.type === "red") sound.red(); else sound.goal();
    }
    seen.current = shown.length;
  }, [shown.length]);

  return (
    <div className="card relative overflow-hidden p-6">
      <div className="absolute right-4 top-3 flex items-center gap-1 text-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="font-mono tabular-nums text-white/70">{clock}'</span>
      </div>
      <div className="grid grid-cols-3 items-center gap-2">
        <div className="text-center"><div className="text-5xl">{flag(home)}</div><div className="mt-1 font-semibold">{names[home] || home}</div></div>
        <motion.div key={`${hg}-${ag}`} initial={{ scale: 1.3 }} animate={{ scale: 1 }} className="text-center font-display text-6xl tabular-nums">{hg}:{ag}</motion.div>
        <div className="text-center"><div className="text-5xl">{flag(away)}</div><div className="mt-1 font-semibold">{names[away] || away}</div></div>
      </div>
      <div className="mt-5 min-h-[50px] space-y-1">
        <AnimatePresence>
          {shown.map((e, i) => (
            <motion.div key={`${e.minute}-${i}`} initial={{ opacity: 0, x: e.team === home ? -20 : 20 }} animate={{ opacity: 1, x: 0 }}
              className={`flex items-center gap-2 text-sm ${e.team === away ? "flex-row-reverse text-right" : ""}`}>
              <span className="text-white/40">{e.minute}'</span><span>{e.type === "red" ? "🟥" : "⚽"}</span>
              <span className="font-medium">{e.scorer}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function HalfTime({ state, secondMentality, setSecondMentality, onResume, busy }: any) {
  const ht = state.half_time;
  const names = state.team_names;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="card p-6 text-center">
      <div className="text-xs uppercase tracking-[0.3em] text-gold">Half-time</div>
      <div className="mt-2 flex items-center justify-center gap-3 font-display text-4xl">
        <span>{flag(ht.home)}</span>{ht.home_goals}<span className="text-white/30">:</span>{ht.away_goals}<span>{flag(ht.away)}</span>
      </div>
      <div className="mt-1 text-sm text-white/50">{names[ht.home]} vs {names[ht.away]}</div>
      <div className="mt-5 text-sm text-white/60">Change your approach for the second half?</div>
      <div className="mt-2 flex justify-center gap-2">
        {MENTALITIES.map((m) => (
          <button key={m.key} onClick={() => setSecondMentality(m.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${secondMentality === m.key ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
            {m.icon} {m.label}
          </button>
        ))}
      </div>
      <button onClick={onResume} disabled={busy} className="btn-primary mt-5">{busy ? "…" : "▶ Second half"}</button>
    </motion.div>
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
        <div className="mt-5">
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
      <Journey matches={state.journey} names={names} team={team} title="YOUR RUN" />
    </div>
  );
}
function roundName(r: string): string {
  return { groups: "group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", F: "Final" }[r] || r;
}
