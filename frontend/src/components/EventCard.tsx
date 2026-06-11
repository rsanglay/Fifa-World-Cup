import { useState } from "react";
import { motion } from "framer-motion";
import type { DressingRoomEvent } from "../types";

/* Dressing-room / press-conference decision card between rounds. */
export default function EventCard({ event, onChoose }: {
  event: DressingRoomEvent;
  onChoose: (key: string) => Promise<string | void>;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const choose = async (key: string) => {
    setBusy(true);
    try {
      const o = await onChoose(key);
      setOutcome(typeof o === "string" ? o : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className="card border border-gold/30 p-4">
      <div className="text-xs uppercase tracking-wider text-gold">🎙️ Press room</div>
      <div className="mt-1 font-display text-xl">{event.title}</div>
      <p className="mt-1 text-sm text-white/70">{event.body}</p>
      {outcome ? (
        <div className="mt-3 rounded-lg bg-pitch/20 px-3 py-2 text-sm">{outcome}</div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {event.options.map((o) => (
            <button key={o.key} disabled={busy} onClick={() => choose(o.key)}
              className="rounded-lg bg-white/5 px-3 py-2 text-left transition hover:bg-gold hover:text-ink">
              <div className="text-sm font-semibold">{o.label}</div>
              <div className="mt-0.5 text-[11px] opacity-70">{o.hint}</div>
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}
