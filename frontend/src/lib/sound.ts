/* Tiny WebAudio sound synth — no asset files, no dependency. Stadium cues for
   the match views: a goal horn, referee whistles, and a procedural crowd.
   Muted state is persisted; nothing plays until the user has interacted
   (browser autoplay policy). The speaker toggle in the match HUD mutes every
   AudioNode through the shared master switch. */

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
  if (m) crowd.stop();
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
  /* Referee whistle: 880Hz sine, 300ms, gain 0.4 (half/full-time). */
  whistle() {
    if (muted) return;
    tone(880, 0, 0.3, "sine", 0.4);
  },
  fullTimeWhistle() {
    if (muted) return;
    tone(880, 0, 0.3, "sine", 0.4);
    tone(880, 0.38, 0.3, "sine", 0.4);
    tone(880, 0.76, 0.45, "sine", 0.4);
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
 * White noise looped through a lowpass BiquadFilterNode (400Hz) at gain 0.15
 * = the ambient stadium bed, on whenever a match view is mounted (and not
 * muted). Reactions re-shape the same bed:
 *   shot swell — gain to 0.6 over 200ms, decaying back over ~1s
 *   goal      — gain spike to 1.0 + a +4-semitone pitch shift (playbackRate
 *               × 2^(4/12)) held for 2s, then fade home
 *   groan     — darker, smaller swell for cards / injuries               */

let crowdSrc: AudioBufferSourceNode | null = null;
let crowdGain: GainNode | null = null;
let crowdFilter: BiquadFilterNode | null = null;
let noiseCache: AudioBuffer | null = null;

const CROWD_BASE = 0.15;
const PITCH_UP = Math.pow(2, 4 / 12);   // +4 semitones

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseCache) return noiseCache;
  const len = ac.sampleRate * 3;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;  // white noise
  // Cross-fade the loop seam so the bed never clicks.
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
    crowdFilter.type = "lowpass";
    crowdFilter.frequency.value = 400;
    crowdFilter.Q.value = 0.7;
    crowdGain = ac.createGain();
    crowdGain.gain.setValueAtTime(0.0001, ac.currentTime);
    crowdGain.gain.exponentialRampToValueAtTime(CROWD_BASE, ac.currentTime + 1.2);
    crowdSrc.connect(crowdFilter).connect(crowdGain).connect(ac.destination);
    crowdSrc.start();
  },

  stop() {
    if (crowdSrc) {
      const ac = audio();
      if (ac && crowdGain) {
        const t = ac.currentTime;
        crowdGain.gain.cancelScheduledValues(t);
        crowdGain.gain.setTargetAtTime(0.0001, t, 0.25);
      }
      const src = crowdSrc;
      window.setTimeout(() => { try { src.stop(); } catch { /* stopped */ } }, 700);
      crowdSrc = null; crowdGain = null; crowdFilter = null;
    }
  },

  /* Shot swell: up to 0.6 in 200ms, back to the bed over ~1s. */
  excite(amount = 1) {
    const ac = audio();
    if (!ac || muted || !crowdGain) return;
    const t = ac.currentTime;
    const peak = CROWD_BASE + (0.6 - CROWD_BASE) * Math.max(0.2, Math.min(1, amount));
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.linearRampToValueAtTime(peak, t + 0.2);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 0.25, 0.35);
  },

  /* Goal roar: gain to 1.0 + pitch +4 semitones for 2s, then fade home. */
  roar() {
    const ac = audio();
    if (!ac || muted || !crowdGain || !crowdSrc) return;
    const t = ac.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.linearRampToValueAtTime(1.0, t + 0.1);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 2.0, 1.2);
    crowdSrc.playbackRate.cancelScheduledValues(t);
    crowdSrc.playbackRate.setValueAtTime(PITCH_UP, t);
    crowdSrc.playbackRate.setTargetAtTime(1.0, t + 2.0, 0.5);
  },

  /* Grumbles for a card against us / an injury stoppage. */
  groan() {
    const ac = audio();
    if (!ac || muted || !crowdGain || !crowdFilter) return;
    const t = ac.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setTargetAtTime(CROWD_BASE * 2.2, t, 0.15);
    crowdGain.gain.setTargetAtTime(CROWD_BASE, t + 0.8, 1.0);
    crowdFilter.frequency.cancelScheduledValues(t);
    crowdFilter.frequency.setTargetAtTime(220, t, 0.12);
    crowdFilter.frequency.setTargetAtTime(400, t + 1.0, 1.2);
  },
};
