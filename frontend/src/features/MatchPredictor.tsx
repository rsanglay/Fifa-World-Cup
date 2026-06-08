import { useEffect, useState } from "react";
import { api, flag } from "../api/client";
import type { MatchPrediction, Team } from "../types";

export default function MatchPredictor() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [home, setHome] = useState("ARG");
  const [away, setAway] = useState("FRA");
  const [pred, setPred] = useState<MatchPrediction | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.teams().then(setTeams);
  }, []);

  const run = () => {
    if (home === away) return;
    setLoading(true);
    api.predictMatch(home, away).then((p) => {
      setPred(p);
      setLoading(false);
    });
  };

  const Select = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl bg-ink-card px-3 py-3 text-lg font-semibold outline-none ring-1 ring-white/10 focus:ring-gold"
    >
      {teams.map((t) => (
        <option key={t.code} value={t.code}>
          {t.name}
        </option>
      ))}
    </select>
  );

  const bars = pred
    ? [
        { label: pred.home_name, val: pred.home_win, color: "from-pitch to-emerald-400" },
        { label: "Draw", val: pred.draw, color: "from-slate-500 to-slate-300" },
        { label: pred.away_name, val: pred.away_win, color: "from-indigo-500 to-sky-400" },
      ]
    : [];

  return (
    <div>
      <h1 className="mb-1 font-display text-4xl tracking-wide">MATCH PREDICTOR</h1>
      <p className="mb-6 text-white/60">Neutral-venue win / draw / loss probabilities and the most likely scoreline.</p>

      <div className="card p-6">
        <div className="grid items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
          <div className="text-center">
            <div className="mb-2 text-6xl">{flag(home)}</div>
            <Select value={home} onChange={setHome} />
          </div>
          <div className="text-center font-display text-3xl text-white/40">VS</div>
          <div className="text-center">
            <div className="mb-2 text-6xl">{flag(away)}</div>
            <Select value={away} onChange={setAway} />
          </div>
        </div>
        <div className="mt-6 text-center">
          <button onClick={run} disabled={home === away || loading} className="btn-primary px-8">
            {loading ? "Predicting…" : "Predict"}
          </button>
          {home === away && <p className="mt-2 text-sm text-red-400">Pick two different teams.</p>}
        </div>
      </div>

      {pred && (
        <div className="card mt-6 animate-pop-in p-6">
          <div className="mb-4 flex items-center justify-center gap-4">
            <span className="font-display text-2xl">{pred.home_name}</span>
            <span className="rounded-lg bg-gold px-4 py-1 font-display text-3xl text-ink">
              {pred.most_likely_score}
            </span>
            <span className="font-display text-2xl">{pred.away_name}</span>
          </div>
          <p className="mb-5 text-center text-sm text-white/50">
            Expected goals — {pred.home_name}: {pred.expected_goals_home} ·{" "}
            {pred.away_name}: {pred.expected_goals_away}
          </p>
          <div className="space-y-3">
            {bars.map((b) => (
              <div key={b.label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{b.label}</span>
                  <span className="font-semibold tabular-nums">{(b.val * 100).toFixed(1)}%</span>
                </div>
                <div className="h-4 overflow-hidden rounded-full bg-ink">
                  <div
                    className={`h-full rounded-full bg-gradient-to-r ${b.color} transition-all duration-700`}
                    style={{ width: `${b.val * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
