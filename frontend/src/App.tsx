import { lazy, Suspense, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Home from "./features/Home";
import ErrorBoundary from "./components/ErrorBoundary";

// Lazy-load the heavier routes so the initial bundle stays small — the
// Simulator alone pulls in the cinematic engine, confetti, audio, etc.
const Teams = lazy(() => import("./features/Teams"));
const Groups = lazy(() => import("./features/Groups"));
const Fixtures = lazy(() => import("./features/Fixtures"));
const Odds = lazy(() => import("./features/Odds"));
const MatchPredictor = lazy(() => import("./features/MatchPredictor"));
const Simulator = lazy(() => import("./features/Simulator"));
const Reality = lazy(() => import("./features/Reality"));

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/teams", label: "Teams" },
  { to: "/groups", label: "Groups" },
  { to: "/fixtures", label: "Fixtures" },
  { to: "/odds", label: "Title Odds" },
  { to: "/predict", label: "Match Predictor" },
  { to: "/simulator", label: "Simulator" },
  { to: "/what-if", label: "What-If Lab" },
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
            <Route path="/teams" element={<Teams />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/fixtures" element={<Fixtures />} />
            <Route path="/odds" element={<Odds />} />
            <Route path="/predict" element={<MatchPredictor />} />
            <Route path="/simulator" element={<Simulator />} />
            <Route path="/what-if" element={<Reality />} />
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
