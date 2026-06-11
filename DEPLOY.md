# Deploying the World Cup 2026 Predictor

This app is **two pieces**:

- **Frontend** (React) → goes on **Vercel**
- **Backend** (FastAPI / Python) → goes on **Render** (free, always-on)
- **Supabase** (optional) → durable career saves + future accounts/leaderboard

> Vercel cannot run the Python backend directly — that's why the backend goes on
> Render. The frontend on Vercel just needs to know the backend's URL.

Total time: ~15 minutes. All three services have free tiers.

---

## 1. Push to GitHub

```bash
cd fifa-wc-2026-predictor
git remote add origin https://github.com/<you>/fifa-wc-2026-predictor.git
git push -u origin main
```

Your secrets are safe: `.env` is gitignored and no keys are in the code.

---

## 2. Deploy the backend on Render

1. Go to [render.com](https://render.com) → sign in with GitHub.
2. **New** → **Blueprint** → pick this repo. Render reads `render.yaml` and
   creates the `wc2026-api` web service automatically.
3. Click **Apply**. First build takes a few minutes.
4. When it's live, copy the URL, e.g. `https://wc2026-api.onrender.com`.
5. Test it: open `https://wc2026-api.onrender.com/health` → should show
   `{"status":"ok"}`.

> Free Render services sleep after ~15 min idle and take ~30s to wake on the
> next request. Fine for a hobby/portfolio site.

---

## 3. Deploy the frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New** → **Project** → import
   this repo.
2. **Root Directory:** set to `frontend`.
3. Framework preset: **Vite** (auto-detected). Build command `npm run build`,
   output `dist` (auto).
4. **Environment Variables** → add:
   - `VITE_API_URL` = your Render backend URL (e.g.
     `https://wc2026-api.onrender.com`) — no trailing slash.
5. **Deploy.** Your site is live at `https://<project>.vercel.app`.

That's it — the frontend now talks to the backend and everything works.

---

## ⚠️ WebSockets: why the backend CANNOT live on Vercel

Manage a Nation's live match is **server-pushed over a WebSocket**
(`GET /ws/manage/live/{session_id}`): the backend ticks the match engine one
game-minute every 500ms and streams frames to the browser. This needs a
**long-lived, stateful server process**, which Vercel's serverless platform
does not provide:

- Vercel Python functions are request-scoped — they cannot hold a WebSocket
  open or keep the in-memory match session (`MatchSession`) alive between
  invocations.
- Vercel's native WebSocket story is limited to upgrading to a Node.js
  function or wiring a partner relay (Ably/Pusher) — i.e. rewriting the
  match engine in Node or adding a paid service. Neither is worth it.

**The supported setup (what this repo's config already does):**

| Piece | Host | Why |
|---|---|---|
| Frontend (Vite/React) | Vercel | static assets — perfect fit |
| Backend (FastAPI + match engine) | **Render** (or Railway / Fly.io) | one persistent uvicorn process serving HTTP **and** WebSocket |

Render/Railway/Fly run uvicorn as a real process, so the same service serves
`https://…/api/*` **and** `wss://…/ws/manage/live/{id}` with zero extra
config. The frontend derives the WebSocket URL from `VITE_API_URL`
automatically (`https://` → `wss://`).

Checklist for the live-match build:

1. `VITE_API_URL` **must** be set on Vercel (no trailing slash). Without it
   the frontend tries same-origin `/api/ws/…`, which only works in local dev
   behind the Vite proxy.
2. Render supports WebSockets out of the box, free tier included. (Mind the
   free-tier sleep: the first kick-off after idle takes ~30s to wake.)
3. If you front the backend with your own nginx, allow upgrades:
   `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
4. Match sessions are in-memory: run a **single instance** (the default).
   With multiple replicas a reconnect could land on a server that has never
   seen the session.

Disconnect behaviour: when the last socket drops the server cancels the tick
loop but keeps the match session alive for **30 minutes**, so a page refresh
reconnects into the same minute of the same match.

---

## 4. (Optional) Supabase for durable career saves

By default the backend keeps career-mode runs in memory (fine on a single
always-on Render instance). To make them survive restarts — and to lay the
groundwork for accounts and a leaderboard — connect Supabase:

1. In your Supabase project → **SQL Editor** → run `supabase/schema.sql`.
2. In **Render** → your service → **Environment** → add:
   - `SUPABASE_URL` = `https://<your-project>.supabase.co`
   - `SUPABASE_SECRET_KEY` = your **secret** key (Supabase → Settings → API).
     This lives ONLY here, never in the repo. Rotate it if it ever leaks.
3. Save → Render redeploys. Careers now persist in Supabase.

---

## Updating later

Push to `main` → Render and Vercel both auto-redeploy. Done.

## Local development

```bash
# backend
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8090

# frontend (new terminal)
cd frontend && npm install && npm run dev   # http://localhost:5174
```
The dev server proxies `/api` to the local backend, so no `VITE_API_URL` needed
locally.
