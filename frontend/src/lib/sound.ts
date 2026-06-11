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

/* ------------------- crowd atmosphere (procedural, no assets) -------------
 * A looped brown-noise bed through a bandpass filter = stadium murmur.
 * Reactions re-shape the same bed: a fast swell-and-drop for an "OOOH", a
 * long hot decay for a goal roar. Everything respects the mute toggle. */

let crowdSrc: AudioBufferSourceNode | null = null;
let crowdGain: GainNode | null = null;
let crowdFilter: BiquadFilterNode | null = null;
let murmurTimer: number | null = null;
let noiseCache: AudioBuffer | null = null;

const CROWD_BASE = 0.05;

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseCache) return noiseCache;
  const len = ac.sampleRate * 3;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  // Brown-ish noise via a clamped random walk; nudge the tail back toward the
  // head so the loop seam disappears under the bandpass.
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = Math.max(-1, Math.min(1, v + (Math.random() * 2 - 1) * 0.08));
    data[i] = v * 0.8;
  }
  const blend = Math.floor(ac.sampleRate * 0.25);
  for (let i = 0; i < blend; i++) {
    const a = i / blend;
    data[len - blend + i] = data[len - blend + i] * (1 - a) + data[i] * a;
  }
  noiseCache = buf;
  return buf;
}

export const crowd = {
  start() {
    const ac = audio();
    if (!ac || muted || crowdSrc) return;
    crowdSrc = ac.createBufferSource();
    crowdSrc.buffer = noiseBuffer(ac);
    crowdSrc.loop = true;
    crowdFilter = ac.createBiquadFilter();
    crowdFilter.type = "bandpass";
    crowdFilter.frequency.value = 650;
    crowdFilter.Q.value = 0.55;
    crowdGain = ac.createGain();
    crowdGain.gain.setValueAtTime(0.0001, ac.currentTime);
    crowdGain.gain.exponentialRampToValueAtTime(CROWD_BASE, ac.currentTime + 1.4);
    crowdSrc.connect(crowdFilter).connect(crowdGain).connect(ac.destination);
    crowdSrc.start();
    // Gentle breathing: small random swells so the murmur never sits still.
    murmurTimer = window.setInterval(() => {
      if (!crowdGain || !ac) return;
      const t = ac.currentTime;
      const target = CROWD_BASE * (0.8 + Math.random() * 0.55);
      crowdGain.gain.cancelScheduledValues(t);
      crowdGain.gain.setTargetAtTime(target, t, 1.2);
    }, 2600);
  },

  stop() {
    if (murmurTimer != null) { window.clearInterval(murmurTimer); murmurTimer = null; }
    if (crowdSrc) {
      const ac = audio();
      if (ac && crowdGain) {
        const t = ac.currentTime;
        crowdGain.gain.cancelScheduledValues(t);
        crowdGain.gain.setTargetAtTime(0.0001, t, 0.25);
      }
      const src = crowdSrc;
      window.setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, 700);
      crowdSrc = null; crowdGain = null; crowdFilter = null;
    }
  },

  /* A near-miss "OOOH" — quick swell, quick drop. amount 0..1. */
  excite(amount = 1) {
    const ac = audio();
    if (!ac || muted || !crowdGain || !crowdFilter) return;
    const t = ac.currentTime;
    const peak = CROWD_BASE * (2.2 + 2.2 * amount);
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setTargetAtTime(peak, t, 0.12);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 0.5, 0.9);
    crowdFilter.frequency.cancelScheduledValues(t);
    crowdFilter.frequency.setTargetAtTime(950, t, 0.1);
    crowdFilter.frequency.setTargetAtTime(650, t + 0.6, 1.0);
  },

  /* The goal roar: hits hard, stays hot, cools slowly. */
  roar() {
    const ac = audio();
    if (!ac || muted || !crowdGain || !crowdFilter) return;
    const t = ac.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setTargetAtTime(CROWD_BASE * 7, t, 0.08);
    crowdGain.gain.setTargetAtTime(CROWD_BASE * 2.2, t + 1.6, 1.4);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 4.5, 2.0);
    crowdFilter.frequency.cancelScheduledValues(t);
    crowdFilter.frequency.setTargetAtTime(1400, t, 0.08);
    crowdFilter.frequency.setTargetAtTime(650, t + 3.0, 1.5);
  },

  /* Grumbles for a card against us / an injury stoppage. */
  groan() {
    const ac = audio();
    if (!ac || muted || !crowdGain || !crowdFilter) return;
    const t = ac.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setTargetAtTime(CROWD_BASE * 2.6, t, 0.15);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 0.8, 1.0);
    crowdFilter.frequency.cancelScheduledValues(t);
    crowdFilter.frequency.setTargetAtTime(380, t, 0.12);
    crowdFilter.frequency.setTargetAtTime(650, t + 1.0, 1.2);
  },
};
