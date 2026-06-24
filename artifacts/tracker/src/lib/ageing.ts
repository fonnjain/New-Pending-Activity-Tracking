// Ageing display helpers, shared across all views. Ageing itself is computed
// server-side (ageingDays = today - Last Production Entry Date, future clamped
// to 0, null when there is no production date). The frontend only formats it and
// classifies the no-date rows by activity.

export const AGEING_BUCKETS = ["0-30", "31-60", "60+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const NOT_STARTED_LABEL = "Not started";
export const NO_PROD_DATE_LABEL = "No production date";
export const NO_AGEING_LABEL = "No ageing date";

// Minimal shape needed to format/classify ageing on a record.
export interface AgeingLike {
  ageingDays: number | null;
  activity: string | null;
}

export function ageingBucket(days: number): AgeingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  return "60+";
}

// Activity "C" (Cutting) means production has genuinely not begun.
export function isCutting(activity: string | null | undefined): boolean {
  return (activity ?? "").trim().toUpperCase() === "C";
}

// Label for a row with no ageing (blank production date): "Not started" at
// activity C (production not begun), else "No production date" (the mark has
// progressed past cutting but the date is missing — a data-quality state).
export function noDateLabel(activity: string | null | undefined): string {
  return isCutting(activity) ? NOT_STARTED_LABEL : NO_PROD_DATE_LABEL;
}

// Cell text for a record's ageing: "12d" when dated, else the no-date label.
export function ageingCell(r: AgeingLike): string {
  return r.ageingDays !== null ? `${r.ageingDays}d` : noDateLabel(r.activity);
}
