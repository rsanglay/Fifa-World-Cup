import { flag } from "../api/client";
import type { ScorerRow } from "../types";

/* Golden Boot race table — shared by career mode and multiplayer. */
export default function TopScorers({ rows, highlightTeam, title = "GOLDEN BOOT RACE" }: {
  rows: ScorerRow[];
  highlightTeam?: string | null;
  title?: string;
}) {
  if (!rows?.length) return null;
  return (
    <div className="card p-3">
      <div className="mb-2 font-display text-lg tracking-wide text-gold">👟 {title}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase text-white/40">
            <th className="text-left font-normal">Player</th>
            <th className="w-8 text-center font-normal">⚽</th>
            <th className="w-8 text-center font-normal">🅰️</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.player_id}
              className={r.team === highlightTeam ? "text-gold" : i === 0 ? "text-white" : "text-white/70"}>
              <td className="truncate py-1">
                <span className="mr-1 text-white/30">{i + 1}.</span>
                {flag(r.team)} {r.name}
                <span className="ml-1 text-[10px] text-white/40">{r.position}</span>
              </td>
              <td className="text-center font-bold tabular-nums">{r.goals}</td>
              <td className="text-center tabular-nums text-white/60">{r.assists}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
