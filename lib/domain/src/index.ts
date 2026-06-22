// Canonical process-step sequence for steel-fabrication activities.
//
// This is the SINGLE SOURCE OF TRUTH for how activities are ordered everywhere
// in the app (dropdowns, dashboard cards, ageing tables, reports, exports, chart
// legends, AI validation). Do not define a second order list anywhere else —
// import from here instead.
//
// Order is intentional: W -> Q -> TS (Quality before Tee Stock). HG (Grinding)
// sits at position 6 even though it is seldom populated.
export const PROCESS_SEQUENCE = [
  "C",
  "RFI",
  "NH",
  "B",
  "HAB",
  "HG",
  "W",
  "Q",
  "TS",
  "G",
  "GB",
  "Y",
] as const;

export type ProcessStep = (typeof PROCESS_SEQUENCE)[number];

// Human-readable labels for tooltips / reference only. NOT used for ordering and
// NOT a substitute for the Activity value read from the file.
export const PROCESS_STEP_LABELS: Record<ProcessStep, string> = {
  C: "Cutting",
  RFI: "Ready for Inspection",
  NH: "Notching / Hole",
  B: "Bending",
  HAB: "Heat / Assembly-Bending",
  HG: "Grinding",
  W: "Welding",
  Q: "Quality",
  TS: "Tee Stock",
  G: "Galvanizing",
  GB: "Galvanizing & Bundle",
  Y: "Yard",
};

// Normalize an activity code for matching only (trim + uppercase). Used for
// case-insensitive comparison so "Hab"/"HAB" rank the same. The original value
// is always preserved for display.
export function normalizeActivity(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

const RANK_BY_CODE = new Map<string, number>(
  PROCESS_SEQUENCE.map((code, index) => [code, index]),
);

// Index of a code within PROCESS_SEQUENCE (case-insensitive). Unknown codes
// return a rank greater than every known step, so they always sort to the end.
export function activityRank(code: string | null | undefined): number {
  const rank = RANK_BY_CODE.get(normalizeActivity(code));
  return rank === undefined ? PROCESS_SEQUENCE.length : rank;
}

// Whether a code is one of the canonical process steps (case-insensitive).
export function isKnownActivity(code: string | null | undefined): boolean {
  return RANK_BY_CODE.has(normalizeActivity(code));
}

// Comparator: known codes by sequence rank; unknown codes after, ordered
// alphabetically among themselves. Never drops anything.
export function compareActivity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const rankDelta = activityRank(a) - activityRank(b);
  if (rankDelta !== 0) return rankDelta;
  // Equal rank => both unknown (or the same code); break ties alphabetically.
  return normalizeActivity(a).localeCompare(normalizeActivity(b));
}

// Sort a list of activity codes by the canonical order. Returns a new array.
export function sortActivities<T extends string | null | undefined>(codes: T[]): T[] {
  return [...codes].sort(compareActivity);
}
