import { lazy, Suspense, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Home from "./features/Home";
import ErrorBoundary from "./components/ErrorBoundary";

// Lazy-load the heavier hubs so the initial bundle stays small.
const TournamentHub = lazy(() => import("./features/TournamentHub"));
const PredictHub = lazy(() => import("./features/PredictHub"));
const Simulator = lazy(() => import("./features/Simulator"));

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/tournament", label: "Tournament" },
  { to: "/predict", label: "Predict" },
  { to: "/simulator", label: "Simulator" },
];

export default function App() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  const links = (onClick?: () => void) =>
    NAV.map((n) => (
      <NavLink
        key={n.to}
        to={n.to}
        end={n.end}
        onClick={onClick}
        className={({ isActive }) =>
          `rounded-lg px-3 py-1.5 font-medium transition ${
            isActive ? "bg-gold text-ink" : "text-white/70 hover:bg-white/10 hover:text-white"
          }`
        }
      >
        {n.label}
      </NavLink>
    ));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
            <span className="text-2xl">🏆</span>
            <span className="font-display text-2xl tracking-wide text-gold">WORLD CUP 2026</span>
          </NavLink>
          {/* Desktop nav */}
          <nav className="hidden flex-wrap gap-1 text-sm md:flex">{links()}</nav>
          {/* Mobile toggle */}
          <button
            onClick={() => setOpen((o) => !o)}
            className="ml-auto rounded-lg bg-white/5 p-2 md:hidden"
            aria-label="Toggle menu"
          >
            <span className="block text-xl leading-none">{open ? "✕" : "☰"}</span>
          </button>
        </div>
        {/* Mobile drawer */}
        {open && (
          <nav className="flex flex-col gap-1 border-t border-white/10 px-4 py-3 text-sm md:hidden">
            {links(() => setOpen(false))}
          </nav>
        )}
      </header>

      <main key={loc.pathname} className="mx-auto max-w-7xl px-4 py-6">
        <ErrorBoundary>
          <Suspense fallback={<div className="skel h-64" />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/tournament" element={<TournamentHub />} />
            <Route path="/predict" element={<PredictHub />} />
            <Route path="/simulator" element={<Simulator />} />
            {/* Redirects for old deep links */}
            <Route path="/teams" element={<Navigate to="/tournament?tab=teams" replace />} />
            <Route path="/groups" element={<Navigate to="/tournament?tab=groups" replace />} />
            <Route path="/fixtures" element={<Navigate to="/tournament?tab=fixtures" replace />} />
            <Route path="/odds" element={<Navigate to="/predict?tab=odds" replace />} />
            <Route path="/predict-match" element={<Navigate to="/predict?tab=match" replace />} />
            <Route path="/what-if" element={<Navigate to="/predict?tab=whatif" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>

      <footer className="mx-auto max-w-7xl px-4 py-8 text-center text-xs text-white/40">
        Canada · Mexico · USA — 11 June to 19 July 2026 · Model: Elo + Poisson
        Monte Carlo. Predictions are probabilistic, not guarantees.
      </footer>
    </div>
  );
}
