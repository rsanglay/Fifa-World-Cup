/* Persistent manager profile: one identity across careers and multiplayer
   rooms, with badges earned from outcomes. localStorage-backed. */

import type { ManagedState, MPState } from "../types";

export interface Badge {
  id: string;
  label: string;
  icon: string;
  hint: string;
  earnedAt: string;        // ISO date
  detail?: string;
}

export interface ManagerProfile {
  name: string;
  careers: number;
  mpTournaments: number;
  titles: number;
  grudgeWins: number;
  predPoints: number;
  badges: Badge[];
}

const KEY = "wc26_manager_profile";

const BADGES: Record<string, { label: string; icon: string; hint: string }> = {
  champion:      { label: "World Champion", icon: "🏆", hint: "Win the World Cup in career mode" },
  mp_champion:   { label: "Beat Your Friends", icon: "👑", hint: "Win a multiplayer tournament" },
  underdog:      { label: "Underdog Run", icon: "🐺", hint: "Reach the semis with a nation ranked outside the top 20" },
  perfect_group: { label: "Perfect Groups", icon: "9️⃣", hint: "Win all three group matches" },
  giant_killer:  { label: "Giant Killer", icon: "🗡️", hint: "Beat a top-10 nation" },
  golden_boot:   { label: "Golden Boot Manager", icon: "👟", hint: "Your player tops the scoring chart" },
  grudge_lord:   { label: "Grudge Lord", icon: "🔥", hint: "Beat a friend's team head-to-head" },
  shootout_ice:  { label: "Ice in the Veins", icon: "🧊", hint: "Win a penalty shootout" },
  oracle:        { label: "The Oracle", icon: "🔮", hint: "Score 10+ spectator prediction points in one tournament" },
};

function load(): ManagerProfile {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    if (p) return p;
  } catch { /* fresh */ }
  return { name: "", careers: 0, mpTournaments: 0, titles: 0,
           grudgeWins: 0, predPoints: 0, badges: [] };
}

function save(p: ManagerProfile): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

function award(p: ManagerProfile, id: string, detail?: string): void {
  if (p.badges.some((b) => b.id === id)) return;
  const def = BADGES[id];
  if (!def) return;
  p.badges.push({ id, ...def, earnedAt: new Date().toISOString().slice(0, 10), detail });
}

export const profileStore = {
  get: load,
  allBadges(): { id: string; label: string; icon: string; hint: string }[] {
    return Object.entries(BADGES).map(([id, b]) => ({ id, ...b }));
  },
  setName(name: string): void {
    const p = load();
    p.name = name.slice(0, 24);
    save(p);
  },

  /** Call when a career finishes (state.done). */
  recordCareer(state: ManagedState, team: string): void {
    const p = load();
    p.careers += 1;
    if (state.won) {
      p.titles += 1;
      award(p, "champion", state.team_name);
    }
    const wins = state.journey.filter(
      (m) => m.round === "groups" && m.winner === team).length;
    if (wins >= 3) award(p, "perfect_group", state.team_name);
    // Underdog: a nation only expected to scrape the groups going deep.
    const modest = ["groups", "R16"].includes(state.expectation?.tier || "");
    const deep = state.won || ["SF", "F"].includes(state.eliminated_round || "");
    if (modest && deep) award(p, "underdog", state.team_name);
    if (state.achievements.includes("Beat a top-10 nation")) award(p, "giant_killer");
    if (state.achievements.includes("Won a penalty shootout")) award(p, "shootout_ice");
    const top = state.top_scorers?.[0];
    if (top && top.team === team) award(p, "golden_boot", top.name);
    save(p);
  },

  /** Call when a multiplayer tournament finishes (state.done). */
  recordMultiplayer(state: MPState): void {
    const p = load();
    p.mpTournaments += 1;
    const you = state.players.find((pl) => pl.is_you);
    const team = you?.team;
    if (!team) { save(p); return; }
    if (state.champion === team) {
      p.titles += 1;
      award(p, "mp_champion", state.champion_name || team);
    }
    for (const m of state.h2h) {
      if (m.winner === team) {
        p.grudgeWins += 1;
        award(p, "grudge_lord",
              `beat ${m.winner === m.home ? m.away_manager : m.home_manager}`);
      }
    }
    if ((you?.pred_points ?? 0) >= 10) award(p, "oracle");
    const top = state.top_scorers?.[0];
    if (top && top.team === team) award(p, "golden_boot", top.name);
    save(p);
  },
};
