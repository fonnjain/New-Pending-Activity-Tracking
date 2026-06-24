import type { AlertStatus, LifecycleStatus } from "@workspace/domain";
import { LIFECYCLE_ORDER } from "@workspace/domain";

// Turnaround alert presentation helpers. The classification itself lives in
// @workspace/domain (alertStatus); this is the display layer only.

export const ALERT_STATUSES: AlertStatus[] = [
  "green",
  "yellow",
  "orange",
  "red",
  "na",
];

export const ALERT_LABELS: Record<AlertStatus, string> = {
  green: "On target",
  yellow: "Slightly over",
  orange: "Over target",
  red: "Critical",
  na: "N/A",
};

// Text-color utility class (defined in index.css). Status palette:
// green stays green, yellow renders light blue, orange grey, red black,
// na a faded slate. Independent of the fixed ageing scale.
export function statusTextColor(status: AlertStatus): string {
  switch (status) {
    case "green":
      return "status-green";
    case "yellow":
      return "status-yellow";
    case "orange":
      return "status-orange";
    case "red":
      return "status-red";
    default:
      return "status-na";
  }
}

// Background-color utility class (defined in index.css).
export function statusBgColor(status: AlertStatus): string {
  switch (status) {
    case "green":
      return "bg-status-green";
    case "yellow":
      return "bg-status-yellow";
    case "orange":
      return "bg-status-orange";
    case "red":
      return "bg-status-red";
    default:
      return "bg-status-na";
  }
}

// ---------------------------------------------------------------------------
// Lifecycle ladder (8 states) — proactive pre-warning + reactive breach phases.
// Display layer only; classification lives in @workspace/domain (lifecycleStatus).
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATUSES: LifecycleStatus[] = LIFECYCLE_ORDER;

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  green: "On track",
  prewarn1: "Pre-warning 1",
  prewarn2: "Pre-warning 2",
  prewarn3: "Pre-warning 3",
  breach1: "Breach 1",
  breach2: "Breach 2",
  breach3: "Breach 3",
  na: "N/A",
};

// Short legend descriptions distinguishing pre-warning (within target) from
// breach (over target).
export const LIFECYCLE_DESCRIPTIONS: Record<LifecycleStatus, string> = {
  green: "Within target, plenty of time",
  prewarn1: "Approaching target",
  prewarn2: "Close to target",
  prewarn3: "About to breach",
  breach1: "Over target",
  breach2: "Well over target",
  breach3: "Critically over target",
  na: "No target or no production date",
};

export const LIFECYCLE_IS_PREWARN: Record<LifecycleStatus, boolean> = {
  green: false,
  prewarn1: true,
  prewarn2: true,
  prewarn3: true,
  breach1: false,
  breach2: false,
  breach3: false,
  na: false,
};

export const LIFECYCLE_IS_BREACH: Record<LifecycleStatus, boolean> = {
  green: false,
  prewarn1: false,
  prewarn2: false,
  prewarn3: false,
  breach1: true,
  breach2: true,
  breach3: true,
  na: false,
};

// Text-color utility class (defined in index.css, `.lc-*`).
export function lifecycleTextColor(status: LifecycleStatus): string {
  return `lc-${status}`;
}

// Background-color utility class (defined in index.css, `.bg-lc-*`).
export function lifecycleBgColor(status: LifecycleStatus): string {
  return `bg-lc-${status}`;
}
