import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { api, flag } from "../api/client";
import LineupPicker from "../components/LineupPicker";
import PlayerPhoto from "../components/PlayerPhoto";
import Confetti from "../components/Confetti";
import ShareButton from "../components/ShareButton";
import { sound } from "../lib/sound";
import type { ManagedMatch, ManagedSquadPlayer, ManagedState, Player } from "../types";

const FORMATIONS: Record<string, [number, number, number]> = {
  "4-3-3": [4, 3, 3], "4-4-2": [4, 4, 2], "4-2-3-1": [4, 5, 1],
  "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "5-3-2": [5, 3, 2],
};

function pickXI(squad: ManagedSquadPlayer[], formation: string): string[] {
  const [d, m, f] = FORMATIONS[formation];
  const need: Record<string, number> = { GK: 1, DEF: d, MID: m, FWD: f };
  const avail = squad.filter((p) => !p.suspended);
  const out: string[] = [];
  (["GK", "DEF", "MID", "FWD"] as const).forEach((pos) => {
    out.push(
      ...avail.filter((p) => p.position === pos).sort((a, b) => b.rating - a.rating)
        .slice(0, need[pos]).map((p) => p.id)
    );
  });
  return out;
}

export default function CareerMode({ team, onExit }: { team: string; onExit: () => void }) {
  const [sid, setSid] = useState<string>("");
  const [state, setState] = useState<ManagedState | null>(null);
  const [xi, setXi] = useState<string[]>([]);
  const [formation, setFormation] = useState("4-3-3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.manageStart(team).then((r) => {
      setSid(r.session_id);
      setState(r.state);
      setXi(pickXI(r.state.squad, "4-3-3"));
    }).catch((e) => setError(String(e?.message || e)));
  }, [team]);

  const suspended = useMemo(
    () => new Set((state?.squad || []).filter((p) => p.suspended).map((p) => p.id)),
    [state]
  );

  // Drop any now-suspended players from the selected XI.
  useEffect(() => {
    if (xi.some((id) => suspended.has(id))) setXi((cur) => cur.filter((id) => !suspended.has(id)));
  }, [suspended]); // eslint-disable-line

  const play = () => {
    if (!state || xi.length !== 11) return;
    setBusy(true);
    api.managePlay(sid, xi).then((r) => {
      setState(r.state);
      if (r.state.won) sound.fanfare();
      else if (r.state.last_round.some((m) => mineWon(m, team))) sound.goal();
      setBusy(false);
    }).catch((e) => { setError(String(e?.message || e)); setBusy(false); });
  };

  if (error) return <div className="card p-6 text-center text-red-300">{error} <button onClick={onExit} className="btn-ghost ml-2">Back</button></div>;
  if (!state) return <div className="skel h-64" />;

  const names = state.team_names;
  const squadAsPlayers = state.squad as unknown as Player[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onExit} className="btn-ghost text-sm">← Exit career</button>
        <span className="text-3xl">{flag(team)}</span>
        <div>
          <div className="font-display text-2xl">{state.team_name}</div>
          <div className="text-xs text-white/50">Group {state.group} · round-by-round</div>
        </div>
      </div>

      {state.done ? (
        <DoneScreen state={state} team={team} onExit={onExit} />
      ) : (
        <>
          {state.last_round.length > 0 && (
            <RoundResults matches={state.last_round} names={names} team={team} />
          )}

          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-gold">{state.next_fixture?.stage}</div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  vs <span className="text-2xl">{flag(state.next_fixture?.opponent || "")}</span>
                  {names[state.next_fixture?.opponent || ""]}
                </div>
                <div className="text-xs text-white/40">
                  {state.next_fixture?.date} · {state.next_fixture?.venue}, {state.next_fixture?.city}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-sm ${xi.length === 11 ? "text-gold" : "text-white/40"}`}>{xi.length}/11 picked</span>
                <button onClick={() => setXi(pickXI(state.squad, formation))} className="btn-ghost text-sm">Auto-pick</button>
                <button onClick={play} disabled={xi.length !== 11 || busy} className="btn-primary">
                  {busy ? "Playing…" : `▶ Play ${state.phase === "group" ? "match" : "tie"}`}
                </button>
              </div>
            </div>
            {suspended.size > 0 && (
              <div className="mt-2 text-xs text-red-300">
                🚫 Suspended: {state.squad.filter((p) => p.suspended).map((p) => p.name).join(", ")}
              </div>
            )}
          </div>

          <LineupPicker
            squad={squadAsPlayers}
            selected={xi}
            formation={formation}
            onToggle={(id) => setXi((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])}
            onFormation={(f) => { setFormation(f); setXi(pickXI(state.squad, f)); }}
            unavailable={suspended}
          />

          <GroupMini state={state} names={names} team={team} />
          {state.journey.length > 0 && <Journey matches={state.journey} names={names} team={team} />}
        </>
      )}
    </div>
  );
}

function mineWon(m: ManagedMatch, team: string) {
  const us = m.home === team ? m.home_goals : m.away_goals;
  const them = m.home === team ? m.away_goals : m.home_goals;
  return m.winner === team || us > them;
}

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
      {m.penalties && <span className="text-[10px] text-gold">pens {m.home_pens}-{m.away_pens}</span>}
    </div>
  );
}

function RoundResults({ matches, names, team }: { matches: ManagedMatch[]; names: Record<string, string>; team: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="card p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gold">Latest results</div>
      <div className="grid gap-1.5 md:grid-cols-2">
        {matches.map((m, i) => <ScoreRow key={i} m={m} names={names} team={team} />)}
      </div>
    </motion.div>
  );
}

function GroupMini({ state, names, team }: { state: ManagedState; names: Record<string, string>; team: string }) {
  return (
    <div className="card p-3">
      <div className="mb-1 font-display text-lg text-gold">GROUP {state.group}</div>
      <table className="w-full text-sm">
        <tbody>
          {state.group_table.map((r, i) => (
            <tr key={r.code} className={`${r.code === team ? "text-gold" : i < 2 ? "text-white" : "text-white/50"}`}>
              <td className="py-1">{flag(r.code)} {names[r.code] || r.code}</td>
              <td className="text-center text-white/40">{r.played}</td>
              <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
              <td className="text-center font-bold">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Journey({ matches, names, team }: { matches: ManagedMatch[]; names: Record<string, string>; team: string }) {
  return (
    <div>
      <h3 className="mb-2 font-display text-xl tracking-wide">YOUR RUN</h3>
      <div className="grid gap-1.5 md:grid-cols-2">
        {matches.map((m, i) => <ScoreRow key={i} m={m} names={names} team={team} />)}
      </div>
    </div>
  );
}

function DoneScreen({ state, team, onExit }: { state: ManagedState; team: string; onExit: () => void }) {
  const won = state.won;
  const names = state.team_names;
  const verdict = won ? "🏆 WORLD CHAMPIONS!"
    : state.eliminated_round === "groups" ? "Out in the group stage"
    : `Knocked out in the ${roundName(state.eliminated_round || "")}`;
  return (
    <div className="space-y-4">
      {won && <Confetti />}
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className={`card p-8 text-center ${won ? "ring-2 ring-gold" : ""}`}>
        <div className="text-6xl">{flag(team)}</div>
        <div className="mt-2 font-display text-4xl tracking-wide">{state.team_name}</div>
        <div className={`mt-2 text-2xl font-bold ${won ? "text-gold" : "text-white/80"}`}>{verdict}</div>
        {!won && state.champion && <div className="mt-2 text-sm text-white/50">Winners: {state.champion_name}</div>}
        <div className="mt-5">
          <ShareButton info={{
            headline: `MANAGED ${state.team_name.toUpperCase()} · CAREER`,
            championCode: won ? team : (state.champion || team),
            championName: won ? state.team_name : (state.champion_name || ""),
            lines: [verdict.replace(/^[^A-Za-z]+/, "")],
            url: window.location.origin + "/simulator",
            shareText: won ? `🏆 I managed ${state.team_name} to World Cup glory, match by match!`
              : `I managed ${state.team_name} through the World Cup — ${verdict.replace(/^[^A-Za-z]+/, "").toLowerCase()}.`,
          }} />
        </div>
        <button onClick={onExit} className="btn-ghost mt-3 text-sm">← New career</button>
      </motion.div>
      <Journey matches={state.journey} names={names} team={team} />
    </div>
  );
}

function roundName(r: string): string {
  return { groups: "group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", F: "Final" }[r] || r;
}
