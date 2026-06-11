import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Pitch2D from "./Pitch2D";
import { crowd, isMuted, setMuted, sound } from "../lib/sound";
import { MatchScene, type SceneShape } from "../lib/matchScene";
import type { MatchEvent } from "../types";

// Three.js (~160KB gzip) loads only when someone actually presses 3D.
const Pitch3D = lazy(() => import("./Pitch3D"));

const DIM_KEY = "wc26_view_dim";

export interface MatchViewProps {
  ourShape: SceneShape;
  oppShape: SceneShape;
  ourSide: "home" | "away";
  running: boolean;
  lastEvent: MatchEvent | null;
  /** FULL event list from the server — every event is choreographed in
   * order; a goal can never be masked by a card in the same tick. */
  events?: MatchEvent[];
  homeTeam?: string;
  homeGoals: number;
  awayGoals: number;
  possession?: number;
  /** Presentation score feed — fires when a goal is SHOWN, so headers can
   * stay in sync with the pitch instead of spoiling it. */
  onShownScore?: (home: number, away: number) => void;
}

/* The match viewport: classic 2D dots or the 3D stadium, one click apart.
 * Both are pure renderers of the same MatchScene model — switching views can
 * never change what happens. This wrapper also owns the stadium ATMOSPHERE:
 * a procedural crowd that murmurs through play, gasps at chances, groans at
 * cards and erupts for goals. */
export default function MatchView(props: MatchViewProps) {
  const [dim, setDim] = useState<"2d" | "3d">(
    () => (localStorage.getItem(DIM_KEY) as "2d" | "3d") || "2d");
  const [mute, setMute] = useState(isMuted());
  const eventKey = useRef("");
  const pick = (d: "2d" | "3d") => { setDim(d); localStorage.setItem(DIM_KEY, d); };

  // ONE shared scene for both renderers: switching 2D/3D never resets play,
  // and the scoreboard everywhere shows the PRESENTATION score (goals count
  // when the ball hits the net, not when the server whispers them early).
  const sceneRef = useRef<MatchScene>();
  if (!sceneRef.current) sceneRef.current = new MatchScene();
  const scene = sceneRef.current;
  const [shown, setShown] = useState({ h: props.homeGoals, a: props.awayGoals });
  const cbRef = useRef(props.onShownScore);
  cbRef.current = props.onShownScore;
  useEffect(() => {
    scene.initScore(props.homeGoals, props.awayGoals);
    scene.onScore = (h, a) => { setShown({ h, a }); cbRef.current?.(h, a); };
    scene.onGoalShown = () => { sound.goal(); crowd.roar(); };
    return () => scene.dispose();
  }, []); // eslint-disable-line

  // Feed EVERY server event into the choreography queue (set-deduped).
  useEffect(() => {
    if (!props.events || !props.homeTeam) return;
    for (const e of props.events) {
      const evHome = e.team === props.homeTeam;
      scene.handleEvent(e, evHome, evHome === (props.ourSide === "home"));
    }
  }, [props.events, props.homeTeam]); // eslint-disable-line

  // Ambient crowd while a match view is mounted.
  useEffect(() => {
    if (!mute) crowd.start();
    return () => crowd.stop();
  }, [mute]);

  // Crowd reactions (deduped — snapshots resend the same trailing event).
  useEffect(() => {
    const e = props.lastEvent;
    if (!e) return;
    const k = `${e.minute}-${e.type}-${e.scorer_id}-${e.team}`;
    if (k === eventKey.current) return;
    eventKey.current = k;
    if (e.type === "chance" || e.type === "penalty_miss") crowd.excite(1);
    else if (e.type === "red" || e.type === "injury") crowd.groan();
    else if (e.type === "yellow") crowd.excite(0.4);
  }, [props.lastEvent]);

  const toggleMute = () => {
    const next = !mute;
    setMuted(next);
    setMute(next);
    if (next) crowd.stop();
    else crowd.start();
  };

  return (
    <div className="relative">
      {dim === "3d" ? (
        <Suspense fallback={
          <div className="flex w-full items-center justify-center rounded-2xl border border-white/10 bg-ink/60"
            style={{ aspectRatio: "16/9" }}>
            <span className="animate-pulse font-display text-lg text-white/60">
              Building the stadium…
            </span>
          </div>
        }>
          <Pitch3D {...props} scene={scene} homeGoals={shown.h} awayGoals={shown.a} />
        </Suspense>
      ) : (
        <Pitch2D {...props} scene={scene} homeGoals={shown.h} awayGoals={shown.a} />
      )}
      <div className="absolute bottom-2 left-2 z-10 flex gap-1">
        {(["2d", "3d"] as const).map((d) => (
          <button key={d} onClick={() => pick(d)}
            className={`rounded px-2 py-0.5 text-[10px] font-bold backdrop-blur ${
              dim === d ? "bg-gold text-ink" : "bg-ink/60 text-white/60 hover:bg-ink/80"}`}>
            {d === "2d" ? "2D" : "🏟 3D"}
          </button>
        ))}
        <button onClick={toggleMute} title="Crowd + effects"
          className="rounded bg-ink/60 px-2 py-0.5 text-[10px] font-bold text-white/60 backdrop-blur hover:bg-ink/80">
          {mute ? "🔇" : "🔊"}
        </button>
      </div>
    </div>
  );
}
