# FIFA World Cup 2026 — Prediction & Simulation Platform

A full-stack predictor for the 2026 FIFA World Cup (Canada · Mexico · USA,
11 June – 19 July 2026). FastAPI backend with an Elo + Poisson match model and
Monte-Carlo tournament engine; React + TypeScript frontend with a cinematic
tournament simulator.

Inspired by — and structured like — the SA20 cricket predictor, rebuilt for
international football and the 48-team World Cup format.

## What it does

- **Match Predictor** — win / draw / loss probabilities and the most likely
  scoreline for any two of the 48 teams.
- **Title Odds** — Monte-Carlo odds (2k–10k simulated tournaments) for every
  team to reach each round and lift the trophy.
- **Tournament Simulator — two modes:**
  - **Full Simulation** — simulate all 104 matches in one go: group tables
    settle, the Round-of-32 bracket fills out, a champion is crowned.
  - **Manage a Nation** — pick a country, choose your **starting XI and bench**,
    set your formation, then play your World Cup out match by match. A weaker
    lineup measurably lowers your odds; rest your stars at your peril.
  - **Live in-game management** — every managed match now plays out minute by
    minute on a **Football-Manager-style 2D pitch**. Pause at any moment,
    switch mentality mid-match, and make up to 5 substitutions — tired legs
    lose effectiveness, fresh legs restore it, and your changes feed straight
    back into the live probabilities. Half-time and extra-time breaks pause
    the game for tactical decisions; yellow/red cards are shown live and carry
    real suspensions into the next round.
- **Multiplayer — your own World Cup against friends.** Create a room, share
  the 5-letter code, and each manager picks a nation (up to 12 humans; the AI
  runs the other nations). All 12 groups play matchday by matchday — each
  round waits until every manager has locked in an XI + mentality, then the
  whole round plays at once. When two managed nations meet it's a **grudge
  match**: both lineups and both mentalities feed the same match engine.
  Optional **draft lobby** (nations picked in a randomized draft), **round
  deadlines** with best-XI auto-pick for no-shows, a **trash-talk feed**, and
  **spectator predictions** so eliminated managers keep scoring points.
  Rooms are in-memory (no accounts) — a refresh rejoins via the saved token.
- **LIVE head-to-head grudge matches.** When two managed nations meet, the
  round holds and the fixture plays out **live over a WebSocket** — both
  managers in their dugouts on the same server-clocked minute-by-minute feed,
  changing tactics and making subs in real time while the rest of the room
  spectates. Half-time waits for both managers to ready up; abandoned matches
  auto-resolve so a room can never deadlock.
- **Squad management with consequences.** Every player carries **match
  sharpness, fatigue and morale** between rounds — an ever-present XI runs
  out of legs by the knockouts, unused subs go rusty, rotation is a real
  decision. **Injuries** strike mid-match (sub him or gamble on heart) and
  rule players out for 1-2 matches, alongside yellow/red suspensions.
- **Dressing-room events.** Between rounds the press room comes calling — a
  benched star sulks, the papers write you off, the squad wants a night out.
  Your call nudges morale and momentum.
- **Golden Boot race.** Goals and assists tracked across all 104 matches
  (every AI match included), in career mode and multiplayer.
- **Deeper live tactics.** Attack style (target man / false nine), a
  time-wasting toggle, named penalty takers — and the opponent AI's tactical
  switches are announced live so you can counter them.
- **Prediction leagues.** No squads, just football brains: friends predict
  every match of a simulated World Cup round by round (2 pts a result, +1
  for the exact margin) on a private leaderboard.
- **Share cards & manager profile.** Canvas-rendered PNG cards of your
  final, your run or a grudge-match win — built for the group chat. A
  persistent local manager profile collects badges (World Champion, Grudge
  Lord, Golden Boot Manager, The Oracle...) across every mode.
- **Groups & Fixtures** — all 12 groups and 72 group-stage matches with real
  dates and venues.

## The data (real, 2026)

| File (`backend/data/`) | Contents |
|------------------------|----------|
| `teams.json` | 48 teams — confederation, group, FIFA ranking, draw pot, Elo, titles |
| `fixtures.json` | 72 group-stage + 32 knockout matches with dates & venues |
| `venues.json` | 16 host stadiums |
| `squads.json` | 26-man squads for all 48 teams (1248 real players, positions, clubs) |
| `historical.json` | Every World Cup final 1930–2022 + all-time title counts |

Group draw is the official 5 Dec 2025 result. Fixtures cross-checked against
Wikipedia / Sky Sports. Player ratings are modelled from team strength + an
importance tier — they are a model, not official ratings.

## How the model works

1. **Team strength** = Elo rating (eloratings.net style).
2. **Match** — the Elo gap sets an expected goal supremacy; goals are drawn from
   independent Poisson distributions. Hosts get a home-advantage bump in their
   own country.
3. **Knockouts** — level after 90' → extra time (scaled continuation) →
   penalties (a near-coin-flip nudged by team strength).
4. **Tournament** — 12 groups (FIFA tiebreakers + 8 best third-placed teams) →
   single-elimination Round of 32 → Final.
5. **Manage-a-team** — your XI is scored against the squad's optimal XI; the gap
   becomes an Elo delta fed straight into the match engine.
6. **Live matches** — the managed match is simulated **one minute at a time** on
   the server (a Bernoulli thinning of the same Poisson rates, so expected
   scorelines are unchanged). The client's 2D view is a pure renderer of the
   event stream — the same headless-sim/viewer split Football Manager uses —
   with formation-anchored player dots and an event-driven ball. Stamina decays
   each minute (faster when attacking); effective ratings feed the per-minute
   rates, so substitutions and mentality switches have a real, model-grounded
   effect. The opposition runs a small AI that chases the game or parks the bus.

The match model is deliberately tempered so a 48-team field's favourite tops out
around 20–28% — realistic, not deterministic.

## Run it

### Backend (FastAPI, port 8090)
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8090
```
API docs at http://localhost:8090/docs

### Frontend (React + Vite, port 5174)
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5174 (the dev server proxies `/api` to the backend).

### Docker
```bash
docker-compose up --build
```

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/teams` · `/api/teams/{code}` | Teams + squad |
| GET | `/api/groups` · `/api/fixtures` · `/api/venues` | Reference data |
| GET | `/api/historical` · `/api/formations` | Records, formations |
| GET | `/api/odds?simulations=N` | Monte-Carlo title odds |
| POST | `/api/predict/match` | Single-match prediction |
| POST | `/api/simulate/tournament` | One full tournament |
| POST | `/api/manage/lineup` | Score an XI → strength + Elo delta |
| POST | `/api/manage/simulate` | Play a tournament managing one team |
| POST | `/api/manage/odds` | Your team's odds with the chosen XI |
| POST | `/api/manage/start` · `/api/manage/preview` | Start / preview a career match |
| POST | `/api/manage/live/start` | Kick off an interactive live match |
| POST | `/api/manage/live/tick` | Advance the live match 1–5 game minutes |
| POST | `/api/manage/live/tactics` | Change mentality mid-match |
| POST | `/api/manage/live/sub` | Make a substitution (max 5) |

## Licence
MIT
