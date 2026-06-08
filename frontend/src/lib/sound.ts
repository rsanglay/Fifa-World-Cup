/* Tiny WebAudio sound synth — no asset files, no dependency. Stadium cues for
   the simulator: a goal horn, a whistle, and a trophy fanfare. Muted state is
   persisted; nothing plays until the user has interacted (browser autoplay). */

let ctx: AudioContext | null = null;
let muted = localStorage.getItem("wc26_muted") === "1";

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function isMuted() {
  return muted;
}
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("wc26_muted", m ? "1" : "0");
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.18, sweepTo?: number) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, ac.currentTime + start + dur);
  g.gain.setValueAtTime(0.0001, ac.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.05);
}

export const sound = {
  goal() {
    if (muted) return;
    tone(330, 0, 0.18, "sawtooth", 0.16, 660);
    tone(440, 0.12, 0.3, "square", 0.14);
  },
  whistle() {
    if (muted) return;
    tone(2100, 0, 0.14, "triangle", 0.1);
    tone(2100, 0.18, 0.2, "triangle", 0.1);
  },
  red() {
    if (muted) return;
    tone(180, 0, 0.25, "square", 0.12, 120);
  },
  fanfare() {
    if (muted) return;
    const notes = [523, 659, 784, 1047]; // C E G C
    notes.forEach((f, i) => tone(f, i * 0.16, 0.4, "square", 0.16));
    tone(1047, 0.64, 0.8, "sawtooth", 0.14);
  },
};
