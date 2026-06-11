export interface Team {
  code: string;
  name: string;
  confederation: string;
  group: string;
  fifa_ranking: number;
  pot: number;
  elo: number;
  titles: number;
}

export interface Player {
  id: string;
  name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  rating: number;
  club?: string;
  number?: number;
  age?: number;
  caps?: number;
  goals?: number;
  assists?: number;
  market_value?: number;
  tier?: string;
  photo_url?: string;
}

export interface MatchEvent {
  type?: "goal" | "red" | "yellow" | "chance" | "sub" | "pens";
  minute: number;
  team: string;
  scorer: string;
  scorer_id: string;
  position: string;
  assist: string | null;
  outcome?: "saved" | "missed" | "woodwork";
  second_yellow?: boolean;
}

export interface LiveSnapshot {
  minute: number;
  period: "1H" | "HT" | "2H" | "ET-BREAK" | "ET" | "FT";
  home: string;
  away: string;
  home_goals: number;
  away_goals: number;
  our_side: "home" | "away";
  events: MatchEvent[];
  new_events: MatchEvent[];
  xi: string[];
  bench: string[];
  stamina: Record<string, number>;
  subs_made: number;
  subs_remaining: number;
  subs: { minute: number; out_id: string; in_id: string; out: string; in: string }[];
  mentality: string;
  opp_mentality: string;
  our_red: number | null;
  opp_red: number | null;
  break: "HT" | "ET" | null;
  done: boolean;
  penalties: boolean;
  home_pens: number | null;
  away_pens: number | null;
  knockout: boolean;
}

export interface LineupPlayer {
  id: string;
  name: string;
  position: string;
  number: number;
  rating: number;
  photo_url?: string;
}

export interface MatchLineups {
  home: LineupPlayer[];
  away: LineupPlayer[];
}

export interface AwardRow {
  id: string;
  name: string;
  position: string;
  team: string;
  team_name: string;
  photo_url?: string;
  goals: number;
  assists: number;
  chances: number;
  clean_sheets: number;
  saves: number;
  apps: number;
  rating_score?: number;
}

export interface Awards {
  golden_boot: AwardRow[];
  top_assists: AwardRow[];
  chances_created: AwardRow[];
  clean_sheets: AwardRow[];
  most_saves: AwardRow[];
  golden_ball: AwardRow[];
  young_player: AwardRow[];
}

export interface TeamDetail extends Team {
  squad: Player[];
  suggested_xi: string[];
}

export interface Fixture {
  match_no: number;
  date: string;
  kickoff_local?: string;
  venue: string;
  city: string;
  country: string;
  group?: string;
  round?: string;
  home?: string;
  away?: string;
  home_src?: string;
  away_src?: string;
  home_rest?: number | null;
  away_rest?: number | null;
}

export interface OddsRow {
  code: string;
  name: string;
  group: string;
  elo: number;
  fifa_ranking: number;
  p_round_of_32: number;
  p_round_of_16: number;
  p_quarter: number;
  p_semi: number;
  p_final: number;
  p_title: number;
}

export interface MatchPrediction {
  home: string;
  away: string;
  home_name: string;
  away_name: string;
  home_win: number;
  draw: number;
  away_win: number;
  expected_goals_home: number;
  expected_goals_away: number;
  most_likely_score: string;
  over_2_5?: number;
  under_2_5?: number;
  btts?: number;
  top_scorelines?: { score: string; prob: number }[];
}

export interface GroupRow {
  code: string;
  group: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

export interface KnockoutMatch {
  match_no: number;
  round: string;
  home: string | null;
  away: string | null;
  home_goals: number | null;
  away_goals: number | null;
  extra_time: boolean;
  penalties: boolean;
  home_pens: number | null;
  away_pens: number | null;
  winner: string | null;
  venue?: string;
  city?: string;
  date?: string;
  events?: MatchEvent[];
  lineups?: MatchLineups | null;
}

export interface SimResult {
  groups: Record<string, GroupRow[]>;
  group_matches: {
    match_no: number;
    group: string;
    home: string;
    away: string;
    home_goals: number;
    away_goals: number;
    date?: string;
    city?: string;
    venue?: string;
    events?: MatchEvent[];
    lineups?: MatchLineups | null;
  }[];
  knockout: KnockoutMatch[];
  champion: string;
  runner_up: string;
  third: string;
  team_names: Record<string, string>;
  managed_team?: string;
  lineup?: LineupResult;
  journey?: JourneyMatch[];
  awards?: Awards;
}

export interface LineupResult {
  valid: boolean;
  message: string;
  elo_delta: number;
  xi_score: number;
  baseline_score: number;
  formation?: string;
  strength_pct: number;
  team?: string;
}

export interface ManagedSquadPlayer {
  id: string;
  name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  number: number;
  rating: number;
  club: string;
  photo_url?: string;
  suspended: boolean;
  yellows: number;
}

export interface ManagedMatch {
  round: string;
  home: string;
  away: string;
  home_goals: number;
  away_goals: number;
  penalties?: boolean;
  home_pens?: number | null;
  away_pens?: number | null;
  winner?: string | null;
  date?: string;
  events?: MatchEvent[];
}

export interface ManagedState {
  team: string;
  team_name: string;
  group: string;
  phase: "group" | "knockout" | "done";
  alive: boolean;
  eliminated_round: string | null;
  champion: string | null;
  champion_name: string | null;
  group_table: GroupRow[];
  next_fixture: { stage: string; opponent: string; date?: string; venue?: string; city?: string } | null;
  last_round: ManagedMatch[];
  last_managed_match: ManagedMatch | null;
  journey: ManagedMatch[];
  squad: ManagedSquadPlayer[];
  team_names: Record<string, string>;
  done: boolean;
  won: boolean;
  awaiting_second_half: boolean;
  half_time: { home: string; away: string; home_goals: number; away_goals: number; events: MatchEvent[] } | null;
  live: LiveSnapshot | null;
  expectation: { tier: string; label: string };
  achievements: string[];
  ratings: number[];
  avg_rating: number | null;
  form: string[];
  review: string | null;
}

export interface JourneyMatch {
  stage: string;
  round: string;
  home: string;
  away: string;
  home_name?: string;
  away_name?: string;
  home_goals: number;
  away_goals: number;
  penalties?: boolean;
  home_pens?: number;
  away_pens?: number;
  winner?: string;
  events?: MatchEvent[];
}
