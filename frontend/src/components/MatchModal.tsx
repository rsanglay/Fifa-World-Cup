import { flag } from "../api/client";
import type { MatchEvent, MatchLineups, LineupPlayer } from "../types";
import PlayerPhoto from "./PlayerPhoto";

export interface MatchData {
  home: string | null;
  away: string | null;
  home_goals: number | null;
  away_goals: number | null;
  penalties?: boolean;
  home_pens?: number | null;
  away_pens?: number | null;
  extra_time?: boolean;
  round?: string;
  venue?: string;
  city?: string;
  date?: string;
  events?: MatchEvent[];
  lineups?: MatchLineups | null;
}

export default function MatchModal({
  match,
  names,
  onClose,
}: {
  match: MatchData;
  names: Record<string, string>;
  onClose: () => void;
}) {
  const home = match.home || "";
  const away = match.away || "";
  const ev = match.events || [];
  const homeEv = ev.filter((e) => e.team === home);
  const awayEv = ev.filter((e) => e.team === away);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Score header */}
        <div className="grid grid-cols-3 items-center gap-2">
          <div className="text-center">
            <div className="text-5xl">{flag(home)}</div>
            <div className="mt-1 font-semibold">{names[home] || home}</div>
          </div>
          <div className="text-center">
            <div className="font-display text-5xl tabular-nums">
              {match.home_goals ?? 0}<span className="text-white/30">:</span>{match.away_goals ?? 0}
            </div>
            {match.penalties && (
              <div className="mt-1 text-xs text-gold">
                {match.home_pens}–{match.away_pens} on penalties
              </div>
            )}
            {match.extra_time && !match.penalties && (
              <div className="mt-1 text-xs text-white/40">after extra time</div>
            )}
          </div>
          <div className="text-center">
            <div className="text-5xl">{flag(away)}</div>
            <div className="mt-1 font-semibold">{names[away] || away}</div>
          </div>
        </div>

        {(match.venue || match.round) && (
          <div className="mt-2 text-center text-xs text-white/40">
            {match.round && roundName(match.round)} {match.venue ? `· ${match.venue}, ${match.city}` : ""}
          </div>
        )}

        {/* Scorers */}
        {ev.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/5 pt-4">
            <div className="space-y-1 text-right text-sm">
              {homeEv.map((e, i) => (
                <div key={i} className="text-white/80">
                  <span className="text-white/40">{e.minute}'</span> ⚽ {e.scorer}
                  {e.assist && <div className="text-[10px] text-white/30">assist: {e.assist}</div>}
                </div>
              ))}
            </div>
            <div className="space-y-1 text-left text-sm">
              {awayEv.map((e, i) => (
                <div key={i} className="text-white/80">
                  ⚽ {e.scorer} <span className="text-white/40">{e.minute}'</span>
                  {e.assist && <div className="text-[10px] text-white/30">assist: {e.assist}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lineups */}
        {match.lineups && (
          <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/5 pt-4">
            <Lineup title={names[home] || home} players={match.lineups.home} />
            <Lineup title={names[away] || away} players={match.lineups.away} />
          </div>
        )}

        <button onClick={onClose} className="btn-ghost mt-5 w-full text-sm">Close</button>
      </div>
    </div>
  );
}

function Lineup({ title, players }: { title: string; players: LineupPlayer[] }) {
  const order = ["GK", "DEF", "MID", "FWD"];
  const sorted = [...players].sort(
    (a, b) => order.indexOf(a.position) - order.indexOf(b.position)
  );
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gold">{title} XI</div>
      <div className="space-y-1">
        {sorted.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-sm">
            <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={24} />
            <span className="w-5 text-[10px] text-white/30">{p.number || ""}</span>
            <span className="flex-1 truncate">{p.name}</span>
            <span className="text-[10px] text-white/30">{p.position}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function roundName(r: string): string {
  return (
    { R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", "3P": "3rd place", F: "Final" }[r] || r
  );
}
