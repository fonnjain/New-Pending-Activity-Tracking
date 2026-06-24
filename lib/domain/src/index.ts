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

// ---------------------------------------------------------------------------
// Turnaround-time warning engine
// ---------------------------------------------------------------------------
// Deterministic, advisory-only. Compares a mark's LIVE ageing (already computed
// server-side as today - last_production_date) against a CUMULATIVE target that
// accumulates the per-activity ideal days down PROCESS_SEQUENCE. It NEVER
// changes parsing, Activity values, quantities, ageing, or dedup — it is a
// display/classification layer that can be recomputed live as settings change,
// without re-importing.

export type GraceMode = "absolute" | "percent";

// Grace bands BEYOND the cumulative target. In "absolute" mode these are days;
// in "percent" mode they are a percentage of that activity's cumulative target.
export interface ActivityThreshold {
  yellowMax: number;
  orangeMax: number;
}

export interface TurnaroundSettings {
  // Ideal days for each single activity, keyed by canonical activity code.
  idealDays: Record<string, number>;
  // Global grace bands (used unless an activity has an override).
  yellowMax: number;
  orangeMax: number;
  graceMode: GraceMode;
  // Optional per-activity overrides of the global grace bands.
  overrides: Record<string, ActivityThreshold>;
}

// green: at/under target. yellow/orange/red: increasing overrun. na: no defined
// target (activity outside PROCESS_SEQUENCE) or no ageing (blank production
// date) — never a false green/red.
export type AlertStatus = "green" | "yellow" | "orange" | "red" | "na";

export interface AlertResult {
  status: AlertStatus;
  target: number | null;
  overrun: number | null;
}

const DEFAULT_IDEAL_DAY = 3;

export const DEFAULT_TURNAROUND_SETTINGS: TurnaroundSettings = {
  idealDays: Object.fromEntries(
    PROCESS_SEQUENCE.map((step) => [step, DEFAULT_IDEAL_DAY]),
  ),
  yellowMax: 7,
  orangeMax: 21,
  graceMode: "absolute",
  overrides: {},
};

function safeDays(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

// Cumulative target per canonical step: sum of ideal-days from the FIRST step up
// to and INCLUDING that step, in PROCESS_SEQUENCE order.
// e.g. C=2, RFI=1, NH=3 -> target(C)=2, target(RFI)=3, target(NH)=6.
export function cumulativeTargets(
  idealDays: Record<string, number>,
): Record<ProcessStep, number> {
  const out = {} as Record<ProcessStep, number>;
  let acc = 0;
  for (const step of PROCESS_SEQUENCE) {
    acc += safeDays(idealDays[step]);
    out[step] = acc;
  }
  return out;
}

// Cumulative target for a single activity (case-insensitive). Returns null for
// activities outside PROCESS_SEQUENCE — they have no defined target.
export function cumulativeTarget(
  activity: string | null | undefined,
  idealDays: Record<string, number>,
): number | null {
  if (!isKnownActivity(activity)) return null;
  const norm = normalizeActivity(activity) as ProcessStep;
  return cumulativeTargets(idealDays)[norm];
}

// Classify a mark's ageing against its cumulative target under the given
// settings. Rows with no target (out-of-sequence activity) or no ageing (blank
// production date -> ageingDays null) are "na". Future-dated rows are clamped to
// ageing 0 upstream and therefore land in green.
export function alertStatus(
  input: { activity: string | null | undefined; ageingDays: number | null },
  settings: TurnaroundSettings,
): AlertResult {
  const target = cumulativeTarget(input.activity, settings.idealDays);
  if (target === null || input.ageingDays === null) {
    return { status: "na", target, overrun: null };
  }

  const overrun = input.ageingDays - target;
  const norm = normalizeActivity(input.activity);
  const override = settings.overrides[norm];
  let yMax = override ? override.yellowMax : settings.yellowMax;
  let oMax = override ? override.orangeMax : settings.orangeMax;
  if (settings.graceMode === "percent") {
    yMax = (yMax / 100) * target;
    oMax = (oMax / 100) * target;
  }

  let status: AlertStatus;
  if (overrun <= 0) status = "green";
  else if (overrun <= yMax) status = "yellow";
  else if (overrun <= oMax) status = "orange";
  else status = "red";

  return { status, target, overrun };
}
