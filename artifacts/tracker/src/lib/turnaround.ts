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

// Text-color utility class (defined in index.css).
export function statusTextColor(status: AlertStatus): string {
  switch (status) {
    case "green":
      return "ageing-green";
    case "yellow":
      return "ageing-amber";
    case "orange":
      return "ageing-orange";
    case "red":
      return "ageing-red";
    default:
      return "ageing-neutral";
  }
}

// Background-color utility class (defined in index.css).
export function statusBgColor(status: AlertStatus): string {
  switch (status) {
    case "green":
      return "bg-ageing-green";
    case "yellow":
      return "bg-ageing-amber";
    case "orange":
      return "bg-ageing-orange";
    case "red":
      return "bg-ageing-red";
    default:
      return "bg-ageing-neutral";
  }
}
