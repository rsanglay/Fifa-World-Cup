"""FastAPI entrypoint — FIFA World Cup 2026 Prediction & Simulation Platform."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.routes import router
from app.core.data import ensure_fresh

app = FastAPI(
    title="FIFA World Cup 2026 Predictor",
    description=(
        "Match predictions, tournament odds, full-tournament simulation, and "
        "manage-a-team mode for the 2026 World Cup (Canada / Mexico / USA)."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.middleware("http")
async def _data_freshness(request, call_next):
    """Reload cached data if any data/*.json changed since the last request."""
    ensure_fresh()
    return await call_next(request)


app.include_router(router, prefix="/api", tags=["world-cup"])

# Live match WebSocket at the documented root path (also available under
# /api/ws/... via the router for same-origin dev-proxy setups).
from app.api.routes import manage_live_ws  # noqa: E402

app.add_api_websocket_route("/ws/manage/live/{session_id}", manage_live_ws)


@app.get("/")
def root():
    return {
        "name": "FIFA World Cup 2026 Predictor API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": [
            "/api/teams", "/api/groups", "/api/fixtures", "/api/venues",
            "/api/historical", "/api/odds", "/api/predict/match",
            "/api/simulate/tournament", "/api/manage/lineup",
            "/api/manage/simulate", "/api/manage/odds",
        ],
    }


@app.get("/health")
def health():
    return {"status": "ok"}
