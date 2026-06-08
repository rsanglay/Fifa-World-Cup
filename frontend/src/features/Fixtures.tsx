import { useEffect, useMemo, useState } from "react";
import { api, flag } from "../api/client";
import type { Fixture, Team } from "../types";

export default function Fixtures() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teams, setTeams] = useState<Record<string, Team>>({});
  const [groupFilter, setGroupFilter] = useState<string>("ALL");

  useEffect(() => {
    api.fixtures().then((d) => setFixtures(d.group_stage)).catch(() => {});
    api.teams().then((ts) => {
      const map: Record<string, Team> = {};
      ts.forEach((t) => (map[t.code] = t));
      setTeams(map);
    });
  }, []);

  const filtered = useMemo(
    () =>
      fixtures.filter((f) => groupFilter === "ALL" || f.group === groupFilter),
    [fixtures, groupFilter]
  );

  const byDate = useMemo(() => {
    const m: Record<string, Fixture[]> = {};
    filtered.forEach((f) => {
      (m[f.date] ||= []).push(f);
    });
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const name = (c?: string) => (c && teams[c]?.name) || c || "TBD";

  const RestBadge = ({ rest }: { rest?: number | null }) => {
    if (rest == null) return <span className="text-white/30">1st game</span>;
    const short = rest <= 3;
    return (
      <span
        className={`rounded px-1.5 py-0.5 ${
          short ? "bg-red-500/20 text-red-300" : "bg-white/5 text-white/50"
        }`}
        title={short ? "Short turnaround — fatigue penalty in the model" : "Rest before this match"}
      >
        🛌 {rest}d rest{short ? " ⚠" : ""}
      </span>
    );
  };

  return (
    <div>
      <h1 className="mb-1 font-display text-4xl tracking-wide">FIXTURES</h1>
      <p className="mb-1 text-white/60">All 72 group-stage matches with real dates and venues.</p>
      <p className="mb-4 text-xs text-white/40">
        🛌 shows each team's rest before kick-off. A short turnaround (≤3 days, ⚠) costs
        a small fatigue penalty in the prediction model.
      </p>

      <div className="mb-5 flex flex-wrap gap-1">
        {["ALL", ..."ABCDEFGHIJKL".split("")].map((g) => (
          <button
            key={g}
            onClick={() => setGroupFilter(g)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              groupFilter === g ? "bg-gold text-ink" : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            {g === "ALL" ? "All" : `Group ${g}`}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {byDate.map(([date, list]) => (
          <div key={date}>
            <div className="mb-2 text-sm font-semibold text-gold">
              {new Date(date).toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {list.map((f) => (
                <div key={f.match_no} className="card p-3">
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-center text-xs text-white/40">{f.match_no}</span>
                    <div className="flex flex-1 items-center justify-end gap-2 text-right">
                      <span className="font-medium">{name(f.home)}</span>
                      <span className="text-2xl">{flag(f.home || "")}</span>
                    </div>
                    <span className="rounded bg-ink px-2 py-1 text-xs text-white/50">v</span>
                    <div className="flex flex-1 items-center gap-2">
                      <span className="text-2xl">{flag(f.away || "")}</span>
                      <span className="font-medium">{name(f.away)}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2 text-[11px] text-white/40">
                    <RestBadge rest={f.home_rest} />
                    <span>Grp {f.group} · {f.city}</span>
                    <RestBadge rest={f.away_rest} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {byDate.length === 0 && <div className="skel h-40" />}
      </div>
    </div>
  );
}
