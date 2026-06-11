import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LiveFrame, PlayerPos } from "../../types";

/* 3D broadcast view — Three.js.
 *
 * Camera: perspective at (0, 35, 55) looking at the centre spot, FOV 55°
 * (broadcast sideline angle). It slowly auto-pans to track the ball's X
 * (lerp 0.02 per frame). A goal triggers a 2-second cinematic zoom to the
 * goalmouth before cutting back. OrbitControls are bounded to the stadium
 * (maxPolarAngle π/2.2, maxDistance 80) so you can look but never clip
 * underground or fly away. */

const PITCH_W = 105;
const PITCH_H = 68;
const toWorld = (x: number, y: number): [number, number] =>
  [(x - 50) * (PITCH_W / 100), (y - 50) * (PITCH_H / 100)];

const TEAM_COLOURS: Record<string, number> = {
  BRA: 0xffd700, ARG: 0x75aadb, FRA: 0x1f4fa3, GER: 0x222222,
  ESP: 0xc60b1e, ENG: 0xcf081f, POR: 0x046a38, NED: 0xff7f00,
  MEX: 0x006847, USA: 0x3c3b6e, CAN: 0xd80621, ITA: 0x008c45,
};

function ballTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#111111";
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      g.beginPath();
      g.arc(16 + i * 26 + (j % 2) * 12, 22 + j * 40, 9, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function pitchMarkings(): THREE.LineSegments {
  const pts: number[] = [];
  const seg = (x1: number, z1: number, x2: number, z2: number) =>
    pts.push(x1, 0.02, z1, x2, 0.02, z2);
  const W = PITCH_W / 2, H = PITCH_H / 2;
  // boundary
  seg(-W, -H, W, -H); seg(W, -H, W, H); seg(W, H, -W, H); seg(-W, H, -W, -H);
  // halfway
  seg(0, -H, 0, H);
  // centre circle
  const R = 9.15, N = 48;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, b = ((i + 1) / N) * Math.PI * 2;
    seg(Math.cos(a) * R, Math.sin(a) * R, Math.cos(b) * R, Math.sin(b) * R);
  }
  // penalty + six-yard boxes
  for (const side of [-1, 1]) {
    const gx = side * W;
    seg(gx, -20.16, gx - side * 16.5, -20.16);
    seg(gx - side * 16.5, -20.16, gx - side * 16.5, 20.16);
    seg(gx - side * 16.5, 20.16, gx, 20.16);
    seg(gx, -9.16, gx - side * 5.5, -9.16);
    seg(gx - side * 5.5, -9.16, gx - side * 5.5, 9.16);
    seg(gx - side * 5.5, 9.16, gx, 9.16);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(
    geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
}

export default function LivePitch3D({
  frame, away, running,
}: {
  frame: LiveFrame;
  away: string;
  running: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const targets = useRef<{ players: Map<string, [number, number]>; ball: [number, number] }>(
    { players: new Map(), ball: [0, 0] });
  const goalCue = useRef<{ at: number; x: number } | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;

  // Push each frame's positions into the animation targets.
  useEffect(() => {
    const m = new Map<string, [number, number]>();
    (frame.player_positions || []).forEach((p: PlayerPos) => m.set(p.player_id, toWorld(p.x, p.y)));
    targets.current.players = m;
    targets.current.ball = toWorld(frame.ball_xy?.[0] ?? 50, frame.ball_xy?.[1] ?? 50);
    const goal = (frame.events || []).find((e) => e.type === "GOAL");
    if (goal) goalCue.current = { at: performance.now(), x: toWorld(goal.x ?? 50, 50)[0] };
  }, [frame]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
    scene.fog = new THREE.Fog(0x0d1117, 120, 220);

    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
    camera.position.set(0, 35, 55);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.maxPolarAngle = Math.PI / 2.2;
    controls.maxDistance = 80;
    controls.minDistance = 15;
    controls.enableDamping = true;

    // lights
    scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x14491f, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(40, 70, 30);
    scene.add(sun);

    // pitch
    const turf = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_W + 8, PITCH_H + 8),
      new THREE.MeshLambertMaterial({ color: 0x1a5c2a }));
    turf.rotation.x = -Math.PI / 2;
    scene.add(turf);
    scene.add(pitchMarkings());

    // goals (simple white frames)
    for (const side of [-1, 1]) {
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7.4), frameMat);
      bar.position.set(side * PITCH_W / 2, 2.44, 0);
      scene.add(bar);
      for (const z of [-3.66, 3.66]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.44, 0.3), frameMat);
        post.position.set(side * PITCH_W / 2, 1.22, z);
        scene.add(post);
      }
    }

    // players: CylinderGeometry(0.5, 0.5, 1.8) + team-coloured Lambert
    const meshes = new Map<string, THREE.Mesh>();
    const playerGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.8, 12);
    const homeMat = new THREE.MeshLambertMaterial({ color: 0xf0f6fc });
    const awayMat = new THREE.MeshLambertMaterial({ color: TEAM_COLOURS[away] ?? 0xd04a4a });
    const gkMat = new THREE.MeshLambertMaterial({ color: 0x00d4aa });

    // ball: SphereGeometry(0.35) with the canvas panel texture
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 24, 16),
      new THREE.MeshLambertMaterial({ map: ballTexture() }));
    ball.position.set(0, 0.35, 0);
    scene.add(ball);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight || (w * 9) / 16;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const basePos = new THREE.Vector3(0, 35, 55);
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = targets.current;

      // sync player meshes with the live roster
      t.players.forEach((pos, id) => {
        let mesh = meshes.get(id);
        if (!mesh) {
          const info = latestPositions.current.find((p) => p.player_id === id);
          const mat = info?.role === "GK" ? gkMat
            : info?.team === "home" ? homeMat : awayMat;
          mesh = new THREE.Mesh(playerGeo, mat);
          meshes.set(id, mesh);
          mesh.position.set(pos[0], 0.9, pos[1]);
          scene.add(mesh);
        }
        mesh.userData.tx = pos[0];
        mesh.userData.tz = pos[1];
      });
      meshes.forEach((mesh, id) => {
        if (!t.players.has(id)) {           // subbed off / sent off
          scene.remove(mesh);
          meshes.delete(id);
          return;
        }
        mesh.position.x += (mesh.userData.tx - mesh.position.x) * 0.08;
        mesh.position.z += (mesh.userData.tz - mesh.position.z) * 0.08;
      });

      // ball glide + a little roll
      ball.position.x += (t.ball[0] - ball.position.x) * 0.12;
      ball.position.z += (t.ball[1] - ball.position.z) * 0.12;
      ball.rotation.z -= 0.15;

      // camera: goal cinematic beats auto-pan
      const cue = goalCue.current;
      if (cue && performance.now() - cue.at < 2000) {
        const k = 0.06;
        camera.position.x += (cue.x - camera.position.x) * k;
        camera.position.y += (5 - camera.position.y) * k;
        camera.position.z += (10 - camera.position.z) * k;
        camera.lookAt(cue.x, 1.2, 0);
      } else {
        if (cue) goalCue.current = null;     // cut back to broadcast
        camera.position.x += (ball.position.x * 0.6 - camera.position.x) * 0.02;
        camera.position.y += (basePos.y - camera.position.y) * 0.03;
        camera.position.z += (basePos.z - camera.position.z) * 0.03;
        controls.update();
      }

      renderer.render(scene, camera);
    };

    animate();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [away]);

  // Keep a ref of the latest positions for side lookup inside the GL loop.
  const latestPositions = useRef<PlayerPos[]>([]);
  useEffect(() => { latestPositions.current = frame.player_positions || []; }, [frame]);

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ aspectRatio: "16/9" }}>
      <div ref={mountRef} className="absolute inset-0" aria-label="3D stadium view" />
      {!running && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
          <span className="rounded-full bg-ink/80 px-4 py-1.5 text-sm font-semibold text-txt-primary/80">⏸ Paused</span>
        </div>
      )}
    </div>
  );
}
