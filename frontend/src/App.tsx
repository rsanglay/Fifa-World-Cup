import { NavLink, Route, Routes } from "react-router-dom";
import Home from "./features/Home";
import Teams from "./features/Teams";
import Groups from "./features/Groups";
import Fixtures from "./features/Fixtures";
import Odds from "./features/Odds";
import MatchPredictor from "./features/MatchPredictor";
import Simulator from "./features/Simulator";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/teams", label: "Teams" },
  { to: "/groups", label: "Groups" },
  { to: "/fixtures", label: "Fixtures" },
  { to: "/odds", label: "Title Odds" },
  { to: "/predict", label: "Match Predictor" },
  { to: "/simulator", label: "Simulator" },
];

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2">
            <span className="text-2xl">🏆</span>
            <span className="font-display text-2xl tracking-wide text-gold">
              WORLD CUP 2026
            </span>
          </NavLink>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 font-medium transition ${
                    isActive
                      ? "bg-gold text-ink"
                      : "text-white/70 hover:bg-white/10 hover:text-white"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/fixtures" element={<Fixtures />} />
          <Route path="/odds" element={<Odds />} />
          <Route path="/predict" element={<MatchPredictor />} />
          <Route path="/simulator" element={<Simulator />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-7xl px-4 py-8 text-center text-xs text-white/40">
        Canada · Mexico · USA — 11 June to 19 July 2026 · Model: Elo + Poisson
        Monte Carlo. Predictions are probabilistic, not guarantees.
      </footer>
    </div>
  );
}
