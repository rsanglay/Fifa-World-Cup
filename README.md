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

## Licence
MIT
