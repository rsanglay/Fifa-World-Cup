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
  }[];
  knockout: KnockoutMatch[];
  champion: string;
  runner_up: string;
  third: string;
  team_names: Record<string, string>;
  managed_team?: string;
  lineup?: LineupResult;
  journey?: JourneyMatch[];
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
}
