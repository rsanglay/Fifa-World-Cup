import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, flag } from "../api/client";
import type { OddsRow } from "../types";

function useCountdown(target: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, new Date(target).getTime() - now);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return { days, hours, mins, secs };
}

export default function Home() {
  const [odds, setOdds] = useState<OddsRow[]>([]);
  const cd = useCountdown("2026-06-11T20:00:00-05:00");

  useEffect(() => {
    api.odds(3000).then((d) => setOdds(d.teams.slice(0, 6))).catch(() => {});
  }, []);

  return (
    <div className="space-y-8">
      <section className="card relative overflow-hidden p-8">
        <div className="absolute inset-0 -z-0 bg-gradient-to-br from-pitch/30 to-transparent" />
        <div className="relative z-10">
          <p className="font-display text-5xl tracking-wide md:text-7xl">
            THE WORLD CUP, <span className="text-gold">SIMULATED.</span>
          </p>
          <p className="mt-3 max-w-2xl text-white/70">
            Predict every match, run the whole tournament thousands of times, or
            take charge of a nation — pick your starting XI and chase the trophy.
            48 teams. 104 matches. One model.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/simulator" className="btn-primary">
              ▶ Launch Simulator
            </Link>
            <Link to="/odds" className="btn-ghost">
              View Title Odds
            </Link>
          </div>

          <div className="mt-8 flex gap-3">
            {[
              ["DAYS", cd.days],
              ["HRS", cd.hours],
              ["MIN", cd.mins],
              ["SEC", cd.secs],
            ].map(([label, val]) => (
              <div key={label as string} className="rounded-xl bg-ink/70 px-4 py-2 text-center">
                <div className="font-display text-3xl text-gold">
                  {String(val).padStart(2, "0")}
                </div>
                <div className="text-[10px] tracking-widest text-white/50">{label}</div>
              </div>
            ))}
            <div className="self-center text-sm text-white/50">
              until kick-off at Estadio Azteca
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-display text-2xl tracking-wide">FAVOURITES</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {(odds.length ? odds : Array(6).fill(null)).map((t, i) =>
            t ? (
              <div key={t.code} className="card animate-pop-in p-4 text-center">
                <div className="text-4xl">{flag(t.code)}</div>
                <div className="mt-1 font-semibold">{t.name}</div>
                <div className="mt-1 font-display text-3xl text-gold">
                  {(t.p_title * 100).toFixed(1)}%
                </div>
                <div className="text-[11px] text-white/50">to win it all</div>
              </div>
            ) : (
              <div key={i} className="skel h-36" />
            )
          )}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["⚽", "Match Predictor", "Win / draw / loss + most-likely scoreline for any two teams.", "/predict"],
          ["📊", "Title Odds", "Monte-Carlo odds to reach each round and lift the cup.", "/odds"],
          ["🎮", "Manage a Nation", "Pick your XI and bench, then live your tournament out.", "/simulator"],
        ].map(([icon, title, desc, to]) => (
          <Link to={to as string} key={title as string} className="card p-5 transition hover:border-gold/40">
            <div className="text-3xl">{icon}</div>
            <div className="mt-2 text-lg font-semibold">{title}</div>
            <div className="mt-1 text-sm text-white/60">{desc}</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
