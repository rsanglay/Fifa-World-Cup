import { useCallback, useEffect, useReducer, useRef } from "react";
import { manageLiveWsUrl } from "../api/client";
import type { ChainEvent, LiveFrame, LiveSnapshot, ManagedState } from "../types";

/* WebSocket client for /ws/manage/live/{sessionId}.
 *
 * The server pushes one frame per game-minute (500ms at 1x). Frames land in a
 * useReducer so each arrival is a single O(1) merge — no cascading setState.
 * On drop we retry with exponential backoff (1s, 2s, 4s, 8s, 16s — max 5
 * attempts); the engine keeps the session alive for 30 minutes server-side.
 */

const MAX_RETRIES = 5;

export interface LiveSocketState {
  frame: LiveFrame | null;
  snapshot: LiveSnapshot | null;
  feed: ChainEvent[];          // headline events, newest first
  finalState: ManagedState | null;
  lastError: string | null;
  attempts: number;            // current reconnect attempt (0 = healthy)
  connected: boolean;
  failed: boolean;             // gave up after MAX_RETRIES
}

type Action =
  | { type: "frame"; frame: LiveFrame }
  | { type: "status"; connected: boolean; attempts: number; failed?: boolean }
  | { type: "error"; message: string }
  | { type: "reset" };

const initial: LiveSocketState = {
  frame: null, snapshot: null, feed: [], finalState: null,
  lastError: null, attempts: 0, connected: false, failed: false,
};

const HEADLINE = new Set(["goal", "yellow", "red", "sub", "injury", "tactic",
  "chance", "penalty_miss", "pens", "OPP_TACTICAL_CHANGE"]);

function reducer(s: LiveSocketState, a: Action): LiveSocketState {
  switch (a.type) {
    case "frame": {
      const f = a.frame;
      if (f.type === "error") return { ...s, lastError: f.message || "refused" };
      const fresh = (f.events || []).filter(
        (e) => HEADLINE.has(e.type as string) && e.type !== "OPP_TACTICAL_CHANGE");
      const opp = (f.events || []).filter((e) => e.type === "OPP_TACTICAL_CHANGE");
      const feed = fresh.length || opp.length
        ? [...[...fresh, ...opp].reverse(), ...s.feed].slice(0, 120)
        : s.feed;
      return {
        ...s, frame: f, snapshot: f.snapshot ?? s.snapshot, feed,
        finalState: f.state ?? s.finalState, lastError: null,
      };
    }
    case "status":
      return { ...s, connected: a.connected, attempts: a.attempts, failed: !!a.failed };
    case "error":
      return { ...s, lastError: a.message };
    case "reset":
      return initial;
  }
}

export function useLiveSocket(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const retries = useRef(0);
  const closedByUs = useRef(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    if (!sessionId) return;
    dispatch({ type: "reset" });
    closedByUs.current = false;
    retries.current = 0;

    const connect = () => {
      const ws = new WebSocket(manageLiveWsUrl(sessionId));
      wsRef.current = ws;
      ws.onopen = () => {
        retries.current = 0;
        dispatch({ type: "status", connected: true, attempts: 0 });
      };
      ws.onmessage = (e) => {
        try { dispatch({ type: "frame", frame: JSON.parse(e.data) }); }
        catch { /* malformed frame: skip */ }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUs.current) return;
        if (retries.current >= MAX_RETRIES) {
          dispatch({ type: "status", connected: false, attempts: retries.current, failed: true });
          return;
        }
        retries.current += 1;
        dispatch({ type: "status", connected: false, attempts: retries.current });
        timer.current = window.setTimeout(connect, 1000 * 2 ** (retries.current - 1));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    };
    connect();

    return () => {
      closedByUs.current = true;
      window.clearTimeout(timer.current);
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [sessionId]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return {
    ...state,
    send,
    readyState: wsRef.current?.readyState ?? WebSocket.CLOSED,
  };
}
