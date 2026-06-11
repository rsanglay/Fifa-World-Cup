import type {
  Fixture,
  GroupRow,
  LineupResult,
  LiveSnapshot,
  ManagedState,
  MatchPrediction,
  MPPreview,
  MPState,
  OddsRow,
  PLState,
  SimResult,
  Team,
  TeamDetail,
} from "../types";

// Same-origin "/api" by default (dev proxy / single-host). For a separate
// backend host (e.g. Render), set VITE_API_URL to its base URL in Vercel.
const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "") + "/api";

async function fail(res: Response, path: string): Promise<never> {
  // Prefer the server's human-readable detail (FastAPI: {"detail": "..."}).
  let detail = "";
  try { detail = (await res.json())?.detail || ""; } catch { /* not JSON */ }
  throw new Error(detail || `${res.status} ${path}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) await fail(res, path);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, path);
  return res.json();
}

export const api = {
  teams: () => get<Team[]>("/teams"),
  team: (code: string) => get<TeamDetail>(`/teams/${code}`),
  groups: () => get<Record<string, Team[]>>("/groups"),
  fixtures: () => get<{ group_stage: Fixture[]; knockout: Fixture[] }>("/fixtures"),
  venues: () => get<any[]>("/venues"),
  historical: () => get<any>("/historical"),
  odds: (simulations = 5000) => get<{ simulations: number; teams: OddsRow[] }>(`/odds?simulations=${simulations}`),
  predictMatch: (home: string, away: string, neutral = true) =>
    post<MatchPrediction>("/predict/match", { home, away, neutral }),
  simulateTournament: (seed?: number) =>
    post<SimResult>("/simulate/tournament", { seed }),
  lineup: (team: string, starting_xi: string[]) =>
    post<LineupResult>("/manage/lineup", { team, starting_xi }),
  manageSimulate: (team: string, starting_xi: string[], seed?: number) =>
    post<SimResult>("/manage/simulate", { team, starting_xi, seed }),
  manageOdds: (team: string, starting_xi: string[]) =>
    post<{ team: string; lineup: LineupResult; odds: OddsRow; simulations: number }>(
      "/manage/odds",
      { team, starting_xi }
    ),
  manageStart: (team: string, seed?: number) =>
    post<{ session_id: string; state: ManagedState }>("/manage/start", { team, seed }),
  managePreview: (session_id: string, starting_xi: string[], mentality: string) =>
    post<{ preview: { win: number; draw: number; lose: number; your_key: string; opp_key: string } }>(
      "/manage/preview", { session_id, starting_xi, mentality }),
  managePlay: (session_id: string, starting_xi: string[], mentality: string) =>
    post<{ session_id: string; state: ManagedState }>("/manage/play", { session_id, starting_xi, mentality }),
  manageSecondHalf: (session_id: string, mentality: string) =>
    post<{ session_id: string; state: ManagedState }>("/manage/second-half", { session_id, mentality }),
  manageGet: (session_id: string) =>
    get<{ session_id: string; state: ManagedState }>(`/manage/session/${session_id}`),
  manageLiveStart: (session_id: string, starting_xi: string[], mentality: string) =>
    post<{
      session_id: string | null;          // WebSocket MATCH session id
      manage_session_id: string;          // outer career session id
      live: LiveSnapshot | null;
      ws_path?: string;
    }>("/manage/live/start", { session_id, starting_xi, mentality }),
  teamSquad: (code: string, sessionId?: string) =>
    get<{ team: string; squad: (import("../types").Player & {
      form: number; suspended: boolean; injured: boolean; yellows: number;
      injured_rounds: number;
    })[] }>(`/teams/${code}/squad${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`),
  manageLiveTick: (session_id: string, minutes = 1) =>
    post<{ session_id: string; live: LiveSnapshot; state?: ManagedState }>("/manage/live/tick", { session_id, minutes }),
  manageLiveTactics: (session_id: string, t: { mentality?: string; tempo?: string; passing?: string; pressing?: string; attack_style?: string; time_wasting?: boolean; penalty_taker?: string }) =>
    post<{ session_id: string; live: LiveSnapshot }>("/manage/live/tactics", { session_id, ...t }),
  manageEvent: (session_id: string, choice: string) =>
    post<{ session_id: string; state: ManagedState; outcome: string }>("/manage/event", { session_id, choice }),
  manageLiveSub: (session_id: string, out_id: string, in_id: string) =>
    post<{ session_id: string; live: LiveSnapshot; message: string }>("/manage/live/sub", { session_id, out_id, in_id }),
  // Multiplayer rooms.
  mpCreate: (name: string, team: string | null, opts?: { draft?: boolean; deadline_minutes?: number; live_h2h?: boolean }) =>
    post<{ code: string; token: string; state: MPState }>("/mp/create", { name, team, ...opts }),
  mpJoin: (code: string, name: string, team: string | null) =>
    post<{ code: string; token: string; state: MPState }>("/mp/join", { code, name, team }),
  mpDraftPick: (code: string, token: string, team: string) =>
    post<{ code: string; state: MPState }>("/mp/draft-pick", { code, token, team }),
  mpPredict: (code: string, token: string, picks: Record<string, string>) =>
    post<{ code: string; state: MPState }>("/mp/predict", { code, token, picks }),
  mpChat: (code: string, token: string, text: string) =>
    post<{ code: string; state: MPState }>("/mp/chat", { code, token, text }),
  // Prediction leagues.
  plCreate: (name: string, deadline_minutes = 0) =>
    post<{ code: string; token: string; state: PLState }>("/pl/create", { name, deadline_minutes }),
  plJoin: (code: string, name: string) =>
    post<{ code: string; token: string; state: PLState }>("/pl/join", { code, name }),
  plStart: (code: string, token: string) =>
    post<{ code: string; state: PLState }>("/pl/start", { code, token }),
  plPredict: (code: string, token: string, picks: Record<string, { result: string; margin?: number }>) =>
    post<{ code: string; state: PLState }>("/pl/predict", { code, token, picks }),
  plState: (code: string, token: string) =>
    get<{ code: string; state: PLState }>(`/pl/state/${code}?token=${encodeURIComponent(token)}`),
  mpSwitchTeam: (code: string, token: string, team: string) =>
    post<{ code: string; state: MPState }>("/mp/switch-team", { code, token, team }),
  mpStart: (code: string, token: string) =>
    post<{ code: string; state: MPState }>("/mp/start", { code, token }),
  mpSubmit: (code: string, token: string, starting_xi: string[], mentality: string) =>
    post<{ code: string; state: MPState }>("/mp/submit", { code, token, starting_xi, mentality }),
  mpState: (code: string, token: string) =>
    get<{ code: string; state: MPState }>(`/mp/state/${code}?token=${encodeURIComponent(token)}`),
  mpPreview: (code: string) => get<MPPreview>(`/mp/preview/${code}`),
  modelDiagnostics: () => get<any>("/model/diagnostics"),
  realityOdds: (results: Record<string, [number, number]>, simulations = 2500) =>
    post<{ simulations: number; fixed_count: number; teams: OddsRow[]; standings: Record<string, any[]> }>(
      "/reality/odds",
      { results, simulations }
    ),
};

/** WebSocket URL for the Manage-a-Nation live match stream.
 * Dev: proxied under /api/ws/… · Prod (separate backend host): /ws/… */
export function manageLiveWsUrl(matchSessionId: string): string {
  const base = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const origin = base || window.location.origin;
  const ws = origin.replace(/^http/, "ws");
  const prefix = base ? "" : "/api";   // same-origin dev goes through the proxy
  return `${ws}${prefix}/ws/manage/live/${encodeURIComponent(matchSessionId)}`;
}

/** WebSocket URL for a live H2H grudge match feed. */
export function mpLiveWsUrl(code: string, matchKey: string, token: string): string {
  const base = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const origin = base || window.location.origin;
  const ws = origin.replace(/^http/, "ws");
  return `${ws}/api/mp/live/${code}/${matchKey}?token=${encodeURIComponent(token)}`;
}

// FIFA 3-letter code -> ISO-3166 alpha-2 (for flag emoji).
const ISO2: Record<string, string> = {
  MEX: "MX", ZAF: "ZA", KOR: "KR", CZE: "CZ", CAN: "CA", BIH: "BA", QAT: "QA",
  SUI: "CH", BRA: "BR", MAR: "MA", HAI: "HT", USA: "US", PAR: "PY", AUS: "AU",
  TUR: "TR", GER: "DE", CUW: "CW", CIV: "CI", ECU: "EC", NED: "NL", JPN: "JP",
  SWE: "SE", TUN: "TN", BEL: "BE", EGY: "EG", IRN: "IR", NZL: "NZ", ESP: "ES",
  CPV: "CV", KSA: "SA", URU: "UY", FRA: "FR", SEN: "SN", IRQ: "IQ", NOR: "NO",
  ARG: "AR", ALG: "DZ", AUT: "AT", JOR: "JO", POR: "PT", COD: "CD", UZB: "UZ",
  COL: "CO", CRO: "HR", GHA: "GH", PAN: "PA",
};

const SPECIAL: Record<string, string> = {
  ENG: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // England
  SCO: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}", // Scotland
};

export function flag(code: string): string {
  if (SPECIAL[code]) return SPECIAL[code];
  const iso = ISO2[code];
  if (!iso) return "\u{1F3F3}"; // white flag fallback
  return iso
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}
