import type {
  Fixture,
  GroupRow,
  LineupResult,
  ManagedState,
  MatchPrediction,
  OddsRow,
  SimResult,
  Team,
  TeamDetail,
} from "../types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
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
  modelDiagnostics: () => get<any>("/model/diagnostics"),
  realityOdds: (results: Record<string, [number, number]>, simulations = 2500) =>
    post<{ simulations: number; fixed_count: number; teams: OddsRow[]; standings: Record<string, any[]> }>(
      "/reality/odds",
      { results, simulations }
    ),
};

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
