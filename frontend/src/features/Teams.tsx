import { useEffect, useMemo, useState } from "react";
import { api, flag } from "../api/client";
import PlayerPhoto from "../components/PlayerPhoto";
import ErrorBox from "../components/ErrorBox";
import type { Player, Team, TeamDetail } from "../types";

const POS_ORDER = ["GK", "DEF", "MID", "FWD"] as const;
const POS_LABEL: Record<string, string> = {
  GK: "Goalkeepers", DEF: "Defenders", MID: "Midfielders", FWD: "Forwards",
};
const TIER_BADGE: Record<string, string> = {
  star: "⭐ Star", starter: "Starter", rotation: "Squad", fringe: "Depth",
};

export default function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [code, setCode] = useState<string>("");
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [selected, setSelected] = useState<Player | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = () => {
    setError(null);
    api.teams().then(setTeams).catch((e) => setError(String(e?.message || e)));
  };
  useEffect(loadTeams, []);

  useEffect(() => {
    if (!code) return;
    setDetail(null);
    api.team(code).then(setDetail);
  }, [code]);

  if (code && detail !== undefined) {
    return (
      <TeamSquad
        teams={teams}
        code={code}
        detail={detail}
        onBack={() => setCode("")}
        onPick={setCode}
        selected={selected}
        setSelected={setSelected}
      />
    );
  }

  return (
    <div>
      <h1 className="mb-1 font-display text-4xl tracking-wide">TEAMS</h1>
      <p className="mb-6 text-white/60">
        All 48 nations. Tap a team to see its 26-player squad with photos and stats.
      </p>
      {error && <ErrorBox message={error} onRetry={loadTeams} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {(teams.length ? teams : Array(24).fill(null)).map((t, i) =>
          t ? (
            <button
              key={t.code}
              onClick={() => setCode(t.code)}
              className="card flex flex-col items-center p-4 transition hover:border-gold/50 hover:bg-white/5"
            >
              <span className="text-5xl">{flag(t.code)}</span>
              <span className="mt-2 font-semibold">{t.name}</span>
              <span className="mt-1 text-[11px] text-white/40">
                #{t.fifa_ranking} · Grp {t.group}
              </span>
              {t.titles > 0 && (
                <span className="mt-1 text-[11px] text-gold">
                  {"★".repeat(t.titles)} {t.titles}× champion
                </span>
              )}
            </button>
          ) : (
            <div key={i} className="skel h-36" />
          )
        )}
      </div>
    </div>
  );
}

function TeamSquad({
  teams, code, detail, onBack, onPick, selected, setSelected,
}: {
  teams: Team[];
  code: string;
  detail: TeamDetail | null;
  onBack: () => void;
  onPick: (c: string) => void;
  selected: Player | null;
  setSelected: (p: Player | null) => void;
}) {
  const squadValue = useMemo(
    () => (detail ? detail.squad.reduce((s, p) => s + (p.market_value || 0), 0) : 0),
    [detail]
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="btn-ghost text-sm">← All teams</button>
        <select
          value={code}
          onChange={(e) => onPick(e.target.value)}
          className="rounded-xl bg-ink-card px-3 py-2 font-semibold outline-none ring-1 ring-white/10 focus:ring-gold"
        >
          {teams.map((t) => (
            <option key={t.code} value={t.code}>{t.name}</option>
          ))}
        </select>
      </div>

      {!detail && <div className="skel h-64" />}

      {detail && (
        <>
          <div className="card mb-5 flex flex-wrap items-center gap-4 p-5">
            <span className="text-6xl">{flag(detail.code)}</span>
            <div className="flex-1">
              <div className="font-display text-4xl tracking-wide">{detail.name}</div>
              <div className="text-sm text-white/50">
                {detail.confederation} · Group {detail.group} · FIFA #{detail.fifa_ranking}
                {detail.titles > 0 && ` · ${detail.titles}× World Champion`}
              </div>
            </div>
            <div className="flex gap-5 text-center">
              <Stat label="Squad value" value={`€${squadValue.toFixed(0)}M`} />
              <Stat label="Players" value={String(detail.squad.length)} />
              <Stat label="Elo" value={String(Math.round(detail.elo))} />
            </div>
          </div>

          {POS_ORDER.map((pos) => {
            const players = detail.squad
              .filter((p) => p.position === pos)
              .sort((a, b) => b.rating - a.rating);
            if (!players.length) return null;
            return (
              <div key={pos} className="mb-5">
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gold">
                  {POS_LABEL[pos]} <span className="text-white/30">({players.length})</span>
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {players.map((p) => (
                    <PlayerCard key={p.id} player={p} onClick={() => setSelected(p)} />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {selected && (
        <PlayerModal player={selected} teamName={detail?.name || ""} teamCode={code} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-display text-2xl text-gold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
    </div>
  );
}

function PlayerCard({ player: p, onClick }: { player: Player; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="card flex items-center gap-3 p-3 text-left transition hover:border-gold/40 hover:bg-white/5"
    >
      <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={54} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {p.number ? <span className="text-[10px] text-white/40">#{p.number}</span> : null}
          <span className="truncate font-semibold">{p.name}</span>
          {p.tier === "star" && <span className="text-xs">⭐</span>}
        </div>
        <div className="truncate text-[11px] text-white/40">{p.club}</div>
        <div className="mt-0.5 flex gap-2 text-[11px] text-white/50">
          {p.age ? <span>{p.age}y</span> : null}
          {p.caps != null ? <span>{p.caps} caps</span> : null}
          {p.position !== "GK" && <span>{p.goals}G {p.assists}A</span>}
        </div>
      </div>
      <div className="text-center">
        <div className="rounded-lg bg-ink px-2 py-1 font-display text-xl text-gold">{p.rating}</div>
        <div className="mt-1 text-[10px] text-white/40">€{p.market_value}M</div>
      </div>
    </button>
  );
}

function PlayerModal({
  player: p, teamName, teamCode, onClose,
}: {
  player: Player; teamName: string; teamCode: string; onClose: () => void;
}) {
  const stats: [string, string | number][] =
    p.position === "GK"
      ? [["Age", `${p.age}`], ["Caps", `${p.caps}`], ["Rating", p.rating], ["Value", `€${p.market_value}M`]]
      : [["Age", `${p.age}`], ["Caps", `${p.caps}`], ["Int'l goals", `${p.goals}`],
         ["Assists", `${p.assists}`], ["Rating", p.rating], ["Value", `€${p.market_value}M`]];
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4">
          <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={88} />
          <div>
            <div className="font-display text-3xl tracking-wide">{p.name}</div>
            <div className="text-sm text-white/50">
              {flag(teamCode)} {teamName} · {p.position} · {p.club}
            </div>
            {p.tier && (
              <span className="mt-1 inline-block rounded bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {TIER_BADGE[p.tier] || p.tier}
              </span>
            )}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          {stats.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-ink/60 p-3 text-center">
              <div className="font-display text-2xl text-gold">{v}</div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">{k}</div>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="btn-ghost mt-5 w-full text-sm">Close</button>
      </div>
    </div>
  );
}
