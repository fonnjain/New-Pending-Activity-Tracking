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

// Per-activity turnaround configuration. `idealDays` feeds the cumulative
// target; `yellowGrace`/`orangeGrace`/`redGrace` are the day-overruns BEYOND
// that activity's cumulative target at which the alert escalates. Each activity
// carries its OWN grace (no global rule, no multipliers). `redGrace` is the
// upper edge of orange (validated yellowGrace <= orangeGrace <= redGrace);
// anything past orange is red.
export interface ActivityGrace {
  idealDays: number;
  yellowGrace: number;
  orangeGrace: number;
  redGrace: number;
}

export interface TurnaroundSettings {
  // Per-activity config keyed by canonical activity code (PROCESS_SEQUENCE).
  activities: Record<string, ActivityGrace>;
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
const DEFAULT_YELLOW_GRACE = 7;
const DEFAULT_ORANGE_GRACE = 21;
const DEFAULT_RED_GRACE = 21;

export const DEFAULT_ACTIVITY_GRACE: ActivityGrace = {
  idealDays: DEFAULT_IDEAL_DAY,
  yellowGrace: DEFAULT_YELLOW_GRACE,
  orangeGrace: DEFAULT_ORANGE_GRACE,
  redGrace: DEFAULT_RED_GRACE,
};

export const DEFAULT_TURNAROUND_SETTINGS: TurnaroundSettings = {
  activities: Object.fromEntries(
    PROCESS_SEQUENCE.map((step) => [step, { ...DEFAULT_ACTIVITY_GRACE }]),
  ),
};

function safeDays(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Clamp a grace row to non-negative integers and enforce the ordering invariant
// yellowGrace <= orangeGrace <= redGrace by raising later bands as needed
// (deterministic auto-correct, so a transient inverted edit can never persist).
export function normalizeGrace(g: ActivityGrace): ActivityGrace {
  const idealDays = Math.max(0, Math.round(g.idealDays));
  const yellowGrace = Math.max(0, Math.round(g.yellowGrace));
  const orangeGrace = Math.max(yellowGrace, Math.round(g.orangeGrace));
  const redGrace = Math.max(orangeGrace, Math.round(g.redGrace));
  return { idealDays, yellowGrace, orangeGrace, redGrace };
}

// Normalize any stored/legacy settings object into the current per-activity
// shape. Accepts the new `{activities}` shape OR the legacy
// `{idealDays, yellowMax, orangeMax, overrides}` shape (global bands +
// per-activity overrides). For legacy data it keeps the ideal days and seeds
// each activity's yellow/orange grace from the global value (or its override)
// and red = orange, so behaviour is unchanged until the user edits per-activity.
export function migrateTurnaroundSettings(raw: unknown): TurnaroundSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const provided = obj.activities as
    | Record<string, Partial<ActivityGrace>>
    | undefined;
  const legacyIdeal = obj.idealDays as Record<string, number> | undefined;
  const legacyYellow =
    typeof obj.yellowMax === "number" ? obj.yellowMax : undefined;
  const legacyOrange =
    typeof obj.orangeMax === "number" ? obj.orangeMax : undefined;
  const legacyOverrides = (obj.overrides ?? {}) as Record<
    string,
    { yellowMax?: number; orangeMax?: number }
  >;

  const activities: Record<string, ActivityGrace> = {};
  for (const step of PROCESS_SEQUENCE) {
    const p = provided?.[step];
    if (p && typeof p === "object") {
      const orange = num(p.orangeGrace, DEFAULT_ORANGE_GRACE);
      activities[step] = normalizeGrace({
        idealDays: num(p.idealDays, DEFAULT_IDEAL_DAY),
        yellowGrace: num(p.yellowGrace, DEFAULT_YELLOW_GRACE),
        orangeGrace: orange,
        redGrace: num(p.redGrace, orange),
      });
    } else {
      const ov = legacyOverrides[step];
      const orange = num(ov?.orangeMax ?? legacyOrange, DEFAULT_ORANGE_GRACE);
      activities[step] = normalizeGrace({
        idealDays: num(legacyIdeal?.[step], DEFAULT_IDEAL_DAY),
        yellowGrace: num(ov?.yellowMax ?? legacyYellow, DEFAULT_YELLOW_GRACE),
        orangeGrace: orange,
        redGrace: orange,
      });
    }
  }
  return { activities };
}

// Cumulative target per canonical step: sum of ideal-days from the FIRST step up
// to and INCLUDING that step, in PROCESS_SEQUENCE order.
// e.g. C=2, RFI=1, NH=3 -> target(C)=2, target(RFI)=3, target(NH)=6.
export function cumulativeTargets(
  settings: TurnaroundSettings,
): Record<ProcessStep, number> {
  const out = {} as Record<ProcessStep, number>;
  let acc = 0;
  for (const step of PROCESS_SEQUENCE) {
    acc += safeDays(settings.activities[step]?.idealDays);
    out[step] = acc;
  }
  return out;
}

// Cumulative target for a single activity (case-insensitive). Returns null for
// activities outside PROCESS_SEQUENCE — they have no defined target.
export function cumulativeTarget(
  activity: string | null | undefined,
  settings: TurnaroundSettings,
): number | null {
  if (!isKnownActivity(activity)) return null;
  const norm = normalizeActivity(activity) as ProcessStep;
  return cumulativeTargets(settings)[norm];
}

// Classify a mark's ageing against its cumulative target using THAT activity's
// own grace. Rows with no target (out-of-sequence activity) or no ageing (blank
// production date -> ageingDays null) are "na". Future-dated rows are clamped to
// ageing 0 upstream and therefore land in green.
//   overrun = ageingDays - cumulativeTarget(activity)
//   overrun <= 0            -> green
//   overrun <= yellowGrace  -> yellow
//   overrun <= orangeGrace  -> orange
//   overrun >  orangeGrace  -> red
export function alertStatus(
  input: { activity: string | null | undefined; ageingDays: number | null },
  settings: TurnaroundSettings,
): AlertResult {
  const target = cumulativeTarget(input.activity, settings);
  if (target === null || input.ageingDays === null) {
    return { status: "na", target, overrun: null };
  }

  const overrun = input.ageingDays - target;
  const norm = normalizeActivity(input.activity);
  const grace = settings.activities[norm] ?? DEFAULT_ACTIVITY_GRACE;

  let status: AlertStatus;
  if (overrun <= 0) status = "green";
  else if (overrun <= grace.yellowGrace) status = "yellow";
  else if (overrun <= grace.orangeGrace) status = "orange";
  else status = "red";

  return { status, target, overrun };
}
