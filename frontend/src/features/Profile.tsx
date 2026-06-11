import { useState } from "react";
import { Link } from "react-router-dom";
import { flag } from "../api/client";
import { careerStore } from "../lib/careerStore";
import { profileStore } from "../lib/profileStore";

/* Manager profile: one identity across careers and multiplayer rooms —
   stats, trophy cabinet, and the badge wall (earned + locked). */
export default function Profile() {
  const [profile, setProfile] = useState(profileStore.get());
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const history = careerStore.getHistory();
  const earned = new Set(profile.badges.map((b) => b.id));
  const locked = profileStore.allBadges().filter((b) => !earned.has(b.id));

  const saveName = () => {
    profileStore.setName(name.trim() || "Manager");
    setProfile(profileStore.get());
    setEditing(false);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* identity + stats */}
      <div className="card flex flex-wrap items-center gap-4 p-5">
        <span className="text-5xl">🧑‍💼</span>
        <div className="flex-1">
          {editing ? (
            <span className="flex items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24}
                className="rounded-lg bg-ink/60 px-3 py-1.5 outline-none ring-1 ring-white/10 focus:ring-gold" />
              <button onClick={saveName} className="btn-primary text-sm">Save</button>
            </span>
          ) : (
            <div className="font-display text-2xl tracking-wide">
              {profile.name || "Unnamed Manager"}
              <button onClick={() => setEditing(true)} className="ml-2 text-xs text-white/40 underline">edit</button>
            </div>
          )}
          <div className="text-xs text-white/50">The dugout record follows you across every mode.</div>
        </div>
        <div className="flex gap-4 text-center">
          {([
            ["Careers", profile.careers],
            ["MP cups", profile.mpTournaments],
            ["Titles", profile.titles],
            ["Grudge Ws", profile.grudgeWins],
          ] as const).map(([l, v]) => (
            <div key={l}>
              <div className="font-display text-2xl text-gold">{v}</div>
              <div className="text-[9px] uppercase text-white/40">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* badges */}
      <div className="card p-5">
        <h3 className="mb-3 font-display text-lg tracking-wide">🎖 BADGES — {profile.badges.length}/{profileStore.allBadges().length}</h3>
        {profile.badges.length === 0 && (
          <div className="mb-3 text-sm text-white/50">
            Nothing earned yet — go win something. <Link to="/simulator" className="text-gold underline">Start a career</Link> or
            {" "}<Link to="/multiplayer" className="text-gold underline">beat a friend</Link>.
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {profile.badges.map((b) => (
            <div key={b.id} className="rounded-lg bg-gold/10 p-3 ring-1 ring-gold/40">
              <div className="text-2xl">{b.icon}</div>
              <div className="mt-1 text-sm font-bold">{b.label}</div>
              <div className="text-[11px] text-white/50">{b.detail || b.hint}</div>
              <div className="mt-1 text-[10px] text-white/30">{b.earnedAt}</div>
            </div>
          ))}
          {locked.map((b) => (
            <div key={b.id} className="rounded-lg bg-ink/40 p-3 opacity-50">
              <div className="text-2xl grayscale">{b.icon}</div>
              <div className="mt-1 text-sm font-bold">{b.label}</div>
              <div className="text-[11px] text-white/50">{b.hint}</div>
              <div className="mt-1 text-[10px] text-white/30">🔒 locked</div>
            </div>
          ))}
        </div>
      </div>

      {/* career history (trophy cabinet) */}
      {history.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-3 font-display text-lg tracking-wide">🏛 CAREER HISTORY</h3>
          <div className="space-y-1.5">
            {history.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${r.won ? "bg-gold/10 ring-1 ring-gold/40" : "bg-ink/40"}`}>
                <span className="text-2xl">{flag(r.team)}</span>
                <span className="flex-1 text-sm font-semibold">{r.teamName}</span>
                <span className={`text-sm ${r.won ? "text-gold font-bold" : "text-white/60"}`}>
                  {r.won ? "🏆 " : ""}{r.outcome}
                </span>
                {r.avgRating != null && <span className="text-xs text-white/40">avg {r.avgRating}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
