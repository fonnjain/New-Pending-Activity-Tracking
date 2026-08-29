import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageHeartbeatTracker,
  type UsageHeartbeatEnvironment,
  USAGE_INTERACTION_EVENTS,
} from "./usage-tracking";

test("sustained keyboard activity keeps browser heartbeats busy", () => {
  let now = 0;
  let heartbeatInterval: (() => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  const interactionListeners = new Map<string, () => void>();
  const heartbeats: Array<{ state: string; pagePath: string }> = [];

  const environment: UsageHeartbeatEnvironment = {
    now: () => now,
    isVisible: () => true,
    addInteractionListener: (event, listener) => {
      interactionListeners.set(event, listener);
    },
    removeInteractionListener: (event) => {
      interactionListeners.delete(event);
    },
    addVisibilityChangeListener: (listener) => {
      visibilityListener = listener;
    },
    removeVisibilityChangeListener: () => {
      visibilityListener = null;
    },
    setInterval: (listener, delay) => {
      assert.equal(delay, 60_000);
      heartbeatInterval = listener;
      return 1;
    },
    clearInterval: (interval) => {
      assert.equal(interval, 1);
      heartbeatInterval = null;
    },
    sendHeartbeat: (state, pagePath) => {
      heartbeats.push({ state, pagePath });
    },
    recordVisibility: () => undefined,
  };

  const stop = createUsageHeartbeatTracker(() => "/data", environment);
  const keydown = interactionListeners.get("keydown");
  assert.ok(keydown, "Keyboard input must register as interaction");
  assert.ok(visibilityListener, "Visibility listener must be registered");
  assert.ok(heartbeatInterval, "Heartbeat interval must be registered");

  // Without keydown updating the interaction time, the heartbeat at 120
  // seconds would become idle because the 90-second recency window expired.
  for (const elapsed of [60_000, 120_000, 180_000]) {
    now = elapsed;
    keydown();
    heartbeatInterval!();
  }
  assert.deepEqual(
    heartbeats,
    [
      { state: "busy", pagePath: "/data" },
      { state: "busy", pagePath: "/data" },
      { state: "busy", pagePath: "/data" },
      { state: "busy", pagePath: "/data" },
    ],
  );
  assert.ok(USAGE_INTERACTION_EVENTS.includes("input"));

  stop();
  assert.equal(heartbeatInterval, null);
  assert.equal(visibilityListener, null);
  assert.equal(interactionListeners.size, 0);
});