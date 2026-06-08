import { flag } from "../api/client";
import type { AwardRow, Awards as AwardsT } from "../types";
import PlayerPhoto from "./PlayerPhoto";

function AwardCard({
  title,
  icon,
  rows,
  stat,
  unit,
}: {
  title: string;
  icon: string;
  rows: AwardRow[];
  stat: (r: AwardRow) => number | string;
  unit?: string;
}) {
  const leader = rows[0];
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/5 bg-ink/40 px-4 py-2">
        <span className="text-xl">{icon}</span>
        <span className="font-display text-lg tracking-wide">{title}</span>
      </div>
      {leader && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-gold/15 to-transparent p-4">
          <PlayerPhoto name={leader.name} photoUrl={leader.photo_url} position={leader.position} size={56} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{leader.name}</div>
            <div className="text-xs text-white/50">
              {flag(leader.team)} {leader.team_name}
            </div>
          </div>
          <div className="text-right">
            <div className="font-display text-3xl text-gold">{stat(leader)}</div>
            {unit && <div className="text-[10px] text-white/40">{unit}</div>}
          </div>
        </div>
      )}
      <div className="divide-y divide-white/5">
        {rows.slice(1, 5).map((r, i) => (
          <div key={r.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
            <span className="w-4 text-center text-xs text-white/30">{i + 2}</span>
            <PlayerPhoto name={r.name} photoUrl={r.photo_url} position={r.position} size={26} />
            <span className="flex-1 truncate text-white/80">{r.name}</span>
            <span className="text-xs text-white/40">{flag(r.team)}</span>
            <span className="w-8 text-right font-semibold tabular-nums">{stat(r)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Awards({ awards }: { awards: AwardsT }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <AwardCard
        title="Golden Boot"
        icon="👟"
        rows={awards.golden_boot}
        stat={(r) => r.goals}
        unit="goals"
      />
      <AwardCard
        title="Golden Ball"
        icon="🏅"
        rows={awards.golden_ball}
        stat={(r) => `${r.goals}G ${r.assists}A`}
        unit="best player"
      />
      <AwardCard
        title="Golden Glove"
        icon="🧤"
        rows={awards.clean_sheets}
        stat={(r) => r.clean_sheets}
        unit="clean sheets"
      />
      <AwardCard
        title="Most Assists"
        icon="🅰️"
        rows={awards.top_assists}
        stat={(r) => r.assists}
        unit="assists"
      />
      <AwardCard
        title="Chances Created"
        icon="🎯"
        rows={awards.chances_created}
        stat={(r) => r.chances}
        unit="chances"
      />
      <AwardCard
        title="Most Saves"
        icon="✋"
        rows={awards.most_saves}
        stat={(r) => r.saves}
        unit="saves"
      />
      {awards.young_player.length > 0 && (
        <AwardCard
          title="Young Player"
          icon="⭐"
          rows={awards.young_player}
          stat={(r) => `${r.goals}G ${r.assists}A`}
          unit="U21"
        />
      )}
    </div>
  );
}
