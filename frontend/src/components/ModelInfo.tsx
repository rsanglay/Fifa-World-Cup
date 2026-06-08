import { useState } from "react";

const SECTIONS: [string, string][] = [
  ["Team strength = Elo", "Every team has an Elo rating (the same idea chess uses). A bigger gap means a bigger favourite. Hosts get a boost when they play at home."],
  ["Goals = Poisson", "The Elo gap is turned into how many goals each side is expected to score, then each scoreline is drawn from a Poisson distribution — the standard model for football goals. That's how you get a win/draw/loss split and a most-likely score."],
  ["Knockouts", "Level after 90? Extra time, then a penalty shootout that slightly favours the stronger side — just like the real thing."],
  ["Form, rest & red cards", "Recent results nudge a team's strength (momentum), short turnarounds sap it (fatigue), and a red card weakens the carded side for the rest of the match."],
  ["Title odds = Monte Carlo", "To get title odds we simulate the whole tournament thousands of times and count how often each team wins. More simulations = steadier numbers."],
];

export default function ModelInfo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-ghost text-sm">
        ⓘ How it works
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur" onClick={() => setOpen(false)}>
          <div className="card max-h-[85vh] w-full max-w-lg overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="font-display text-3xl tracking-wide text-gold">HOW THE MODEL WORKS</div>
            <p className="mt-1 text-sm text-white/50">In plain English — no maths degree required.</p>
            <div className="mt-4 space-y-3">
              {SECTIONS.map(([title, body]) => (
                <div key={title} className="rounded-xl bg-ink/60 p-3">
                  <div className="font-semibold text-white/90">{title}</div>
                  <div className="mt-1 text-sm text-white/60">{body}</div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-white/40">
              These are probabilities, not guarantees — the whole point is that upsets happen.
            </p>
            <button onClick={() => setOpen(false)} className="btn-primary mt-4 w-full text-sm">Got it</button>
          </div>
        </div>
      )}
    </>
  );
}
