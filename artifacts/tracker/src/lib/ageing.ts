// Ageing display helpers, shared across all views. Ageing itself is computed
// server-side (ageingDays = today - reference date, future clamped to 0, null
// when the reference date is missing). The frontend only formats it and
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

// Pre-production activities: production has not yet begun so the mark ages from
// Assign Date (Last Production Entry Date is always blank at this stage).
// Must mirror PRE_PRODUCTION_ACTIVITIES in parse.ts — update both together.
//   C     = TLT Cutting
//   NTF   = NTLT Non-TLT Fabrication
//   NTFSW = NTLT Non-TLT Fabrication with Stiffener Welding
//   BL    = NTLT Bending/Lapping
export const PRE_PRODUCTION_ACTIVITIES = new Set(["C", "NTF", "NTFSW", "BL"]);

export function isPreProduction(activity: string | null | undefined): boolean {
  return PRE_PRODUCTION_ACTIVITIES.has((activity ?? "").trim().toUpperCase());
}

// Activity "C" (Cutting) means TLT production has genuinely not begun.
// Kept for callers that specifically need to check TLT cutting only.
export function isCutting(activity: string | null | undefined): boolean {
  return (activity ?? "").trim().toUpperCase() === "C";
}

// Active cutting: activity is "C" AND the mark is NOT an unreleased Initial mark.
// A mark is Initial when its Job Card Status is "Initial" (Status-only predicate —
// the "Type" column is NOT checked). Initial marks are already counted as Release
// Balance and must NOT contribute to any Cutting figure.
// Use this predicate everywhere a Cutting BALANCE figure is computed or displayed.
export function isActiveCutting(r: {
  activity?: string | null;
  isInitialCutting?: boolean;
}): boolean {
  return isCutting(r.activity) && !r.isInitialCutting;
}

// Label for a row with no ageing date:
//   pre-production (C, NTF, NTFSW, BL) + no Assign Date -> "Not started"
//   everything else + no Last Production Entry Date      -> "No production date"
export function noDateLabel(activity: string | null | undefined): string {
  return isPreProduction(activity) ? NOT_STARTED_LABEL : NO_PROD_DATE_LABEL;
}

// Cell text for a record's ageing: "12d" when dated, else the no-date label.
export function ageingCell(r: AgeingLike): string {
  return r.ageingDays !== null ? `${r.ageingDays}d` : noDateLabel(r.activity);
}
