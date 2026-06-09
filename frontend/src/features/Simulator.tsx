import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { api, flag } from "../api/client";
import Bracket from "../components/Bracket";
import LineupPicker from "../components/LineupPicker";
import CinematicSim from "../components/CinematicSim";
import Awards from "../components/Awards";
import PlayerPhoto from "../components/PlayerPhoto";
import MatchModal, { MatchData } from "../components/MatchModal";
import Confetti from "../components/Confetti";
import ShareButton from "../components/ShareButton";
import { sound, isMuted, setMuted } from "../lib/sound";
import CareerMode from "./CareerMode";
import type { GroupRow, LineupResult, OddsRow, SimResult, Team, TeamDetail } from "../types";

type Mode = "menu" | "full" | "manage";

// Seed captured once at page load. Only a shared deep-link (page opened with
// ?seed=) skips the cinematic; consumed after the first Full-Sim mount.
const INITIAL_SEED = new URLSearchParams(window.location.search).get("seed");
let initialSeedConsumed = false;

export default function Simulator() {
  const [mode, setMode] = useState<Mode>("menu");
  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <h1 className="font-display text-4xl tracking-wide">TOURNAMENT SIMULATOR</h1>
        <SoundToggle />
      </div>
      <p className="mb-6 text-white/60">
        Run the entire World Cup, or take control of one nation and chase the trophy.
      </p>
      {mode === "menu" && <ModeMenu onPick={setMode} />}
      {mode === "full" && <FullSim onBack={() => setMode("menu")} />}
      {mode === "manage" && <ManageSim onBack={() => setMode("menu")} />}
    </div>
  );
}

function SoundToggle() {
  const [muted, setM] = useState(isMuted());
  return (
    <button
      onClick={() => { setMuted(!muted); setM(!muted); }}
      className="btn-ghost text-sm"
      title={muted ? "Sound off" : "Sound on"}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

function ModeMenu({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <button
        onClick={() => onPick("full")}
        className="card group p-8 text-left transition hover:border-gold/50"
      >
        <div className="text-5xl">🌍</div>
        <div className="mt-3 font-display text-3xl tracking-wide">FULL SIMULATION</div>
        <p className="mt-2 text-white/60">
          Simulate all 104 matches in one go. Watch the groups settle, the bracket
          fill out, and a champion get crowned.
        </p>
        <span className="mt-4 inline-block text-gold group-hover:translate-x-1">Run it →</span>
      </button>
      <button
        onClick={() => onPick("manage")}
        className="card group p-8 text-left transition hover:border-gold/50"
      >
        <div className="text-5xl">🎮</div>
        <div className="mt-3 font-display text-3xl tracking-wide">MANAGE A NATION</div>
        <p className="mt-2 text-white/60">
          Pick a country, choose your starting XI and bench, set your formation —
          then play your World Cup out match by match.
        </p>
        <span className="mt-4 inline-block text-gold group-hover:translate-x-1">Take charge →</span>
      </button>
    </div>
  );
}

/* ----------------------------- FULL SIMULATION ---------------------------- */
function FullSim({ onBack }: { onBack: () => void }) {
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(true);
  const [tab, setTab] = useState<"awards" | "bracket" | "groups">("awards");
  const [openMatch, setOpenMatch] = useState<MatchData | null>(null);
  const [seed, setSeed] = useState<number>(0);

  const run = (watch: boolean, useSeed?: number) => {
    const s = useSeed ?? Math.floor(Math.random() * 1_000_000_000);
    setSeed(s);
    const url = new URL(window.location.href);
    url.searchParams.set("seed", String(s));
    window.history.replaceState({}, "", url);
    setLoading(true);
    setResult(null);
    api.simulateTournament(s).then((r) => {
      setResult(r);
      setWatching(watch);
      setLoading(false);
    });
  };
  useEffect(() => {
    // Only a *shared link* (seed present at first page load) skips the cinematic
    // to show that exact result. Entering Full Sim normally — or "New
    // playthrough" — always plays the cinematic. Without this, run() writing
    // ?seed to the URL made every re-entry skip straight to the end.
    const deepLink = INITIAL_SEED !== null && !initialSeedConsumed;
    initialSeedConsumed = true;
    run(!deepLink, deepLink ? Number(INITIAL_SEED) : undefined);
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button onClick={onBack} className="btn-ghost text-sm">
          ← Modes
        </button>
        <button onClick={() => run(true)} disabled={loading} className="btn-primary text-sm">
          {loading ? "Simulating…" : "🎬 New playthrough"}
        </button>
        <button onClick={() => run(false)} disabled={loading} className="btn-ghost text-sm">
          🎲 Instant result
        </button>
      </div>

      {loading && <div className="skel h-64" />}

      {result && watching && (
        <CinematicSim result={result} onFinish={() => setWatching(false)} />
      )}

      {result && !watching && (
        <>
          <ChampionReveal result={result} seed={seed} />
          <div className="mb-3 mt-6 flex flex-wrap gap-2">
            {(["awards", "bracket", "groups"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  tab === t ? "bg-gold text-ink" : "bg-white/5 text-white/70"
                }`}
              >
                {t === "awards" ? "🏅 Awards" : t === "bracket" ? "Knockout Bracket" : "Group Tables"}
              </button>
            ))}
            <button onClick={() => setWatching(true)} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white/70">
              ▶ Replay cinematic
            </button>
          </div>
          {tab === "awards" && result.awards && <Awards awards={result.awards} />}
          {tab === "bracket" && (
            <>
              <p className="mb-2 text-xs text-white/40">Tap any match to see scorers and line-ups.</p>
              <Bracket knockout={result.knockout} names={result.team_names} onOpen={setOpenMatch} />
            </>
          )}
          {tab === "groups" && <GroupTables groups={result.groups} names={result.team_names} />}
        </>
      )}

      {openMatch && (
        <MatchModal match={openMatch} names={result?.team_names || {}} onClose={() => setOpenMatch(null)} />
      )}
    </div>
  );
}

function ChampionReveal({ result, seed }: { result: SimResult; seed?: number }) {
  const names = result.team_names;
  useEffect(() => {
    sound.fanfare();
  }, [result.champion]);

  const url = new URL(window.location.href);
  if (seed != null) url.searchParams.set("seed", String(seed));

  return (
    <motion.div
      key={result.champion}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="card relative overflow-hidden p-8 text-center"
    >
      <Confetti />
      <div className="absolute inset-0 bg-gradient-to-b from-gold/20 to-transparent" />
      <div className="relative">
        <div className="text-5xl">🏆</div>
        <div className="mt-1 text-xs uppercase tracking-[0.3em] text-gold">World Champions</div>
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-2 text-7xl"
        >
          {flag(result.champion)}
        </motion.div>
        <div className="mt-2 font-display text-5xl tracking-wide">
          {names[result.champion]}
        </div>
        <div className="mt-4 flex justify-center gap-8 text-sm text-white/60">
          <div>🥈 Runner-up: <span className="text-white">{names[result.runner_up]}</span></div>
          <div>🥉 Third: <span className="text-white">{names[result.third]}</span></div>
        </div>
        <div className="mt-5">
          <ShareButton
            info={{
              headline: "WORLD CHAMPIONS",
              championCode: result.champion,
              championName: names[result.champion] || result.champion,
              lines: [
                `Runner-up: ${names[result.runner_up]}`,
                `Third: ${names[result.third]}`,
              ],
              url: url.toString(),
              shareText: `🏆 ${names[result.champion]} won my World Cup 2026 simulation!`,
            }}
          />
        </div>
      </div>
    </motion.div>
  );
}

function GroupTables({
  groups,
  names,
}: {
  groups: Record<string, GroupRow[]>;
  names: Record<string, string>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Object.entries(groups).map(([g, rows]) => (
        <div key={g} className="card p-3">
          <div className="mb-2 font-display text-xl text-gold">GROUP {g}</div>
          <table className="w-full text-xs">
            <thead className="text-white/40">
              <tr>
                <th className="text-left">Team</th>
                <th>P</th>
                <th>GD</th>
                <th>Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.code}
                  className={`border-t border-white/5 ${
                    i < 2 ? "text-white" : i === 2 ? "text-white/70" : "text-white/40"
                  }`}
                >
                  <td className="py-1">
                    <span className="mr-1">{flag(r.code)}</span>
                    {names[r.code] || r.code}
                    {i < 2 && <span className="ml-1 text-[9px] text-gold">●</span>}
                  </td>
                  <td className="text-center">{r.played}</td>
                  <td className="text-center">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                  <td className="text-center font-bold">{r.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ MANAGE A TEAM ----------------------------- */
function ManageSim({ onBack }: { onBack: () => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [code, setCode] = useState<string>("");
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [xi, setXi] = useState<string[]>([]);
  const [formation, setFormation] = useState("4-3-3");
  const [lineup, setLineup] = useState<LineupResult | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [odds, setOdds] = useState<OddsRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [career, setCareer] = useState(false);

  useEffect(() => {
    api.teams().then(setTeams);
  }, []);

  const pickTeam = (c: string) => {
    setCode(c);
    setResult(null);
    setOdds(null);
    setDetail(null);
    if (!c) return;
    api.team(c).then((d) => {
      setDetail(d);
      setXi(d.suggested_xi);
    });
  };

  // Recompute lineup strength whenever the XI changes & is complete.
  useEffect(() => {
    if (code && xi.length === 11) {
      api.lineup(code, xi).then(setLineup).catch(() => setLineup(null));
    } else {
      setLineup(null);
    }
  }, [code, xi]);

  const toggle = (id: string) =>
    setXi((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const simulate = () => {
    if (xi.length !== 11) return;
    setBusy(true);
    Promise.all([api.manageSimulate(code, xi), api.manageOdds(code, xi)]).then(
      ([r, o]) => {
        setResult(r);
        setOdds(o.odds);
        setBusy(false);
      }
    );
  };

  const bench = detail?.squad.filter((p) => !xi.includes(p.id)) || [];

  if (career && code) {
    return <CareerMode team={code} onExit={() => { setCareer(false); pickTeam(""); }} />;
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button onClick={onBack} className="btn-ghost text-sm">
          ← Modes
        </button>
        <select
          value={code}
          onChange={(e) => pickTeam(e.target.value)}
          className="rounded-xl bg-ink-card px-3 py-2 font-semibold outline-none ring-1 ring-white/10 focus:ring-gold"
        >
          <option value="">Choose your nation…</option>
          {teams.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>
        {code && <span className="text-4xl">{flag(code)}</span>}
      </div>

      {!detail && code && <div className="skel h-64" />}

      {detail && !result && (
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <div className="font-display text-2xl">{detail.name}</div>
              <div className="text-sm text-white/50">
                FIFA #{detail.fifa_ranking} · Group {detail.group} · {detail.titles} title
                {detail.titles === 1 ? "" : "s"}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <StrengthMeter lineup={lineup} count={xi.length} />
              <button
                onClick={() => setXi(detail.suggested_xi)}
                className="btn-ghost text-sm"
              >
                Auto-pick best XI
              </button>
              <button
                onClick={() => setCareer(true)}
                className="btn-primary"
                title="Play every match yourself, round by round"
              >
                🎮 Career mode
              </button>
              <button
                onClick={simulate}
                disabled={xi.length !== 11 || busy}
                className="btn-ghost"
              >
                {busy ? "Playing…" : "⚡ Quick sim"}
              </button>
            </div>
          </div>
          <p className="-mt-2 text-xs text-white/40">
            <strong className="text-white/60">Career mode</strong>: pick your XI for every match, manage
            suspensions &amp; rotation, and live the whole run. <strong className="text-white/60">Quick
            sim</strong>: one XI, whole tournament at once.
          </p>

          <LineupPicker
            squad={detail.squad}
            selected={xi}
            formation={formation}
            onToggle={toggle}
            onFormation={setFormation}
          />

          <div className="card p-3">
            <div className="mb-2 text-sm font-semibold text-white/60">
              Bench ({bench.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {bench.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-lg bg-ink/60 px-2 py-1.5">
                  <PlayerPhoto name={p.name} photoUrl={p.photo_url} position={p.position} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{p.name}</div>
                    <div className="text-[10px] text-white/30">{p.position} · {p.club}</div>
                  </div>
                  <span className="rounded bg-ink px-1 text-xs font-bold text-gold">{p.rating}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {result && (
        <ManageResult
          result={result}
          odds={odds}
          onReplay={() => {
            setResult(null);
            setOdds(null);
          }}
        />
      )}
    </div>
  );
}

function StrengthMeter({ lineup, count }: { lineup: LineupResult | null; count: number }) {
  if (count !== 11)
    return <div className="text-sm text-white/40">{count}/11 selected</div>;
  const pct = lineup?.strength_pct ?? 0;
  return (
    <div className="w-40">
      <div className="flex justify-between text-xs">
        <span className="text-white/50">XI strength</span>
        <span className="font-bold text-gold">{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink">
        <div
          className="h-full rounded-full bg-gradient-to-r from-pitch to-gold"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function ManageResult({
  result,
  odds,
  onReplay,
}: {
  result: SimResult;
  odds: OddsRow | null;
  onReplay: () => void;
}) {
  const team = result.managed_team!;
  const names = result.team_names;
  const won = result.champion === team;
  const journey = result.journey || [];
  // Where did they go out? Last journey match they didn't win.
  const exit = [...journey].reverse().find((j) => j.winner && j.winner !== team && j.round !== "groups");
  const reachedFinal = journey.some((j) => j.round === "F");

  let verdict = "Eliminated in the group stage";
  if (won) verdict = "🏆 WORLD CHAMPIONS!";
  else if (reachedFinal) verdict = "🥈 Runners-up — so close!";
  else if (exit) verdict = `Knocked out in the ${roundName(exit.round)}`;

  useEffect(() => {
    if (won) sound.fanfare();
  }, [won]);

  return (
    <div className="space-y-5">
      {won && <Confetti />}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={`card p-6 text-center ${won ? "ring-2 ring-gold" : ""}`}
      >
        <div className="text-6xl">{flag(team)}</div>
        <div className="mt-2 font-display text-4xl tracking-wide">{names[team]}</div>
        <div className={`mt-2 text-2xl font-bold ${won ? "text-gold" : "text-white/80"}`}>
          {verdict}
        </div>
        {result.lineup?.formation && (
          <div className="mt-2 text-sm text-white/50">
            Your XI: {result.lineup.formation} · {result.lineup.strength_pct?.toFixed(0)}% strength
          </div>
        )}
        {odds && (
          <div className="mt-4 flex flex-wrap justify-center gap-4 text-sm">
            <Pill label="Title odds (this XI)" val={odds.p_title} />
            <Pill label="Reach final" val={odds.p_final} />
            <Pill label="Reach semis" val={odds.p_semi} />
            <Pill label="Reach last 16" val={odds.p_round_of_16} />
          </div>
        )}
        <div className="mt-5">
          <ShareButton
            info={{
              headline: `MANAGED ${names[team]?.toUpperCase() || team}`,
              championCode: won ? team : result.champion,
              championName: won ? names[team] : names[result.champion],
              lines: [
                `${names[team]}: ${verdict.replace(/^[^A-Za-z]+/, "")}`,
                won ? "" : `Winner: ${names[result.champion]}`,
              ].filter(Boolean),
              url: window.location.origin + "/simulator",
              shareText: won
                ? `🏆 I managed ${names[team]} to World Cup glory!`
                : `I managed ${names[team]} at the World Cup 2026 — ${verdict.replace(/^[^A-Za-z]+/, "").toLowerCase()}.`,
            }}
          />
        </div>
        <button onClick={onReplay} className="btn-ghost mt-3 text-sm">
          ← Change lineup & replay
        </button>
      </motion.div>

      <div>
        <h3 className="mb-2 font-display text-2xl tracking-wide">YOUR JOURNEY</h3>
        <div className="space-y-2">
          {journey.map((j, i) => {
            const isHome = j.home === team;
            const us = isHome ? j.home_goals : j.away_goals;
            const them = isHome ? j.away_goals : j.home_goals;
            const oppCode = isHome ? j.away : j.home;
            const win = j.winner === team || (us > them);
            const draw = us === them && j.round === "groups";
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="card flex items-center gap-3 p-3"
              >
                <span className="w-28 shrink-0 text-xs text-white/40">
                  {roundName(j.round)}
                </span>
                <span className="text-2xl">{flag(oppCode)}</span>
                <span className="flex-1 text-sm">
                  vs {names[oppCode] || oppCode}
                </span>
                <span
                  className={`rounded-lg px-3 py-1 font-bold tabular-nums ${
                    win ? "bg-pitch/40 text-emerald-300" : draw ? "bg-white/10" : "bg-red-500/20 text-red-300"
                  }`}
                >
                  {us}–{them}
                  {j.penalties && ` (${isHome ? j.home_pens : j.away_pens}-${isHome ? j.away_pens : j.home_pens} pens)`}
                </span>
              </motion.div>
            );
          })}
        </div>
      </div>

      {result.awards && (
        <div>
          <h3 className="mb-2 font-display text-2xl tracking-wide">TOURNAMENT AWARDS</h3>
          <Awards awards={result.awards} />
        </div>
      )}
    </div>
  );
}

function Pill({ label, val }: { label: string; val: number }) {
  return (
    <div className="rounded-xl bg-ink/60 px-4 py-2">
      <div className="font-display text-2xl text-gold">{(val * 100).toFixed(1)}%</div>
      <div className="text-[10px] text-white/50">{label}</div>
    </div>
  );
}

function roundName(r: string): string {
  return (
    {
      groups: "Group stage",
      R32: "Round of 32",
      R16: "Round of 16",
      QF: "Quarter-final",
      SF: "Semi-final",
      "3P": "3rd-place play-off",
      F: "Final",
    }[r] || r
  );
}
