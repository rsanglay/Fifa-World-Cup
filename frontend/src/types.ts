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
  type?: "goal" | "red" | "yellow" | "chance" | "sub" | "pens" | "penalty_miss" | "injury" | "tactic";
  minute: number;
  team: string;
  scorer: string;
  scorer_id: string;
  position: string;
  assist: string | null;
  assist_id?: string;
  outcome?: "saved" | "missed" | "woodwork";
  second_yellow?: boolean;
  source?: "open" | "penalty" | "freekick";
  set_piece?: "freekick";
  detail?: string;
}

/* ---------------------- live WebSocket match stream ---------------------- */
export type ChainEventType =
  | "PASS" | "DRIBBLE" | "PRESS" | "SHOT" | "SAVE" | "CORNER" | "FOUL"
  | "GOAL" | "YELLOW" | "RED" | "SUB" | "INJURY" | "PENALTY"
  | "OPP_TACTICAL_CHANGE" | "WHISTLE";

export interface ChainEvent {
  type: ChainEventType | string;
  minute: number;
  team: string;
  side?: "home" | "away";
  player_id?: string;
  player?: string;
  x?: number;
  y?: number;
  outcome?: string;
  detail?: string;
  new_mentality?: string;
  reason?: string;
  headline?: boolean;
  // headline (legacy) event fields piggyback on the same array
  scorer?: string;
  scorer_id?: string;
  assist?: string | null;
  source?: string;
  severity?: string;
}

export interface PlayerPos {
  player_id: string;
  name: string;
  number: number;
  role: string;
  team: "home" | "away";
  x: number;
  y: number;
}

export interface LiveStats {
  possession: { home: number; away: number };
  shots: { home: number; away: number };
  on_target: { home: number; away: number };
  corners: { home: number; away: number };
  fouls: { home: number; away: number };
}

export interface PlayerRating {
  player_id: string;
  name: string;
  position: string;
  role: string;
  number: number;
  minutes: number;
  goals: number;
  assists: number;
  rating: number;
  motm?: boolean;
}

export interface LiveFrame {
  minute: number;
  score: { home: number; away: number };
  events: ChainEvent[];
  player_positions: PlayerPos[];
  ball_xy: [number, number];
  possession_team: "home" | "away";
  match_phase: string;
  stats: LiveStats;
  snapshot: LiveSnapshot;
  state?: ManagedState;
  ack?: string;
  type?: string;       // "error" for refused commands
  message?: string;
}

export interface LiveSnapshot {
  form?: Record<string, number>;
  stats?: LiveStats;
  minutes_played?: Record<string, number>;
  injury_types?: Record<string, string>;
  player_ratings?: PlayerRating[];
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
  tempo: "slow" | "balanced" | "fast";
  passing: "short" | "mixed" | "direct";
  pressing: "low_block" | "mid" | "high";
  attack_style: "balanced" | "target_man" | "false_nine";
  time_wasting: boolean;
  penalty_taker: string | null;
  injured: string[];
  opp_mentality: string;
  opp_tempo: string;
  opp_passing: string;
  opp_pressing: string;
  avg_stamina: number;
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
  injured?: boolean;
  injured_rounds?: number;
  sharpness?: number;
  fatigue?: number;
  morale?: number;
  condition_pct?: number;
  form?: number;        // 0..1 match form (server-modelled, not official)
}

export interface ScorerRow {
  player_id: string;
  name: string;
  team: string;
  team_name: string;
  position: string;
  goals: number;
  assists: number;
}

export interface DressingRoomEvent {
  id: string;
  title: string;
  body: string;
  player_id?: string | null;
  player_name?: string | null;
  options: { key: string; label: string; hint: string }[];
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
  next_fixture: {
    stage: string; opponent: string; date?: string; venue?: string; city?: string;
    opponent_elo?: number; opponent_form?: string[]; home?: boolean;
  } | null;
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
  top_scorers: ScorerRow[];
  team_scorers: ScorerRow[];
  pending_event: DressingRoomEvent | null;
  news: string[];
  last_ratings?: PlayerRating[];
  card_state?: Record<string, { yellows: number; suspended_next: boolean }>;
  morale?: { avg_form: number; label: "Very Good" | "Good" | "Poor" | "Crisis" };
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

/* ------------------------------ multiplayer ------------------------------ */
export interface MPMatch extends ManagedMatch {
  home_manager?: string | null;
  away_manager?: string | null;
}

export interface MPPlayer {
  name: string;
  team: string | null;
  team_name: string | null;
  host: boolean;
  alive: boolean;
  eliminated_round: string | null;
  submitted: boolean;
  pred_points: number;
  is_you: boolean;
}

export interface MPYou {
  name: string;
  team: string | null;
  team_name: string | null;
  group: string | null;
  host: boolean;
  alive: boolean;
  eliminated_round: string | null;
  submitted: boolean;
  needs_lineup: boolean;
  squad: ManagedSquadPlayer[];
  next_fixture: {
    stage: string; opponent: string; date?: string; venue?: string;
    home: boolean; opp_manager?: string | null;
  } | null;
  form: string[];
  pred_points: number;
  predictions: Record<string, string>;
}

export interface MPStanding {
  name: string;
  team: string;
  team_name: string;
  alive: boolean;
  progress: string;
  form: string[];
  pred_points: number;
}

export interface MPChatMsg {
  name: string;
  team: string | null;
  text: string;
  ts: number;
  round_no: number;
  system: boolean;
}

export interface MPDraft {
  active: boolean;
  order: string[];
  position: number;
  on_clock: string | null;
  your_turn: boolean;
  taken: string[];
}

export interface MPLiveInfo {
  key: string;
  home: string;
  away: string;
  home_manager: string;
  away_manager: string;
  minute: number;
  home_goals: number;
  away_goals: number;
  done: boolean;
  your_side: "home" | "away" | null;
  started: boolean;
}

export interface H2HSide {
  code: string;
  manager: string;
  xi: string[];
  bench: string[];
  stamina: Record<string, number>;
  subs_made: number;
  subs_remaining: number;
  subs: { minute: number; out_id: string; in_id: string; out: string; in: string }[];
  mentality: string;
  tempo: string;
  passing: string;
  pressing: string;
  attack_style: string;
  time_wasting: boolean;
  penalty_taker: string | null;
  injured: string[];
  red: number | null;
  avg_stamina: number;
  ready: boolean;
}

export interface H2HSnapshot {
  minute: number;
  period: string;
  home: string;
  away: string;
  home_goals: number;
  away_goals: number;
  events: MatchEvent[];
  home_side: H2HSide;
  away_side: H2HSide;
  viewer: string | null;
  break: "HT" | "ET" | null;
  done: boolean;
  penalties: boolean;
  home_pens: number | null;
  away_pens: number | null;
  knockout: boolean;
}

export interface MPState {
  code: string;
  phase: "lobby" | "draft" | "group" | "knockout" | "done";
  round_no: number;
  matchday: number | null;
  ko_round: string | null;
  ko_label: string | null;
  players: MPPlayer[];
  waiting_on: string[];
  you: MPYou;
  group_table: GroupRow[];
  last_round: MPMatch[];
  h2h: MPMatch[];
  standings: MPStanding[];
  bracket: { round: string; home: string; away: string; winner: string | null }[];
  champion: string | null;
  champion_name: string | null;
  champion_manager: string | null;
  runner_up: string | null;
  team_names: Record<string, string>;
  done: boolean;
  draft: MPDraft | null;
  chat: MPChatMsg[];
  deadline_at: number | null;
  deadline_minutes: number;
  top_scorers: ScorerRow[];
  team_scorers: ScorerRow[];
  predictable: { key: string; home: string; away: string; stage: string }[];
  live_h2h: MPLiveInfo[];
  awaiting_live: boolean;
}

export interface PLState {
  code: string;
  phase: "lobby" | "group" | "knockout" | "done";
  round_no: number;
  matchday: number | null;
  ko_label: string | null;
  members: { name: string; host: boolean; points: number; predicted: boolean; is_you: boolean }[];
  you: {
    name: string; host: boolean; points: number; exact: number;
    predictions: Record<string, { result: string; margin?: number }>;
    predicted: boolean;
  };
  round_matches: { key: string; home: string; away: string; stage: string; knockout: boolean; group?: string | null }[];
  waiting_on: string[];
  last_round: ManagedMatch[];
  last_round_points: Record<string, number>;
  leaderboard: { name: string; points: number; exact: number; rounds_played: number; host: boolean }[];
  deadline_at: number | null;
  champion: string | null;
  champion_name: string | null;
  team_names: Record<string, string>;
  done: boolean;
}

export interface MPPreview {
  code: string;
  phase: string;
  players: { name: string; team: string; team_name: string; host: boolean }[];
  taken_teams: string[];
  joinable: boolean;
  draft?: boolean;
  deadline_minutes?: number;
}
