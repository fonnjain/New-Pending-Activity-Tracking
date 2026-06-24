import type { AlertStatus } from "@workspace/domain";

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
