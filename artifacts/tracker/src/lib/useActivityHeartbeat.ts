import { useEffect, useRef } from "react";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — must match server constant
const BEAT_INTERVAL_MS = 60_000;        // send heartbeat every 60 s when active

/**
 * Monitors user activity events (mouse, keyboard, scroll, touch).
 * Sends a heartbeat ping to POST /api/auth/heartbeat every 60 seconds
 * while the user is active. Stops sending when the user has been idle
 * for >= 5 minutes. The server handles session splitting on the idle gap.
 *
 * Mount this hook only when the user is authenticated.
 */
export function useActivityHeartbeat(): void {
  const lastActivityRef = useRef<number>(Date.now());
  const lastBeatRef     = useRef<number>(0);

  useEffect(() => {
    const EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"] as const;

    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };

    for (const evt of EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    const sendBeat = () => {
      fetch("/api/auth/heartbeat", {
        method: "POST",
        credentials: "include",
      }).catch(() => {
        // fire-and-forget — ignore network errors
      });
      lastBeatRef.current = Date.now();
    };

    // Send an immediate beat when mounting (user just opened / navigated to the app)
    sendBeat();

    const interval = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle < IDLE_TIMEOUT_MS) {
        sendBeat();
      }
      // If user has been idle >= 5 min we simply skip this beat.
      // When they become active again and the next interval fires,
      // the server will detect the gap and split the session.
    }, BEAT_INTERVAL_MS);

    return () => {
      for (const evt of EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
      clearInterval(interval);
    };
  }, []);
}
