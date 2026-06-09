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
