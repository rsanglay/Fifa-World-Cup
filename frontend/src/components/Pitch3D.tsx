import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import Confetti from "./Confetti";
import { MatchScene, type SceneFlash, type SceneShape } from "../lib/matchScene";
import type { MatchEvent } from "../types";

/* Pitch3D v2 — the broadcast-style 3D stadium view.
 *
 * The renderer half of the FM-style sim/viewer split: the shared MatchScene
 * model decides where everyone is; this draws it as a floodlit night match.
 *
 * v2 realism: articulated players (swinging arms/legs, lean, arms-up
 * celebrations) rendered as 12 instanced draws, FM-style GOAL REPLAYS from a
 * rolling position buffer (slow-mo, behind-goal cinema camera, letterboxed),
 * UnrealBloom for the floodlight/TV glow, a crowd that leaps when a goal goes
 * in, landing bounces on lofted balls, dugouts, corner flags and a worn pitch.
 *
 * Cameras: 🎬 Director (cuts behind the goal in the final sixth) · 📺
 * Broadcast · 🧑‍💼 Touchline · 🙌 Fan. HD caps pixel ratio at 1.5; ULTRA
 * renders native device pixels (true 4K on a 4K panel).
 */

type CameraMode = "director" | "broadcast" | "touchline" | "fan";
const CAMERA_MODES: { key: CameraMode; label: string }[] = [
  { key: "director", label: "🎬 Director" },
  { key: "broadcast", label: "📺 Broadcast" },
  { key: "touchline", label: "🧑‍💼 Touchline" },
  { key: "fan", label: "🙌 Fan" },
];

const PITCH_L = 105, PITCH_W = 68;
const VIEW_KEY = "wc26_3d_camera";
const QUALITY_KEY = "wc26_3d_quality";
const REPLAY_WINDOW_MS = 4600;     // build-up captured before the goal
const REPLAY_RATE = 0.55;          // slow-mo
const REPLAY_DELAY_MS = 1300;      // let the live celebration breathe first

const toWorld = (xPct: number, yPct: number): [number, number] =>
  [(xPct / 100 - 0.5) * PITCH_L, (yPct / 100 - 0.5) * PITCH_W];

interface Sample { t: number; b: [number, number, number]; h: number[]; a: number[] }

export default function Pitch3D({
  ourShape, oppShape, ourSide, running, lastEvent, homeGoals, awayGoals, possession, scene: match,
}: {
  ourShape: SceneShape;
  oppShape: SceneShape;
  ourSide: "home" | "away";
  running: boolean;
  lastEvent: MatchEvent | null;
  homeGoals: number;
  awayGoals: number;
  possession?: number;
  scene: MatchScene;   // shared with the 2D view via MatchView
}) {
  const homeShape = ourSide === "home" ? ourShape : oppShape;
  const awayShape = ourSide === "away" ? ourShape : oppShape;

  const mountRef = useRef<HTMLDivElement>(null);

  const [flash, setFlash] = useState<SceneFlash | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  const [camMode, setCamMode] = useState<CameraMode>(
    () => (localStorage.getItem(VIEW_KEY) as CameraMode) || "director");
  const [ultra, setUltra] = useState(() => localStorage.getItem(QUALITY_KEY) === "ultra");
  const runningRef = useRef(running);
  runningRef.current = running;
  const camRef = useRef(camMode);
  camRef.current = camMode;

  useEffect(() => { match.onFlash = setFlash; }, [match]);
  useEffect(() => { match.setShapes(homeShape, awayShape); },
    [homeShape.d, homeShape.m, homeShape.f, awayShape.d, awayShape.m, awayShape.f]); // eslint-disable-line
  useEffect(() => { match.possession = possession ?? 0.5; }, [possession]); // eslint-disable-line
  /* ------------------------------------------------------- three.js world */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1124);
    scene.fog = new THREE.Fog(0x0a1124, 160, 340);

    const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 500);
    camera.position.set(0, 26, 46);
    const lookTarget = new THREE.Vector3(0, 0, 0);

    /* post-processing: bloom gives the floodlights + ad boards the TV glow */
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(960, 540), 0.42, 0.55, 0.82);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    /* lighting */
    scene.add(new THREE.HemisphereLight(0x3a4f7a, 0x0c5c2a, 0.85));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.0);
    key.position.set(-45, 70, 38);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    const sc = key.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 60; sc.bottom = -60; sc.far = 220;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.55);
    fill.position.set(50, 50, -40);
    scene.add(fill);

    /* pitch + surrounds */
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_L, PITCH_W),
      new THREE.MeshStandardMaterial({ map: makePitchTexture(renderer), roughness: 0.92 }));
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    scene.add(grass);
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_L + 26, PITCH_W + 22),
      new THREE.MeshStandardMaterial({ color: 0x07561f, roughness: 1 }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.02;
    apron.receiveShadow = true;
    scene.add(apron);

    [-1, 1].forEach((side) => scene.add(makeGoal(side)));
    scene.add(makeAdBoards());
    scene.add(makeCornerFlags());
    scene.add(makeDugouts());
    const { stands, crowd, crowdMat, crowdBaseY, crowdPhase } = makeStadium();
    scene.add(stands);
    scene.add(crowd);
    [[-62, -45], [62, -45], [-62, 45], [62, 45]].forEach(([x, z]) => {
      scene.add(makeFloodlight(x, z));
    });

    /* players + ball */
    const ourIsHome = ourSide === "home";
    const homeKit = ourIsHome ? 0xf5b614 : 0x3d7df0;
    const awayKit = ourIsHome ? 0x3d7df0 : 0xf5b614;
    const homePlayers = makeTeam(homeKit, 0x0a0f1e, 0x2bb673);
    const awayPlayers = makeTeam(awayKit, 0xffffff, 0xc94f7c);
    scene.add(homePlayers.group);
    scene.add(awayPlayers.group);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 20, 16),
      new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.4 }));
    ball.castShadow = true;
    scene.add(ball);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.07, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.85 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    scene.add(ring);

    /* sizing — with adaptive resolution: if the GPU can't hold ~60fps the
     * pixel ratio steps down before the eye sees stutter (and steps back up
     * when there is headroom). The FM26 "Render Scale" lever, automated. */
    let resScale = 1;
    const setSize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight || (w * 9) / 16;
      const wantUltra = localStorage.getItem(QUALITY_KEY) === "ultra";
      const pr = Math.min(window.devicePixelRatio || 1, wantUltra ? 3 : 1.5) * resScale;
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    setSize();
    let frameAvg = 16;
    let perfTick = 0;
    const adaptResolution = (frameMs: number) => {
      frameAvg = frameAvg * 0.95 + frameMs * 0.05;
      if (++perfTick % 90 !== 0) return;
      if (frameAvg > 24 && resScale > 0.55) {
        resScale = Math.max(0.5, resScale - 0.2);
        setSize();
      } else if (frameAvg < 13.5 && resScale < 1) {
        resScale = Math.min(1, resScale + 0.15);
        setSize();
      }
      bloom.enabled = resScale >= 0.75;     // bloom is the priciest pass
    };
    const ro = new ResizeObserver(setSize);
    ro.observe(mount);
    window.addEventListener("resize", setSize);

    /* ------------------------------------------------ replay infrastructure */
    const history: Sample[] = [];
    const record = (now: number) => {
      history.push({
        t: now,
        b: [match.ball.x, match.ball.y, match.ball.lift],
        h: match.homeDots.flatMap((d) => [d.x, d.y]),
        a: match.awayDots.flatMap((d) => [d.x, d.y]),
      });
      while (history.length && now - history[0].t > 9000) history.shift();
    };
    let replay: { frames: Sample[]; clock: number; goalHome: boolean } | null = null;
    let replayPendingAt = 0;
    let wasCelebrating = false;

    /* Time-based playback with linear interpolation between recorded samples
     * — smooth at any recording/playback frame-rate combination. */
    const lerpDots = (a: number[], b: number[], t: number) => {
      const out: { x: number; y: number }[] = [];
      for (let i = 0; i < a.length; i += 2) {
        out.push({ x: a[i] + (b[i] - a[i]) * t, y: a[i + 1] + (b[i + 1] - a[i + 1]) * t });
      }
      return out;
    };
    const replaySample = (r: NonNullable<typeof replay>) => {
      const tNow = r.frames[0].t + r.clock;
      let i = 0;
      while (i < r.frames.length - 2 && r.frames[i + 1].t <= tNow) i++;
      const s0 = r.frames[i], s1 = r.frames[Math.min(i + 1, r.frames.length - 1)];
      const span = Math.max(1, s1.t - s0.t);
      const t = Math.max(0, Math.min(1, (tNow - s0.t) / span));
      return {
        b: [s0.b[0] + (s1.b[0] - s0.b[0]) * t,
            s0.b[1] + (s1.b[1] - s0.b[1]) * t,
            s0.b[2] + (s1.b[2] - s0.b[2]) * t] as [number, number, number],
        h: lerpDots(s0.h, s1.h, t),
        a: lerpDots(s0.a, s1.a, t),
        done: tNow >= r.frames[r.frames.length - 1].t,
        progress: r.clock / Math.max(1, r.frames[r.frames.length - 1].t - r.frames[0].t),
      };
    };

    /* ------------------------------------------------------- camera rigs */
    const camPos = new THREE.Vector3(0, 26, 46);
    const tmp = new THREE.Vector3();
    let directorCut: "wide" | "goalL" | "goalR" = "wide";
    let fov = 46;
    let inCrowdCut = false;        // EA's trick: a crowd shot masks the reset

    const updateCamera = (now: number, dt: number, bx: number, bz: number, inReplay: boolean) => {
      const damp = (k: number) => 1 - Math.exp(-k * dt);
      let target: THREE.Vector3;
      let wantFov: number;
      // Kick-off reset: HARD CUT to a crowd shot (exactly how EA hides the
      // walk-back), then HARD CUT back to the match with teams already reset.
      const kickoffReset = !inReplay && match.deadBall === "kickoff";
      if (kickoffReset) {
        if (!inCrowdCut) {                          // cut IN: no swoop
          inCrowdCut = true;
          camPos.set(14, 7, 6);
          lookTarget.set(-10, 11, 52);
          fov = 34;
        }
        lookTarget.x -= dt * 1.6;                   // slow pan across the fans
        camera.position.copy(camPos);
        camera.lookAt(lookTarget);
        camera.fov = fov;
        camera.updateProjectionMatrix();
        return;
      }
      const justCutBack = inCrowdCut;
      inCrowdCut = false;
      if (inReplay && replay) {
        // Cinema: low behind the goal that was scored at, slow lateral dolly.
        const s = replay.goalHome ? 1 : -1;
        target = tmp.set(s * 61, 4.5, -14 + Math.min(1, replayProgress) * 28);
        camPos.lerp(target, damp(2.2));
        wantFov = 38;
      } else {
        const mode = camRef.current;
        if (mode === "director") {
          if (bx > 36) directorCut = "goalR";
          else if (bx < -36) directorCut = "goalL";
          else if (Math.abs(bx) < 26) directorCut = "wide";
          if (directorCut === "wide") {
            target = tmp.set(bx * 0.55, 24, 44);
          } else {
            const s = directorCut === "goalR" ? 1 : -1;
            target = tmp.set(s * 66, 9, bz * 0.35);
          }
          camPos.lerp(target, justCutBack ? 1 : damp(directorCut === "wide" ? 3.2 : 4.2));
          wantFov = 44;
        } else if (mode === "broadcast") {
          target = tmp.set(bx * 0.55, 26, 46);
          camPos.lerp(target, justCutBack ? 1 : damp(3.4));
          wantFov = 44;
        } else if (mode === "touchline") {
          target = tmp.set(THREE.MathUtils.clamp(bx, -38, 38), 2.1, PITCH_W / 2 + 3.5);
          camPos.lerp(target, justCutBack ? 1 : damp(3.2));
          wantFov = 54;
        } else {
          target = tmp.set(-44 + Math.sin(now / 2300) * 0.6, 17 + Math.sin(now / 3100) * 0.35, 49);
          camPos.lerp(target, justCutBack ? 1 : damp(1.6));
          wantFov = 58;
        }
        if (justCutBack) {
          lookTarget.set(bx, 0.4, bz);
          fov = wantFov;
        }
        if (match.celebrate) wantFov -= 5;          // goal punch-in
      }
      camera.position.copy(camPos);
      lookTarget.lerp(tmp.set(bx, 0.4, bz), damp(4.2));
      camera.lookAt(lookTarget);
      fov += (wantFov - fov) * damp(3);
      camera.fov = fov;
      camera.updateProjectionMatrix();
    };

    /* --------------------------------------------------------- render loop */
    let raf = 0;
    let last = performance.now();
    let prevLift = 0;
    let bounceT = -1, bounceAmp = 0;
    let replayProgress = 0;

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const live = runningRef.current;
      if (live && !replay) match.step(now, dt);
      if (live && !replay) record(now);

      // Goal detected (celebration just started): schedule the replay.
      const celebrating = !!match.celebrate;
      if (celebrating && !wasCelebrating && history.length > 10) {
        replayPendingAt = now + REPLAY_DELAY_MS;
      }
      wasCelebrating = celebrating;
      if (!replay && replayPendingAt > 0 && now >= replayPendingAt) {
        const goalT = replayPendingAt - REPLAY_DELAY_MS;
        const frames = history.filter((s) => s.t >= goalT - REPLAY_WINDOW_MS && s.t <= goalT + 250);
        if (frames.length > 12 && match.celebrate) {
          replay = { frames, clock: 0, goalHome: match.celebrate.home };
          replayProgress = 0;
          homePlayers.resetMotion();
          awayPlayers.resetMotion();
          setReplayOn(true);
        }
        replayPendingAt = 0;
      }

      let bx: number, bz: number;
      if (replay) {
        // Slow-motion, time-interpolated playback from the buffer.
        replay.clock += dt * 1000 * REPLAY_RATE;
        const s = replaySample(replay);
        replayProgress = s.progress;
        const [rbx, rbz] = toWorld(s.b[0], s.b[1]);
        bx = rbx; bz = rbz;
        ball.position.set(rbx, 0.32 + s.b[2] * 7.5, rbz);
        ball.rotation.x += dt * 6;
        ring.visible = false;
        homePlayers.update(s.h, now, dt, false);
        awayPlayers.update(s.a, now, dt, false);
        if (s.done) {
          replay = null;
          setReplayOn(false);
          homePlayers.resetMotion();
          awayPlayers.resetMotion();
        }
      } else {
        const [lbx, lbz] = toWorld(match.ball.x, match.ball.y);
        bx = lbx; bz = lbz;
        // Landing bounce on lofted balls.
        if (prevLift > 0.22 && match.ball.lift === 0) { bounceT = now; bounceAmp = prevLift; }
        prevLift = match.ball.lift;
        let by = 0.32 + match.ball.lift * 7.5;
        if (bounceT > 0) {
          const e = (now - bounceT) / 1000;
          if (e < 0.55) by += Math.abs(Math.sin(e * 14)) * bounceAmp * 2.2 * Math.exp(-e * 5);
          else bounceT = -1;
        }
        ball.position.set(bx, by, bz);
        ball.rotation.x += dt * 9;

        const car = match.carrier;
        if (car) {
          const d = (car.home ? match.homeDots : match.awayDots)[car.idx];
          if (d) {
            const [cx, cz] = toWorld(d.x, d.y);
            ring.visible = true;
            ring.position.set(cx, 0.05, cz);
            (ring.material as THREE.MeshBasicMaterial).color.setHex(
              car.home === ourIsHome ? 0xffe27a : 0xffffff);
          }
        } else {
          ring.visible = false;
        }

        const celeb = match.celebrate;
        homePlayers.update(match.homeDots, now, dt, celeb?.home === true);
        awayPlayers.update(match.awayDots, now, dt, celeb?.home === false);
      }

      // Crowd: leaps during celebrations (direct matrix-y writes, 1 draw call).
      const celebNow = !!match.celebrate || !!replay;
      crowdMat.emissiveIntensity = celebNow ? 0.55 : 0.18;
      if (celebNow) {
        const arr = crowd.instanceMatrix.array as Float32Array;
        for (let i = 0; i < crowdBaseY.length; i++) {
          arr[i * 16 + 13] = crowdBaseY[i] + Math.abs(Math.sin(now / 130 + crowdPhase[i])) * 0.55;
        }
        crowd.instanceMatrix.needsUpdate = true;
      }

      updateCamera(now, dt, bx, bz, !!replay);
      composer.render();
      adaptResolution(dt * 1000);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", setSize);
      composer.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      mount.removeChild(renderer.domElement);
    };
  }, [ourSide]); // eslint-disable-line

  useEffect(() => {
    localStorage.setItem(QUALITY_KEY, ultra ? "ultra" : "hd");
    window.dispatchEvent(new Event("resize"));
  }, [ultra]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, camMode); }, [camMode]);

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "16/9" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {/* replay letterbox + badge */}
      {replayOn && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[9%] bg-black" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[9%] bg-black" />
          <div className="absolute left-3 top-[11%] flex items-center gap-1.5 rounded bg-black/60 px-2 py-0.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            <span className="font-display text-sm tracking-[0.2em] text-white">REPLAY</span>
          </div>
        </>
      )}

      {/* camera + quality controls */}
      {!replayOn && (
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {CAMERA_MODES.map((c) => (
            <button key={c.key} onClick={() => setCamMode(c.key)}
              className={`rounded px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
                camMode === c.key ? "bg-gold text-ink" : "bg-ink/60 text-white/70 hover:bg-ink/80"}`}>
              {c.label}
            </button>
          ))}
          <button onClick={() => setUltra((u) => !u)}
            title="ULTRA renders at native device pixels — true 4K on a 4K display"
            className={`rounded px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
              ultra ? "bg-gold text-ink" : "bg-ink/60 text-white/70 hover:bg-ink/80"}`}>
            {ultra ? "✦ ULTRA" : "HD"}
          </button>
        </div>
      )}

      <div className="absolute right-2 top-2 rounded bg-ink/70 px-2 py-0.5 font-display text-sm tabular-nums text-white/90">
        {homeGoals}:{awayGoals}
      </div>

      {flash?.confetti && <Confetti key={flash.id} pieces={140} />}
      {flash && !replayOn && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className={`rounded-xl px-5 py-2 font-display text-2xl tracking-wide shadow-xl ${
            flash.confetti ? "animate-bounce bg-gold text-ink" : "animate-pulse bg-ink/85 text-gold"}`}>
            {flash.label}
          </div>
        </div>
      )}
      {!running && !flash && !replayOn && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <span className="rounded-lg bg-ink/80 px-4 py-1.5 text-sm font-semibold text-white/80">⏸ Paused</span>
        </div>
      )}
    </div>
  );
}

/* ============================ procedural assets ============================ */

function makePitchTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const W = 2048, H = Math.round(2048 * (PITCH_W / PITCH_L));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 14; i++) {
    g.fillStyle = i % 2 ? "#0c8c3a" : "#0a7d34";
    g.fillRect((i * W) / 14, 0, W / 14 + 1, H);
  }
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.016})`;
    g.fillRect(Math.random() * W, Math.random() * H, 3, 3);
  }
  // worn grass: centre circle and the two goalmouths take a beating
  const wear = (x: number, y: number, rx: number, ry: number, alpha: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, rx);
    grad.addColorStop(0, `rgba(122,109,46,${alpha})`);
    grad.addColorStop(1, "rgba(122,109,46,0)");
    g.fillStyle = grad;
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.translate(-x, -y);
    g.beginPath(); g.arc(x, y, rx, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  const sx = W / PITCH_L, sy = H / PITCH_W;
  wear(W / 2, H / 2, 7 * sx, 5 * sy, 0.16);
  wear(4 * sx, H / 2, 6 * sx, 7 * sy, 0.2);
  wear(W - 4 * sx, H / 2, 6 * sx, 7 * sy, 0.2);

  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.lineWidth = Math.max(2, W / 700);
  const box = (x0: number, w: number, hh: number) => {
    g.strokeRect(x0 * sx, (PITCH_W / 2 - hh) * sy, w * sx, hh * 2 * sy);
  };
  g.strokeRect(0.4 * sx, 0.4 * sy, (PITCH_L - 0.8) * sx, (PITCH_W - 0.8) * sy);
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
  g.beginPath(); g.arc(W / 2, H / 2, 9.15 * sx, 0, Math.PI * 2); g.stroke();
  box(0.4, 16.5, 20.16 / 2 + 5.5);
  box(PITCH_L - 16.9, 16.5, 20.16 / 2 + 5.5);
  box(0.4, 5.5, 9.16 / 2);
  box(PITCH_L - 5.9, 5.5, 9.16 / 2);
  // penalty arcs ("the D") + corner arcs
  g.beginPath(); g.arc(11 * sx, H / 2, 9.15 * sx, -0.94, 0.94); g.stroke();
  g.beginPath(); g.arc((PITCH_L - 11) * sx, H / 2, 9.15 * sx, Math.PI - 0.94, Math.PI + 0.94); g.stroke();
  [[0.4 * sx, 0.4 * sy, 0, Math.PI / 2], [W - 0.4 * sx, 0.4 * sy, Math.PI / 2, Math.PI],
   [0.4 * sx, H - 0.4 * sy, -Math.PI / 2, 0], [W - 0.4 * sx, H - 0.4 * sy, Math.PI, Math.PI * 1.5]]
    .forEach(([x, y, a0, a1]) => {
      g.beginPath(); g.arc(x as number, y as number, 1 * sx, a0 as number, a1 as number); g.stroke();
    });
  const spot = (x: number) => { g.beginPath(); g.arc(x * sx, H / 2, W / 480, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill(); };
  spot(11); spot(PITCH_L - 11); spot(PITCH_L / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function makeBallTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#1a1a1a";
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    g.arc(16 + (i % 3) * 46, 18 + Math.floor(i / 3) * 44, 9, 0, Math.PI * 2);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeGoal(side: number): THREE.Group {
  const goal = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 });
  const x = side * (PITCH_L / 2 + 0.1);
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.44, 8);
  [-3.66, 3.66].forEach((z) => {
    const post = new THREE.Mesh(postGeo, mat);
    post.position.set(x, 1.22, z);
    post.castShadow = true;
    goal.add(post);
  });
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7.32, 8), mat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(x, 2.44, 0);
  bar.castShadow = true;
  goal.add(bar);
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(7.32, 2.6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
  net.rotation.y = Math.PI / 2;
  net.position.set(x + side * 1.3, 1.1, 0);
  goal.add(net);
  return goal;
}

function makeAdBoards(): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 1024, 0);
  grad.addColorStop(0, "#7a1fa2"); grad.addColorStop(0.5, "#1f4ba2"); grad.addColorStop(1, "#a21f56");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "bold 38px system-ui";
  ctx.textBaseline = "middle";
  for (let x = 30; x < 1024; x += 360) ctx.fillText("WORLD CUP 26", x, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  const mat = new THREE.MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5 });
  const mk = (w: number, x: number, z: number, ry: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1, 0.15), mat);
    m.position.set(x, 0.5, z);
    m.rotation.y = ry;
    g.add(m);
  };
  mk(PITCH_L + 8, 0, PITCH_W / 2 + 4.5, 0);
  mk(PITCH_L + 8, 0, -(PITCH_W / 2 + 4.5), 0);
  mk(PITCH_W + 6, PITCH_L / 2 + 7, 0, Math.PI / 2);
  mk(PITCH_W + 6, -(PITCH_L / 2 + 7), 0, Math.PI / 2);
  return g;
}

function makeCornerFlags(): THREE.Group {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 });
  const flagMat = new THREE.MeshBasicMaterial({ color: 0xffd34d, side: THREE.DoubleSide });
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), poleMat);
    pole.position.set(sx * PITCH_L / 2, 0.8, sz * PITCH_W / 2);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), flagMat);
    flag.position.set(sx * PITCH_L / 2 - sx * 0.27, 1.42, sz * PITCH_W / 2);
    g.add(flag);
  });
  return g;
}

function makeDugouts(): THREE.Group {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x182032, roughness: 0.8 });
  const glassM = new THREE.MeshStandardMaterial({
    color: 0x8fb4d8, transparent: true, opacity: 0.25, roughness: 0.1 });
  const benchM = new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.9 });
  [-1, 1].forEach((s) => {
    const x = s * 14;
    const z = PITCH_W / 2 + 6.5;
    const back = new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.15), frame);
    back.position.set(x, 1.1, z + 1.1);
    g.add(back);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(9, 0.12, 2.6), glassM);
    roof.position.set(x, 2.25, z);
    roof.rotation.x = 0.08;
    g.add(roof);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.5, 0.6), benchM);
    bench.position.set(x, 0.45, z + 0.55);
    g.add(bench);
  });
  return g;
}

function makeStadium(): {
  stands: THREE.Group; crowd: THREE.InstancedMesh;
  crowdMat: THREE.MeshStandardMaterial; crowdBaseY: Float32Array; crowdPhase: Float32Array;
} {
  const stands = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1b2438, roughness: 0.95 });
  const defs = [
    { w: PITCH_L + 26, x: 0, z: PITCH_W / 2 + 17, ry: 0 },
    { w: PITCH_L + 26, x: 0, z: -(PITCH_W / 2 + 17), ry: Math.PI },
    { w: PITCH_W + 18, x: PITCH_L / 2 + 19, z: 0, ry: -Math.PI / 2 },
    { w: PITCH_W + 18, x: -(PITCH_L / 2 + 19), z: 0, ry: Math.PI / 2 },
  ];
  defs.forEach((d) => {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(d.w, 14, 22), standMat);
    slab.position.set(d.x, 5.4, d.z);
    slab.rotation.y = d.ry;
    slab.rotation.x = d.ry === 0 ? -0.42 : d.ry === Math.PI ? 0.42 : 0;
    if (d.ry === -Math.PI / 2) slab.rotation.z = -0.42;
    if (d.ry === Math.PI / 2) slab.rotation.z = 0.42;
    stands.add(slab);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(d.w, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x0d1320, roughness: 0.8 }));
    roof.position.set(d.x * 1.06, 14.5, d.z * 1.06);
    roof.rotation.y = d.ry;
    stands.add(roof);
  });

  const crowdMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, emissive: 0x666688, emissiveIntensity: 0.18 });
  const fan = new THREE.BoxGeometry(0.42, 0.55, 0.3);
  const COUNT = 7000;
  const crowd = new THREE.InstancedMesh(fan, crowdMat, COUNT);
  const crowdBaseY = new Float32Array(COUNT);
  const crowdPhase = new Float32Array(COUNT);
  const palette = [0xf5b614, 0x3d7df0, 0xd8d8e6, 0x9aa3b8, 0x713030, 0x2d5a3a, 0xe0e0e0];
  const m4 = new THREE.Matrix4();
  const color = new THREE.Color();
  let i = 0;
  while (i < COUNT) {
    const d = defs[Math.floor(Math.random() * defs.length)];
    const along = Math.random(), depth = Math.random();
    const y = 1.8 + depth * 9.5 + Math.random() * 0.3;
    const off = 8 + depth * 13;
    let x = 0, z = 0;
    if (d.ry === 0) { x = (along - 0.5) * d.w; z = PITCH_W / 2 + off; }
    else if (d.ry === Math.PI) { x = (along - 0.5) * d.w; z = -(PITCH_W / 2 + off); }
    else if (d.ry === -Math.PI / 2) { x = PITCH_L / 2 + off + 2; z = (along - 0.5) * d.w; }
    else { x = -(PITCH_L / 2 + off + 2); z = (along - 0.5) * d.w; }
    m4.makeTranslation(x, y, z);
    crowd.setMatrixAt(i, m4);
    crowdBaseY[i] = y;
    crowdPhase[i] = Math.random() * Math.PI * 2;
    color.setHex(palette[Math.floor(Math.random() * palette.length)]);
    color.multiplyScalar(0.55 + Math.random() * 0.45);
    crowd.setColorAt(i, color);
    i++;
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  return { stands, crowd, crowdMat, crowdBaseY, crowdPhase };
}

function makeFloodlight(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.5, 30, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a3142, roughness: 0.9 }));
  pole.position.set(x, 15, z);
  g.add(pole);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(6, 3.2, 0.8),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xfff7da, emissiveIntensity: 2.6 }));
  head.position.set(x * 0.96, 30, z * 0.96);
  head.lookAt(0, 0, 0);
  g.add(head);
  return g;
}

/* ----------------------- articulated instanced players --------------------
 * Six InstancedMeshes per team (torso, head, left/right leg, left/right arm)
 * = 12 draw calls for all 22 players. Limbs swing with a proper run cycle,
 * bodies lean into velocity, keepers wear their own colour, and a goal sends
 * arms to the sky. The cheap analogue of mocap blending: a state (idle/run/
 * sprint/celebrate) driving procedural joint angles. */
interface Team {
  group: THREE.Group;
  update: (dots: { x: number; y: number }[], now: number, dt: number, partying: boolean) => void;
  resetMotion: () => void;
}

function makeTeam(kitColor: number, shortsColor: number, gkColor: number): Team {
  const N = 16;
  const group = new THREE.Group();
  const jersey = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
  const shorts = new THREE.MeshStandardMaterial({ color: shortsColor, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9956a, roughness: 0.75 });

  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
    const m = new THREE.InstancedMesh(geo, mat, N);
    m.castShadow = shadow;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    return m;
  };
  const torso = mk(new THREE.CapsuleGeometry(0.30, 0.50, 4, 10), jersey);
  const head = mk(new THREE.SphereGeometry(0.22, 10, 8), skin);
  const legL = mk(new THREE.CapsuleGeometry(0.105, 0.55, 4, 8), shorts);
  const legR = mk(new THREE.CapsuleGeometry(0.105, 0.55, 4, 8), shorts);
  const armL = mk(new THREE.CapsuleGeometry(0.08, 0.40, 4, 8), jersey, false);
  const armR = mk(new THREE.CapsuleGeometry(0.08, 0.40, 4, 8), jersey, false);

  // Kit colours per instance (index 0 = the keeper, in his own colour).
  const kit = new THREE.Color(kitColor), gk = new THREE.Color(gkColor);
  for (let i = 0; i < N; i++) {
    const c = i === 0 ? gk : kit;
    torso.setColorAt(i, c);
    armL.setColorAt(i, c);
    armR.setColorAt(i, c);
  }
  [torso, armL, armR].forEach((p) => { if (p.instanceColor) p.instanceColor.needsUpdate = true; });

  // scratch
  const base = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const out = new THREE.Matrix4();
  const t1 = new THREE.Matrix4();
  const t2 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const qLean = new THREE.Quaternion();
  const ONE = new THREE.Vector3(1, 1, 1);
  const Y = new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

  const yaw = new Float32Array(N);
  const phase = new Float32Array(N);
  const prev: { x: number; z: number }[] = Array.from({ length: N }, () => ({ x: 0, z: 0 }));
  let fresh = true;

  /* limb = T(pivot) · R(axis, angle) · T(0, -halfLen, 0) */
  const limb = (mesh: THREE.InstancedMesh, i: number, px: number, py: number,
                axis: THREE.Vector3, angle: number, halfLen: number) => {
    t1.makeTranslation(px, py, 0);
    local.makeRotationAxis(axis, angle);
    t2.makeTranslation(0, -halfLen, 0);
    local.premultiply(t1).multiply(t2);
    out.multiplyMatrices(base, local);
    mesh.setMatrixAt(i, out);
  };

  const update = (dots: { x: number; y: number }[], now: number, dt: number, partying: boolean) => {
    for (let i = 0; i < N; i++) {
      const d = dots[i];
      if (!d) {
        torso.setMatrixAt(i, HIDE); head.setMatrixAt(i, HIDE);
        legL.setMatrixAt(i, HIDE); legR.setMatrixAt(i, HIDE);
        armL.setMatrixAt(i, HIDE); armR.setMatrixAt(i, HIDE);
        continue;
      }
      const [wx, wz] = toWorld(d.x, d.y);
      if (fresh) { prev[i].x = wx; prev[i].z = wz; }
      const vx = (wx - prev[i].x) / Math.max(dt, 1e-3);
      const vz = (wz - prev[i].z) / Math.max(dt, 1e-3);
      prev[i].x = wx; prev[i].z = wz;
      const speed = Math.min(9, Math.hypot(vx, vz));

      if (speed > 0.4) {
        const want = Math.atan2(vx, vz);
        yaw[i] += shortestAngle(want - yaw[i]) * Math.min(1, dt * 8);
      }
      phase[i] += dt * (3.4 + speed * 2.2);
      const stride = partying ? 0.5 : Math.min(0.95, 0.1 + speed * 0.105);
      const swing = Math.sin(phase[i]) * stride;
      const bob = partying
        ? Math.abs(Math.sin(now / 130 + i)) * 0.5
        : Math.abs(Math.sin(phase[i])) * 0.05 * Math.min(1, speed / 2);
      const lean = partying ? 0 : Math.min(0.22, speed * 0.024);

      quat.setFromAxisAngle(Y, yaw[i]);
      qLean.setFromAxisAngle(X, lean);
      quat.multiply(qLean);
      base.compose(pos.set(wx, bob, wz), quat, ONE);

      // torso + head ride the base frame
      local.makeTranslation(0, 1.22, 0);
      out.multiplyMatrices(base, local);
      torso.setMatrixAt(i, out);
      local.makeTranslation(0, 1.92, 0);
      out.multiplyMatrices(base, local);
      head.setMatrixAt(i, out);

      // legs swing opposite each other from the hip
      limb(legL, i, -0.14, 0.95, X, swing, 0.42);
      limb(legR, i, 0.14, 0.95, X, -swing, 0.42);
      // arms counter-swing — or shoot for the sky when the goal goes in
      if (partying) {
        limb(armL, i, -0.40, 1.55, Z, 2.6 + Math.sin(now / 150 + i) * 0.2, 0.30);
        limb(armR, i, 0.40, 1.55, Z, -2.6 - Math.cos(now / 170 + i) * 0.2, 0.30);
      } else {
        limb(armL, i, -0.40, 1.55, X, -swing * 0.75, 0.30);
        limb(armR, i, 0.40, 1.55, X, swing * 0.75, 0.30);
      }
    }
    fresh = false;
    [torso, head, legL, legR, armL, armR].forEach((p) => {
      p.instanceMatrix.needsUpdate = true;
    });
  };

  const resetMotion = () => { fresh = true; };
  return { group, update, resetMotion };
}

function shortestAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
