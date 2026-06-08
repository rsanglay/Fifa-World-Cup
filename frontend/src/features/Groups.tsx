import { api, flag } from "../api/client";
import { useFetch } from "../hooks/useFetch";
import ErrorBox from "../components/ErrorBox";
import type { Team } from "../types";

export default function Groups() {
  const { data: groups, loading, error, reload } = useFetch(() => api.groups(), []);

  return (
    <div>
      <h1 className="mb-1 font-display text-4xl tracking-wide">THE GROUPS</h1>
      <p className="mb-6 text-white/60">
        12 groups of 4. Top two of each group plus the eight best third-placed
        teams advance to the Round of 32.
      </p>

      {error && <ErrorBox message={error} onRetry={reload} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loading &&
          Array(12).fill(0).map((_, i) => <div key={i} className="skel h-56" />)}
        {groups &&
          Object.entries(groups).map(([g, teams]: [string, Team[]]) => (
            <div key={g} className="card animate-pop-in p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-display text-2xl text-gold">GROUP {g}</span>
              </div>
              <ul className="space-y-2">
                {teams.map((t) => (
                  <li key={t.code} className="flex items-center gap-3 rounded-lg bg-ink/50 px-3 py-2">
                    <span className="text-2xl">{flag(t.code)}</span>
                    <span className="flex-1 font-medium">{t.name}</span>
                    <span className="text-xs text-white/40">#{t.fifa_ranking}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}
