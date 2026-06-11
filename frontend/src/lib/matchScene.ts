/* MatchScene v5 — the FM-style possession engine behind every match view.
 *
 * The renderer-agnostic half of the sim/viewer split: the SERVER decides what
 * happens each minute; this engine improvises believable football between
 * those facts, and the 2D/3D views just draw it. v5 rebuilds the choreography
 * on the mechanics Sports Interactive's engine actually uses:
 *
 *  PASS TYPES   Most football is played on the grass. Distance decides the
 *               ball: short = ground pass (no lift, quick), medium = driven
 *               (low), long = lofted (slow, high). Lofted balls are RARE.
 *  LOCALITY     Receivers are picked by proximity sweet-spot (8-20m), not by
 *               maximum forward progress — so possession circulates through
 *               midfield instead of ping-ponging end to end.
 *  BUILD-UP     Server events (goal/chance) never teleport the ball. The
 *               attack is walked in: a chain of 1-3 short passes through
 *               intermediate teammates into the box, then the finish.
 *  DEAD BALLS   A whistle freezes EVERYONE in place (they stand, they don't
 *               jog about). Free kicks and corners are set up properly: the
 *               nearest player WALKS THE BALL to the spot (or walks over to
 *               it), a wall forms / the box fills, beat, then the strike.
 *  RESTARTS     Fouls restart with a real free kick by the fouled team;
 *               missed shots become goal kicks; kick-offs are a short
 *               backward ground pass after the teams reset.
 *
 * Movement is fixed-timestep (1/120s), velocity-based with separation.
 * Coordinates: x 0..100 (home attacks left->right), y 0..100, ball.lift is
 * the normalized flight height (0 = rolling on the grass).
 * Nothing here can change the result — the sim stays server-side.
 */
import type { MatchEvent } from "../types";

export type SceneShape = { d: number; m: number; f: number };
export type SceneLine = "GK" | "DEF" | "MID" | "FWD";

export interface SceneDot {
  x: number; y: number; tx: number; ty: number; line: SceneLine;
  vx: number; vy: number;
}
export interface SceneFlash { id: number; label: string; confetti: boolean }

interface Flight {
  sx: number; sy: number;
  tx: number; ty: number;
  toDot?: { home: boolean; idx: number };
  speed: number; prog: number;
  kind: "pass" | "shot" | "place";
  liftAmp: number;                               // 0 = along the grass
  bow: number;                                   // lateral curl
  onLand?: () => void;
}
interface Carry { home: boolean; idx: number; x: number; y: number; done: () => void }
interface SetPiece {
  x: number; y: number;
  kind: "fk" | "pen" | "corner" | "kickoff";
  attackHome: boolean;
  until: number;
}

const LINE_X_HOME: Record<SceneLine, number> = { GK: 4.5, DEF: 20, MID: 42, FWD: 64 };
const PULL: Record<SceneLine, number> = { GK: 0.02, DEF: 0.1, MID: 0.2, FWD: 0.28 };
const RUN_SPEED: Record<SceneLine, number> = { GK: 8, DEF: 13, MID: 15, FWD: 17 };
const ACCEL = 40;
const SEPARATION = 3.0;
const PARTY_SPEED = 26;
const SHOT_SPEED = 90;
const PLACE_SPEED = 34;
const CELEBRATE_MS = 2400;
const PRESS_RADIUS = 14;
const TACKLE_RANGE = 2.1;
const TACKLE_RATE = 1.3;
const CORNER_CHANCE = 0.35;
const CHAIN_LEG = 24;          // max metres the ball moves per build-up pass

function anchors(shape: SceneShape, home: boolean): { x: number; y: number; line: SceneLine }[] {
  const rows: [SceneLine, number][] = [["GK", 1], ["DEF", shape.d], ["MID", shape.m], ["FWD", shape.f]];
  const out: { x: number; y: number; line: SceneLine }[] = [];
  rows.forEach(([line, n]) => {
    for (let i = 0; i < n; i++) {
      const x = home ? LINE_X_HOME[line] : 100 - LINE_X_HOME[line];
      out.push({ x, y: ((i + 1) / (n + 1)) * 100, line });
    }
  });
  return out;
}

/* Distance decides how a pass travels. This is the "ground passing" core. */
function passProfile(dist: number): { speed: number; liftAmp: number } {
  if (dist < 16) return { speed: 44, liftAmp: 0 };          // along the grass
  if (dist < 28) return { speed: 40, liftAmp: 0.16 };       // driven, knee height
  return { speed: 27, liftAmp: 0.85 };                      // lofted, rare
}

export class MatchScene {
  homeShape: SceneShape = { d: 4, m: 3, f: 3 };
  awayShape: SceneShape = { d: 4, m: 3, f: 3 };
  possession = 0.5;

  ball = { x: 50, y: 50, lift: 0 };
  homeDots: SceneDot[] = [];
  awayDots: SceneDot[] = [];
  carrier: { home: boolean; idx: number } | null = null;
  celebrate: { until: number; home: boolean } | null = null;
  onFlash?: (f: SceneFlash | null) => void;
  /** The PRESENTATION score: increments when the goal is SHOWN (ball in the
   * net), not when the server reports it. The scoreboard renders this — so
   * the score can never spoil a goal the viewer hasn't seen yet. */
  shownScore = { home: 0, away: 0 };
  onScore?: (home: number, away: number) => void;
  onGoalShown?: (home: boolean) => void;

  private pending: { e: MatchEvent; evHome: boolean; ours: boolean }[] = [];
  private scoreInit = false;
  private flight: Flight | null = null;
  private carry: Carry | null = null;
  private setpiece: SetPiece | null = null;
  private kickoffSide: boolean | null = null;
  private nextActionAt = 0;
  private frozenUntil = 0;     // no open-play decisions
  private holdUntil = 0;       // the whistle: players STAND
  private dribbleUntil = 0;
  private eventKey = "";
  private seenKeys = new Set<string>();
  private queue: { at: number; fn: () => void }[] = [];
  private flashId = 0;
  private acc = 0;
  /** The SIM clock: advances only while step() runs. Every timer, freeze,
   * hold and set-piece window lives on this clock, so pausing the match
   * (tactics panel, half-time) suspends the choreography too — state can
   * never advance behind a frozen screen and teleport on resume. */
  private simNow = 0;
  /** True while an event choreography OWNS the ball (the dead-ball state
   * machine). While set: no improvised open play, no pressing, no tackles —
   * the whole class of "open play fires mid-set-piece" glitches dies here. */
  private script = false;

  constructor() {
    this.setShapes(this.homeShape, this.awayShape);
  }

  /** The active dead-ball state, if any — renderers use this to time
   * presentation (EA's rule: cutscenes only inside dead-ball windows). */
  get deadBall(): SetPiece["kind"] | null {
    return this.setpiece && this.simNow < this.setpiece.until
      ? this.setpiece.kind : null;
  }

  /** Seed the shown score when joining/resuming a match mid-way. */
  initScore(home: number, away: number): void {
    if (this.scoreInit) return;
    this.scoreInit = true;
    this.shownScore = { home, away };
    this.onScore?.(home, away);
  }

  private bumpScore(evHome: boolean): void {
    this.shownScore = {
      home: this.shownScore.home + (evHome ? 1 : 0),
      away: this.shownScore.away + (evHome ? 0 : 1),
    };
    this.onScore?.(this.shownScore.home, this.shownScore.away);
  }

  /** Designated set-piece takers (EA FC IQ-style fixed assignments): the
   * last midfielder is the dead-ball specialist (corners + free kicks), the
   * first forward takes the penalties. Same player every time — that
   * consistency is what reads as "a real team". */
  private takerIdx(side: boolean, kind: "corner" | "fk" | "pen"): number {
    const shape = side ? this.homeShape : this.awayShape;
    const midEnd = 1 + shape.d + shape.m - 1;       // dots order: GK, DEFs, MIDs
    if (kind === "pen") return midEnd + 1;          // first FWD
    return midEnd;                                  // set-piece specialist MID
  }

  /* -------------------------------------------------------------- lifecycle */
  setShapes(home: SceneShape, away: SceneShape): void {
    const reanchor = (shape: SceneShape, isHome: boolean, prev: SceneDot[]) => {
      const next = anchors(shape, isHome).map((a) => ({ ...a, tx: a.x, ty: a.y, vx: 0, vy: 0 }));
      next.forEach((d, i) => {
        if (prev[i]) { d.x = prev[i].x; d.y = prev[i].y; d.vx = prev[i].vx; d.vy = prev[i].vy; }
      });
      return next;
    };
    if (shapeChanged(this.homeShape, home) || this.homeDots.length === 0) {
      this.homeDots = reanchor(home, true, this.homeDots);
    }
    if (shapeChanged(this.awayShape, away) || this.awayDots.length === 0) {
      this.awayDots = reanchor(away, false, this.awayDots);
    }
    this.homeShape = home;
    this.awayShape = away;
  }

  dispose(): void {
    this.queue = [];
  }

  /** Sim-clock timeout: fires from substep, never from a wall timer. */
  private later(fn: () => void, ms: number): void {
    this.queue.push({ at: this.simNow + ms, fn });
  }

  private drainQueue(now: number): void {
    let fired = true;
    while (fired) {
      fired = false;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].at <= now) {
          const { fn } = this.queue.splice(i, 1)[0];
          fn();
          fired = true;
          break;
        }
      }
    }
  }

  /* --------------------------------------------------------------- flights */
  private fly(tx: number, ty: number, speed: number, kind: Flight["kind"],
              onLand?: () => void, toDot?: Flight["toDot"], liftAmp = 0): void {
    const b = this.ball;
    const dist = Math.max(1, Math.hypot(tx - b.x, ty - b.y));
    const bow = kind === "place" ? 0
      : kind === "shot" ? (Math.random() - 0.5) * 0.6
      : (Math.random() - 0.5) * 2 * Math.min(2.2, dist * 0.05) * (liftAmp > 0.5 ? 1.8 : 1);
    this.carrier = null;
    this.flight = { sx: b.x, sy: b.y, tx, ty, toDot, speed, prog: 0, kind, liftAmp, bow, onLand };
    if (toDot && kind === "pass") {
      const d = this.dotOf(toDot.home, toDot.idx);
      if (d) {       // the receiver steps toward the ball, not away from it
        d.tx = d.x + (b.x - d.x) * 0.22;
        d.ty = d.y + (b.y - d.y) * 0.22;
      }
    }
  }

  /** A pass to a teammate using the distance-appropriate ball type. */
  private passTo(side: boolean, idx: number, after?: () => void): void {
    const d = this.dotOf(side, idx);
    if (!d) return;
    const { speed, liftAmp } = passProfile(Math.hypot(d.x - this.ball.x, d.y - this.ball.y));
    this.fly(d.x, d.y, speed, "pass", () => {
      this.carrier = { home: side, idx };
      this.nextActionAt = this.simNow
        + (Math.random() < 0.3 ? 90 : 180 + Math.random() * 320);
      after?.();
    }, { home: side, idx });
  }

  /** Walk the attack to (tx,ty) through SHORT passes — never one teleport.
   * Each leg re-arms the script lock so improvised open play can NEVER steal
   * the ball mid-choreography (that interleave was real and ugly). */
  private chainTo(side: boolean, tx: number, ty: number, done: () => void,
                  legsLeft = 3): void {
    this.freeze(3000);
    this.nextActionAt = this.simNow + 10000;   // chain owns the ball
    const b = this.ball;
    const dist = Math.hypot(tx - b.x, ty - b.y);
    if (dist <= CHAIN_LEG + 4 || legsLeft <= 0) {
      const { speed, liftAmp } = passProfile(dist);
      this.fly(tx, ty, speed, "pass", done, undefined, liftAmp);
      return;
    }
    // Next waypoint one leg toward the target; nearest teammate runs the line.
    const ux = (tx - b.x) / dist, uy = (ty - b.y) / dist;
    const wx = b.x + ux * CHAIN_LEG + (Math.random() * 8 - 4);
    const wy = clamp(b.y + uy * CHAIN_LEG + (Math.random() * 10 - 5), 8, 92);
    const dots = side ? this.homeDots : this.awayDots;
    let best = -1, bd = 1e9;
    dots.forEach((d, i) => {
      if (d.line === "GK" || (this.carrier?.home === side && this.carrier.idx === i)) return;
      const dd = Math.hypot(d.x - wx, d.y - wy);
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best < 0) { done(); return; }
    const recv = dots[best];
    recv.tx = wx; recv.ty = wy;                    // run onto the pass
    const { speed, liftAmp } = passProfile(Math.hypot(recv.x - b.x, recv.y - b.y));
    this.fly(recv.x, recv.y, speed, "pass", () => {
      this.carrier = { home: side, idx: best };
      this.nextActionAt = this.simNow + 10000;
      this.later(() => this.chainTo(side, tx, ty, done, legsLeft - 1),
                 130 + Math.random() * 220);
    }, { home: side, idx: best }, liftAmp);
  }

  /** A player walks the ball to a dead-ball spot. Set pieces use the
   * DESIGNATED taker; quick restarts (fouls) use whoever is nearest. */
  private carryTo(side: boolean, x: number, y: number, done: () => void,
                  taker?: number): void {
    let best = taker ?? -1;
    if (best < 0) {
      const dots = side ? this.homeDots : this.awayDots;
      let bd = 1e9;
      best = 1;
      dots.forEach((d, i) => {
        if (d.line === "GK") return;
        const dd = Math.hypot(d.x - this.ball.x, d.y - this.ball.y);
        if (dd < bd) { bd = dd; best = i; }
      });
    }
    this.flight = null;
    this.carrier = { home: side, idx: best };
    this.carry = { home: side, idx: best, x, y, done };
  }

  private killBall(): void {
    this.flight = null;
    this.carrier = null;
    this.carry = null;
    this.ball.lift = 0;
  }

  private dotOf(home: boolean, idx: number): SceneDot | undefined {
    return (home ? this.homeDots : this.awayDots)[idx];
  }

  private freeze(ms: number): void {
    this.frozenUntil = Math.max(this.frozenUntil, this.simNow + ms);
  }

  /** The whistle: everyone stands still for `ms` (scripted actors excepted). */
  private hold(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, this.simNow + ms);
  }

  /** Atomic hand-back to open play: clears the script AND the stale freeze
   * (a leftover freeze was silently delaying every restart). */
  private endScript(dwellMs = 300): void {
    this.script = false;
    this.frozenUntil = this.simNow;
    this.nextActionAt = this.simNow + dwellMs;
  }

  private setPiece(kind: SetPiece["kind"], x: number, y: number,
                   attackHome: boolean, ms: number): void {
    this.setpiece = { kind, x, y, attackHome, until: this.simNow + ms };
  }

  private show(label: string, confetti = false, ttl = 1800): void {
    const id = ++this.flashId;
    this.onFlash?.({ id, label, confetti });
    this.later(() => { if (this.flashId === id) this.onFlash?.(null); }, ttl);
  }

  /* ----------------------------------------------------------- spatial query */
  private nearestOpp(toHome: boolean, x: number, y: number): { idx: number; dist: number } {
    const dots = toHome ? this.awayDots : this.homeDots;
    let idx = -1, dist = 1e9;
    dots.forEach((d, i) => {
      if (d.line === "GK") return;
      const dd = Math.hypot(d.x - x, d.y - y);
      if (dd < dist) { dist = dd; idx = i; }
    });
    return { idx, dist };
  }

  /** Locality-first receiver choice: the 8-20m sweet spot wins, forward play
   * is a NUDGE, not a mandate — that's what keeps possession circulating. */
  private pickReceiver(home: boolean, exclude: number | null): number {
    const dots = home ? this.homeDots : this.awayDots;
    const dir = home ? 1 : -1;
    const bx = this.ball.x, by = this.ball.y;
    let best = -1, bestW = -1;
    dots.forEach((d, i) => {
      if (i === exclude || d.line === "GK") return;
      const dist = Math.hypot(d.x - bx, d.y - by);
      if (dist > 38) return;                        // hoofs are a deliberate choice
      const sweet = -Math.abs(dist - 13) * 1.2;     // prefer 8-20m
      const progress = (d.x - bx) * dir * 0.55;     // gentle forward bias
      const marked = Math.max(0, 8 - this.nearestOpp(home, d.x, d.y).dist);
      const w = 20 + sweet + Math.max(-8, progress) - marked * 1.5 + Math.random() * 14;
      if (w > bestW) { bestW = w; best = i; }
    });
    return best < 0 ? 1 : best;
  }

  /* ------------------------------------------------------------- open play */
  private openPlay(now: number): void {
    const bias = this.possession;
    let side: boolean;
    if (this.carrier) side = this.carrier.home;
    else if (this.kickoffSide !== null) {
      // Kick-off: a short backward ground pass, never a hoof.
      side = this.kickoffSide;
      this.kickoffSide = null;
      const dots = side ? this.homeDots : this.awayDots;
      const dir = side ? 1 : -1;
      let best = 1, bd = 1e9;
      dots.forEach((d, i) => {
        if (d.line !== "MID") return;
        const dd = Math.hypot(d.x - this.ball.x, d.y - this.ball.y) + (d.x - this.ball.x) * dir;
        if (dd < bd) { bd = dd; best = i; }
      });
      this.passTo(side, best);
      return;
    } else side = Math.random() < bias;

    // An unpressured carrier with grass ahead drives with the ball.
    if (this.carrier) {
      const c = this.dotOf(this.carrier.home, this.carrier.idx);
      if (c) {
        const pressure = this.nearestOpp(this.carrier.home, c.x, c.y).dist;
        const dir = this.carrier.home ? 1 : -1;
        const space = this.carrier.home ? 96 - c.x : c.x - 4;
        if (pressure > 7 && space > 10 && Math.random() < 0.4) {
          this.dribbleUntil = now + 700 + Math.random() * 600;
          c.tx = c.x + dir * (5 + Math.random() * 6);
          c.ty = clamp(c.y + (Math.random() * 10 - 5), 6, 94);
          this.nextActionAt = this.dribbleUntil;
          return;
        }
      }
    }

    const favoured = side ? bias : 1 - bias;
    // Sloppy give-away (rare — most turnovers are real tackles).
    if (Math.random() > 0.72 + favoured * 0.24 && this.carrier) {
      const near = this.nearestOpp(side, this.ball.x, this.ball.y);
      if (near.idx >= 0) {
        this.carrier = { home: !side, idx: near.idx };
        this.nextActionAt = now + 240 + Math.random() * 300;
        return;
      }
    }

    const roll = Math.random();
    if (roll < 0.08) {
      // The DELIBERATE long ball: a lofted switch to the far flank (capped —
      // nobody plays 60m corner-to-corner diagonals every phase).
      const dots = side ? this.homeDots : this.awayDots;
      let best = -1, bw = -1;
      dots.forEach((d, i) => {
        if (d.line === "GK" || i === this.carrier?.idx) return;
        if (Math.hypot(d.x - this.ball.x, d.y - this.ball.y) > 38) return;
        const w = Math.abs(d.y - this.ball.y) + Math.random() * 8;
        if (w > bw) { bw = w; best = i; }
      });
      if (best >= 0) {
        const d = dots[best];
        this.fly(d.x, d.y, 27, "pass", () => {
          this.carrier = { home: side, idx: best };
          this.nextActionAt = this.simNow + 240 + Math.random() * 320;
        }, { home: side, idx: best }, 0.9);
        return;
      }
    }

    const idx = this.pickReceiver(side, this.carrier?.idx ?? null);
    const d = this.dotOf(side, idx);
    if (!d) return;
    if (roll > 0.88 && d.line === "FWD") {
      // Through ball: slide the runner's target on; the pass finds him.
      const dir = side ? 1 : -1;
      d.tx = clamp(d.x + dir * 9, 4, 96);
      d.ty = clamp(d.y + (Math.random() * 6 - 3), 6, 94);
    }
    this.passTo(side, idx);
  }

  /* A defender within reach wins the ball: pop it loose, collect, go. */
  private tryTackle(now: number, dt: number): void {
    if (!this.carrier || this.flight || this.carry || this.script
        || now < this.frozenUntil) return;
    if (now < this.dribbleUntil - 900) return;
    const c = this.dotOf(this.carrier.home, this.carrier.idx);
    if (!c) return;
    const near = this.nearestOpp(this.carrier.home, c.x, c.y);
    if (near.idx < 0 || near.dist > TACKLE_RANGE) return;
    if (Math.random() > TACKLE_RATE * dt) return;
    const opp = !this.carrier.home;
    const tackler = near.idx;
    const ang = Math.random() * Math.PI * 2;
    const px = clamp(this.ball.x + Math.cos(ang) * 4, 3, 97);
    const py = clamp(this.ball.y + Math.sin(ang) * 4, 3, 97);
    this.fly(px, py, 32, "pass", () => {
      this.carrier = { home: opp, idx: tackler };
      this.nextActionAt = this.simNow + 280 + Math.random() * 260;
    }, undefined, 0.18);
  }

  /* ----------------------------------------------------- event choreography */
  /** Queue an event for choreography. Events play SEQUENTIALLY and fully —
   * a goal celebration is never cut short by the next chance arriving. */
  handleEvent(lastEvent: MatchEvent, evHome: boolean, ours: boolean): void {
    const k = `${lastEvent.minute}-${lastEvent.type}-${lastEvent.scorer_id}-${lastEvent.team}`;
    if (this.seenKeys.has(k)) return;
    this.seenKeys.add(k);
    if (this.seenKeys.size > 400) this.seenKeys.clear();   // bounded
    const t = lastEvent.type ?? "";
    if (!["goal", "chance", "penalty_miss", "red", "yellow", "injury"].includes(t)) return;
    if (!this.simNow) this.simNow = performance.now();
    this.pending.push({ e: lastEvent, evHome, ours });
  }

  private runEvent(lastEvent: MatchEvent, evHome: boolean, ours: boolean): void {
    this.script = true;                      // choreography owns the ball
    const dir = evHome ? 1 : -1;
    const goalMouth = { x: evHome ? 98.5 : 1.5, y: 47 + Math.random() * 6 };
    const boxEdge = { x: evHome ? 84 : 16, y: 32 + Math.random() * 36 };
    const penSpot = { x: evHome ? 88 : 12, y: 50 };
    const gkPos = { x: evHome ? 97 : 3, y: 50 };
    const cornerSpot = { x: evHome ? 99 : 1, y: Math.random() < 0.5 ? 1.5 : 98.5 };
    // Free kicks happen NEAR where play is, drifted toward the attacking third.
    const fkSpot = {
      x: clamp(this.ball.x * 0.45 + (evHome ? 72 : 28) * 0.55 + (Math.random() * 8 - 4),
               evHome ? 55 : 12, evHome ? 88 : 45),
      y: clamp(this.ball.y + (Math.random() * 18 - 9), 14, 86),
    };

    const celebrateGoal = (label: string) => {
      this.bumpScore(evHome);                // scoreboard flips NOW, not early
      this.onGoalShown?.(evHome);
      this.celebrate = { until: this.simNow + CELEBRATE_MS, home: evHome };
      this.show(label, ours, CELEBRATE_MS);
      this.later(() => {
        this.fly(50, 50, 46, "place", () => {
          this.setPiece("kickoff", 50, 50, !evHome, 2700);
          this.later(() => {
            this.kickoffSide = !evHome;
            this.endScript(60);
          }, 2450);
        });
      }, CELEBRATE_MS - 200);
      this.freeze(CELEBRATE_MS + 1200);
    };

    /* Corner: walk the ball over, fill the box, whip it in, defence clears. */
    const playCorner = (after?: () => void) => {
      this.carryTo(evHome, cornerSpot.x, cornerSpot.y, () => {
        this.show("🚩 Corner…", false, 900);
        this.setPiece("corner", cornerSpot.x, cornerSpot.y, evHome, 3400);
        this.hold(1200);
        this.later(() => {
          this.fly(penSpot.x + (Math.random() * 6 - 3), 44 + Math.random() * 12,
                   30, "pass", () => {
            this.fly(boxEdge.x - dir * 14, 20 + Math.random() * 60, 34, "pass", () => {
              this.carrier = null;
              this.endScript();
              after?.();
            }, undefined, 0.5);
          }, undefined, 1.05);
        }, 1300);
      }, this.takerIdx(evHome, "corner"));
    };

    if (lastEvent.type === "goal") {
      const src = lastEvent.source;
      const label =
        src === "penalty" ? `🎯 PENALTY GOAL — ${lastEvent.scorer}`
          : src === "freekick" ? `🚀 FREE KICK GOAL — ${lastEvent.scorer}`
          : `⚽ GOAL — ${lastEvent.scorer}`;
      this.freeze(11000);
      if (src === "penalty") {
        // Whistle → walk the ball to the spot → box clears → strike.
        this.hold(800);
        this.show("🎯 Penalty!", false, 900);
        this.carryTo(evHome, penSpot.x, penSpot.y, () => {
          this.setPiece("pen", penSpot.x, penSpot.y, evHome, 1500);
          this.hold(1300);
          this.later(() => this.fly(goalMouth.x, goalMouth.y, SHOT_SPEED, "shot",
            () => celebrateGoal(label), undefined, 0.2), 1400);
        }, this.takerIdx(evHome, "pen"));
      } else if (src === "freekick") {
        this.hold(700);
        this.carryTo(evHome, fkSpot.x, fkSpot.y, () => {
          this.show(`🚀 Free kick — ${lastEvent.scorer}…`, false, 950);
          this.setPiece("fk", fkSpot.x, fkSpot.y, evHome, 1400);
          this.hold(1200);
          this.later(() => this.fly(goalMouth.x, goalMouth.y, SHOT_SPEED, "shot",
            () => celebrateGoal(label), undefined, 0.45), 1300);
        }, this.takerIdx(evHome, "fk"));
      } else {
        // Open play: walk it in through 2-3 short passes, then the finish.
        this.chainTo(evHome, boxEdge.x, boxEdge.y, () => {
          this.later(() => this.fly(goalMouth.x, goalMouth.y, SHOT_SPEED, "shot",
            () => celebrateGoal(label), undefined, 0.2), 220);
        });
      }
    } else if (lastEvent.type === "penalty_miss") {
      this.freeze(6500);
      this.hold(800);
      this.show("🎯 Penalty!", false, 900);
      this.carryTo(evHome, penSpot.x, penSpot.y, () => {
        this.setPiece("pen", penSpot.x, penSpot.y, evHome, 1500);
        this.hold(1300);
        this.later(() => {
          if (lastEvent.outcome === "saved") {
            this.fly(gkPos.x, gkPos.y, SHOT_SPEED, "shot", () => {
              this.show(`🧤 SAVED! ${lastEvent.scorer} is denied`, false, 1700);
              this.later(() => this.fly(50 - dir * 14, 20 + Math.random() * 60,
                27, "pass", () => {
                  this.carrier = null;
                  this.endScript();
                }, undefined, 0.9), 1100);
            }, undefined, 0.2);
          } else {
            this.fly(evHome ? 99 : 1, Math.random() < 0.5 ? 14 : 86, SHOT_SPEED, "shot", () => {
              this.show(`❌ ${lastEvent.scorer} misses the penalty!`, false, 1700);
              this.later(() => this.goalKick(evHome, gkPos), 1100);
            }, undefined, 0.35);
          }
        }, 1400);
      }, this.takerIdx(evHome, "pen"));
    } else if (lastEvent.type === "chance") {
      const fk = lastEvent.set_piece === "freekick";
      const corner = !fk && lastEvent.outcome !== "missed" && Math.random() < CORNER_CHANCE;
      this.freeze(fk ? 6000 : corner ? 7000 : 4500);
      const resolve = () => {
        if (lastEvent.outcome === "saved") {
          this.fly(gkPos.x, gkPos.y, SHOT_SPEED, "shot", () => {
            if (corner) playCorner();
            else this.later(() => this.fly(50 - dir * 10, 25 + Math.random() * 50,
              30, "pass", () => {
                this.carrier = null;
                this.endScript();
              }, undefined, 0.6), 800);
          }, undefined, 0.2);
        } else if (lastEvent.outcome === "woodwork") {
          this.fly(evHome ? 98.5 : 1.5, Math.random() < 0.5 ? 42 : 58, SHOT_SPEED, "shot", () => {
            if (corner) playCorner();
            else this.fly(boxEdge.x - dir * 8, 30 + Math.random() * 40, 36, "pass",
              () => {
                this.carrier = null;
                this.endScript(250);
              }, undefined, 0.3);
          }, undefined, 0.2);
        } else {
          this.fly(evHome ? 99.5 : 0.5, Math.random() < 0.5 ? 18 : 82, SHOT_SPEED, "shot",
            () => this.later(() => this.goalKick(evHome, gkPos), 700), undefined, 0.3);
        }
      };
      if (fk) {
        this.hold(700);
        this.carryTo(evHome, fkSpot.x, fkSpot.y, () => {
          this.show(`🚀 Free kick — ${lastEvent.scorer}`, false, 950);
          this.setPiece("fk", fkSpot.x, fkSpot.y, evHome, 1400);
          this.hold(1200);
          this.later(resolve, 1300);
        }, this.takerIdx(evHome, "fk"));
      } else {
        // Work it into the box first, then the shot resolves.
        this.chainTo(evHome, boxEdge.x, boxEdge.y, () => this.later(resolve, 200));
      }
    } else if (lastEvent.type === "red" || lastEvent.type === "yellow") {
      const red = lastEvent.type === "red";
      this.killBall();
      this.freeze(red ? 5200 : 3800);
      this.hold(red ? 3400 : 2300);                  // EVERYONE stands still
      this.show(`⚠️ Foul — ${lastEvent.scorer}`, false, 950);
      this.later(() => this.show(
        red
          ? `🟥 RED CARD — ${lastEvent.scorer}${lastEvent.second_yellow ? " (second yellow)" : ""}`
          : `🟨 Booked — ${lastEvent.scorer}`,
        false, red ? 2300 : 1500), 950);
      // The FOULED team restarts with a real free kick: a player walks over,
      // settles, and plays a simple ball out.
      this.later(() => {
        this.carryTo(!evHome, this.ball.x, this.ball.y, () => {
          this.later(() => {
            const side = !evHome;
            this.passTo(side, this.pickReceiver(side, this.carrier?.idx ?? null),
                        () => this.endScript(200));
          }, 500);
        });
      }, red ? 3500 : 2400);
    } else if (lastEvent.type === "injury") {
      this.killBall();
      this.freeze(3400);
      this.hold(2400);
      this.show(`🤕 ${lastEvent.scorer} is down…`, false, 1900);
      this.later(() => {
        this.carryTo(!evHome, this.ball.x, this.ball.y, () => {
          this.later(() => {
            const side = !evHome;
            this.passTo(side, this.pickReceiver(side, this.carrier?.idx ?? null),
                        () => this.endScript(200));
          }, 450);
        });
      }, 2500);
    }
  }

  /** Goal kick: ball placed at the six-yard line, keeper strikes it long. */
  private goalKick(attackHome: boolean, gkPos: { x: number; y: number }): void {
    this.fly(gkPos.x, gkPos.y, PLACE_SPEED, "place", () => {
      this.hold(700);
      this.later(() => {
        const dir = attackHome ? -1 : 1;             // defending side kicks away
        this.fly(50 + dir * 8, 20 + Math.random() * 60, 27, "pass", () => {
          this.carrier = null;
          this.endScript();
        }, undefined, 0.95);
      }, 750);
    });
  }

  /* -------------------------------------------------------------- animation */
  /** Fixed-timestep wrapper: the sim always advances in 1/120s slices, so a
   * dropped frame never integrates a big delta — motion stays deterministic
   * regardless of render framerate. */
  step(now: number, dt: number): void {
    const h = 1 / 120;
    this.acc = Math.min(0.1, this.acc + dt);
    while (this.acc >= h) {
      this.acc -= h;
      this.substep(now - this.acc * 1000, h);
    }
  }

  private substep(now: number, dt: number): void {
    this.simNow = now;
    this.drainQueue(now);
    const b = this.ball;

    // Scripted carry, two phases: the taker walks TO THE BALL first (it sits
    // dead where it is — no lerping across the pitch to his feet), picks it
    // up, then walks it to the spot.
    if (this.carry) {
      const c = this.carry;
      const d = this.dotOf(c.home, c.idx);
      if (d) {
        const hasBall = Math.hypot(d.x - b.x, d.y - b.y) < 1.7;
        d.tx = hasBall ? c.x : b.x;
        d.ty = hasBall ? c.y : b.y;
        if (hasBall && Math.hypot(d.x - c.x, d.y - c.y) < 1.4) {
          const fin = c.done;
          this.carry = null;
          fin();
        }
      } else {
        this.carry = null;
      }
    }

    const fl = this.flight;
    if (fl) {
      let txx = fl.tx, tyy = fl.ty;
      if (fl.toDot) {
        const d = this.dotOf(fl.toDot.home, fl.toDot.idx);
        if (d) { txx = d.x; tyy = d.y; }
      }
      const ex = txx - fl.sx, ey = tyy - fl.sy;
      const est = Math.max(1, Math.hypot(ex, ey));
      const ramp = Math.min(1, 0.45 + fl.prog * 3.2);
      const arrive = fl.kind === "pass"
        ? Math.max(0.45, Math.min(1, ((1 - fl.prog) * est) / 7))
        : 1;
      fl.prog += (fl.speed * ramp * arrive * dt) / est;
      if (fl.prog >= 1) {
        b.x = txx; b.y = tyy; b.lift = 0;
        this.flight = null;
        fl.onLand?.();
      } else {
        const ux = ex / est, uy = ey / est;
        const bowOff = Math.sin(Math.PI * fl.prog) * fl.bow;
        b.x = fl.sx + ux * est * fl.prog - uy * bowOff;
        b.y = fl.sy + uy * est * fl.prog + ux * bowOff;
        b.lift = fl.kind === "place" ? 0
          : fl.kind === "shot" ? Math.sin(Math.PI * fl.prog) * 0.25
          : Math.sin(Math.PI * fl.prog) * fl.liftAmp;
      }
    } else if (this.carrier) {
      const d = this.dotOf(this.carrier.home, this.carrier.idx);
      // A dead ball waits for its carrier — it never zips across the pitch
      // to a distant player's feet (that WAS the corner/free-kick teleport).
      if (d && Math.hypot(d.x - b.x, d.y - b.y) < 4.5) {
        const sp = Math.hypot(d.vx, d.vy);
        const fx = sp > 0.5 ? d.vx / sp : (this.carrier.home ? 1 : -1);
        const fy = sp > 0.5 ? d.vy / sp : 0;
        b.x += (d.x + fx * 1.3 - b.x) * Math.min(1, dt * 10);
        b.y += (d.y + fy * 1.3 - b.y) * Math.min(1, dt * 10);
      }
    }
    if (!this.script && this.pending.length) {
      while (this.pending.length > 1) {       // catch-up: drop stale middles…
        const skipped = this.pending.shift()!;
        if (skipped.e.type === "goal") {      // …but a goal ALWAYS counts
          this.bumpScore(skipped.evHome);
          this.onGoalShown?.(skipped.evHome);
        }
      }
      const next = this.pending.shift()!;
      this.runEvent(next.e, next.evHome, next.ours);
    }
    if (!this.flight && !this.carry && !this.script
        && now > this.frozenUntil && now > this.nextActionAt) {
      this.openPlay(now);
    }
    this.tryTackle(now, dt);

    const celeb = this.celebrate && now < this.celebrate.until ? this.celebrate : null;
    if (this.celebrate && !celeb) this.celebrate = null;
    if (this.setpiece && now > this.setpiece.until) this.setpiece = null;
    const holding = now < this.holdUntil;
    const sp = this.setpiece;
    const possHome = this.carrier ? this.carrier.home : (this.flight ? b.x < 50 : true);
    const inPlay = now > this.frozenUntil;

    const move = (dots: SceneDot[], home: boolean, shape: SceneShape) => {
      const anc = anchors(shape, home);
      const defending = possHome !== home;
      const slide = (b.x - 50) * 0.16 + (defending ? (home ? -3.5 : 3.5) : (home ? 2 : -2));
      const partying = celeb !== null && celeb.home === home;
      const cornerX = celeb?.home ? 88 : 12;

      const cornerMap = sp && sp.kind === "corner"
        ? cornerSlots(dots, home, sp, this.carry?.home === home ? this.carry.idx : -1)
        : null;
      let presser = -1, cover = -1;
      if (defending && inPlay && this.carrier && !holding && !this.script) {
        let bd = 1e9, bd2 = 1e9;
        dots.forEach((d, i) => {
          if (d.line === "GK") return;
          const dd = Math.hypot(d.x - b.x, d.y - b.y);
          if (dd < bd) { bd2 = bd; cover = presser; bd = dd; presser = i; }
          else if (dd < bd2) { bd2 = dd; cover = i; }
        });
        if (bd > PRESS_RADIUS) presser = cover = -1;
      }
      const ownGoalX = home ? 2 : 98;
      const isCarrierTeam = this.carrier?.home === home;
      const isCarryActor = this.carry?.home === home ? this.carry.idx : -1;
      // Set-piece roles: attackers flood the box at corners; a wall forms at
      // free kicks; the box empties for penalties.
      const wallIdx: number[] = [];
      if (sp && sp.kind === "fk" && home !== sp.attackHome) {
        const cands = dots
          .map((d, i) => ({ i, dd: Math.hypot(d.x - sp.x, d.y - sp.y), line: d.line }))
          .filter((c) => c.line !== "GK")
          .sort((a, c) => a.dd - c.dd)
          .slice(0, 3)
          .map((c) => c.i);
        wallIdx.push(...cands);
      }

      dots.forEach((d, i) => {
        const a = anc[i];
        if (!a) return;
        if (partying && a.line !== "GK") {
          d.tx = cornerX + ((i % 4) - 1.5) * 2.6;
          d.ty = 10 + Math.floor(i / 4) * 4 + Math.sin(now / 160 + i) * 1.8;
        } else if (i === isCarryActor) {
          /* the taker keeps the carry target set in substep */
        } else if (cornerMap && cornerMap[i]) {
          // EA-style zone slots: named runners, named watchers (see cornerSlots).
          d.tx = cornerMap[i].x;
          d.ty = cornerMap[i].y;
        } else if (sp && sp.kind === "pen" && a.line !== "GK" && i !== isCarryActor) {
          // Everyone but the taker holds at the edge of the box.
          const edgeX = sp.attackHome ? 78 : 22;
          d.tx = edgeX + ((i % 5) - 2) * 1.6;
          d.ty = 26 + ((i * 9) % 48);
        } else if (wallIdx.includes(i)) {
          // The wall: bodies on the line between ball and goal.
          const gx = home ? 2 : 98;
          const wx = sp!.x + (gx - sp!.x) * 0.28;
          const wy = sp!.y + (50 - sp!.y) * 0.28;
          const k = wallIdx.indexOf(i) - 1;
          d.tx = wx; d.ty = wy + k * 2.1;
        } else if (sp && sp.kind === "kickoff") {
          // Reset for the restart — EVERYONE retreats into their own half
          // (the law of the game; formation anchors alone straddle halfway).
          d.tx = home ? Math.min(a.x, 45) : Math.max(a.x, 55);
          d.ty = a.y;
        } else if (holding) {
          // The whistle: plant the feet NOW (hard velocity kill), stand still.
          d.tx = d.x; d.ty = d.y;
          d.vx *= Math.exp(-9 * dt);
          d.vy *= Math.exp(-9 * dt);
        } else if (a.line === "GK") {
          const threat = Math.abs(b.x - ownGoalX) < 30;
          d.tx = a.x + (threat ? (home ? 1.6 : -1.6) : 0);
          d.ty = threat ? clamp(b.y, 40, 60) : a.y + (b.y - a.y) * 0.06;
        } else if (i === presser) {
          d.tx = b.x; d.ty = b.y;
        } else if (i === cover) {
          d.tx = (b.x + ownGoalX) / 2;
          d.ty = (b.y + 50) / 2;
        } else if (isCarrierTeam && this.carrier && i === this.carrier.idx
                   && now < this.dribbleUntil) {
          /* dribbling target already set in openPlay — keep it */
        } else {
          const pull = PULL[a.line];
          const wob = Math.sin(now / 900 + i * 1.7) * 0.8;
          const compact = defending ? 0.82 : 1.0;
          d.tx = a.x + slide + (b.x - a.x) * pull;
          d.ty = 50 + (a.y - 50) * compact + (b.y - a.y) * pull * 1.5 + wob;
        }

        const dx = d.tx - d.x, dy = d.ty - d.y;
        const dist = Math.hypot(dx, dy);
        const vmax = (partying ? PARTY_SPEED : RUN_SPEED[a.line])
          * (i === presser ? 1.18 : 1) * (dist > 10 ? 1.4 : 1)
          * (i === isCarryActor ? (dist > 26 ? 1.3 : dist > 12 ? 1.05 : 0.72) : 1); // run over, settle, walk the last metres
        const want = Math.min(vmax, dist * 3.2);
        const wvx = dist > 0.01 ? (dx / dist) * want : 0;
        const wvy = dist > 0.01 ? (dy / dist) * want : 0;
        const k = 1 - Math.exp(-(ACCEL / 6) * dt);
        d.vx += (wvx - d.vx) * k;
        d.vy += (wvy - d.vy) * k;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
      });

      const sepStep = Math.min(1, dt * 9);
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const ddx = dots[j].x - dots[i].x, ddy = dots[j].y - dots[i].y;
          const dd = Math.hypot(ddx, ddy);
          if (dd > 0.001 && dd < SEPARATION) {
            const push = ((SEPARATION - dd) / 2) * sepStep;
            const ux = ddx / dd, uy = ddy / dd;
            dots[i].x -= ux * push; dots[i].y -= uy * push;
            dots[j].x += ux * push; dots[j].y += uy * push;
          }
        }
      }
    };
    move(this.homeDots, true, this.homeShape);
    move(this.awayDots, false, this.awayShape);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function shapeChanged(a: SceneShape, b: SceneShape): boolean {
  return a.d !== b.d || a.m !== b.m || a.f !== b.f;
}

/* EA FC-style corner zone slots (FC 26 names its corner roles exactly this
 * way). Attackers: Near Post, Back Post, Target Man (penalty spot), Top of
 * Box, Short Option. Defenders mirror: post watchers on the line, zonal
 * markers, a target shadow and a top-of-box screen. Slots are filled by
 * role preference (forwards first into the box; defenders first on posts). */
function cornerSlots(
  dots: SceneDot[], home: boolean,
  sp: { x: number; y: number; attackHome: boolean },
  excludeIdx: number,
): Record<number, { x: number; y: number }> {
  const atk = home === sp.attackHome;
  const goalX = sp.attackHome ? 98 : 2;
  const inDir = sp.attackHome ? -1 : 1;              // from goal line into the pitch
  const nearY = sp.y < 50 ? 46.4 : 53.6;             // post nearer the flag
  const backY = sp.y < 50 ? 53.6 : 46.4;
  const slots = atk ? [
    { x: goalX + inDir * 4, y: nearY },                       // NEAR-POST runner
    { x: goalX + inDir * 5, y: backY },                       // BACK-POST runner
    { x: goalX + inDir * 11, y: 50 },                         // TARGET MAN
    { x: goalX + inDir * 18, y: 50 + (sp.y < 50 ? 5 : -5) },  // TOP OF BOX
    { x: sp.x + inDir * 7, y: sp.y + (sp.y < 50 ? 6 : -6) },  // SHORT OPTION
  ] : [
    { x: goalX + inDir * 1.5, y: nearY },                     // near-post watcher
    { x: goalX + inDir * 1.5, y: backY },                     // back-post watcher
    { x: goalX + inDir * 5, y: nearY },                       // zonal near
    { x: goalX + inDir * 6, y: backY },                       // zonal back
    { x: goalX + inDir * 10, y: 50 },                         // marks the target
    { x: goalX + inDir * 17, y: 50 },                         // top-of-box screen
  ];
  const pref = (line: SceneLine) =>
    atk ? (line === "FWD" ? 0 : line === "MID" ? 1 : 2)
        : (line === "DEF" ? 0 : line === "MID" ? 1 : 2);
  const out: Record<number, { x: number; y: number }> = {};
  let k = 0;
  dots.map((d, i) => ({ d, i }))
    .filter(({ d, i }) => d.line !== "GK" && i !== excludeIdx)
    .sort((a, b) => pref(a.d.line) - pref(b.d.line))
    .forEach(({ i }) => { if (k < slots.length) out[i] = slots[k++]; });
  return out;
}
