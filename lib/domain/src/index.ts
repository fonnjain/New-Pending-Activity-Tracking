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
// target. Each grace band (yellow/orange/red) is a CELL that is either MANUAL
// (a pinned day value) or AUTO (derived as a percentage of THIS activity's own
// ideal days). The resolved/effective grace days are computed at read time
// (resolveActivityGrace); ordering (yellow <= orange <= red) is enforced on the
// resolved row, never on the stored cells (an auto cell depends on idealDays).
export type GraceMode = "auto" | "manual";

// One grace band cell. `mode` decides which field is effective; both are kept so
// toggling auto<->manual remembers the last percentage/value.
export interface GraceCell {
  mode: GraceMode;
  // AUTO: percent of this activity's ideal days. effective = round(percent/100 * idealDays).
  percent?: number;
  // MANUAL: pinned grace days (overrun beyond the cumulative target).
  value?: number;
}

// Three escalating PRE-WARNING thresholds, each a PERCENT of the activity's
// cumulative target consumed (consumed = ageing / cumulativeTarget). They apply
// only while the mark is still WITHIN target (overrun <= 0); once the target is
// exceeded the existing breach bands (grace cells) take over. Invariant after
// resolution: 0 <= pw1 <= pw2 <= pw3 <= 100.
export interface PreWarnConfig {
  pw1: number;
  pw2: number;
  pw3: number;
}

// Full per-activity config: ideal days, the three grace-band cells (breach
// phase), and the three pre-warning percentage thresholds (within-target phase).
export interface ActivityConfig {
  idealDays: number;
  yellow: GraceCell;
  orange: GraceCell;
  red: GraceCell;
  preWarn: PreWarnConfig;
}

// A sparse per-project override. Any field present REPLACES the global value for
// that (project, activity); any field absent INHERITS the global cell/ideal.
// Whole rows/projects may be omitted entirely. Inheritance is PER CELL. The
// pre-warning override is itself sparse (any subset of pw1/pw2/pw3).
export interface PartialActivityConfig {
  idealDays?: number;
  yellow?: GraceCell;
  orange?: GraceCell;
  red?: GraceCell;
  preWarn?: Partial<PreWarnConfig>;
}

// The RESOLVED, effective numeric grace for one (project, activity): plain day
// values consumed by the cumulative-target + status math. This is the shape the
// rest of the engine and the consumers work with; the stored cells above are an
// editor/persistence detail resolved into this by resolveActivityGrace.
export interface ActivityGrace {
  idealDays: number;
  yellowGrace: number;
  orangeGrace: number;
  redGrace: number;
}

export interface TurnaroundSettings {
  // GLOBAL ("All Projects") per-activity config keyed by canonical activity code
  // (PROCESS_SEQUENCE). Applies to any project without its own override.
  activities: Record<string, ActivityConfig>;
  // Sparse per-project overrides: project -> activity code -> partial config.
  // Only overridden cells/fields are stored; everything else inherits `activities`.
  perProject?: Record<string, Record<string, PartialActivityConfig>>;
  // Stalled-mark threshold (days). A mark whose activity/last-production signature
  // has not changed for >= this many days is flagged stalled. App-level (not
  // per-activity). Defaults to DEFAULT_STALLED_DAYS when unset.
  stalledDays?: number;
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

// Default pre-warning thresholds (percent of cumulative target consumed) and the
// default stalled threshold (days).
export const DEFAULT_PRE_WARN: PreWarnConfig = { pw1: 70, pw2: 85, pw3: 95 };
export const DEFAULT_STALLED_DAYS = 10;

// Defaults preserve the prior behaviour: MANUAL grace cells at 7/21/21 days
// (percentages start unset / auto-off until the user opts a cell into a %).
export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = {
  idealDays: DEFAULT_IDEAL_DAY,
  yellow: { mode: "manual", value: DEFAULT_YELLOW_GRACE },
  orange: { mode: "manual", value: DEFAULT_ORANGE_GRACE },
  red: { mode: "manual", value: DEFAULT_RED_GRACE },
  preWarn: { ...DEFAULT_PRE_WARN },
};

export const DEFAULT_TURNAROUND_SETTINGS: TurnaroundSettings = {
  activities: Object.fromEntries(
    PROCESS_SEQUENCE.map((step) => [step, cloneConfig(DEFAULT_ACTIVITY_CONFIG)]),
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

function pInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  return Math.max(0, Math.round(n));
}

function optInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.max(0, Math.round(v))
    : undefined;
}

function cloneCell(c: GraceCell): GraceCell {
  return { ...c };
}

function cloneConfig(c: ActivityConfig): ActivityConfig {
  return {
    idealDays: c.idealDays,
    yellow: cloneCell(c.yellow),
    orange: cloneCell(c.orange),
    red: cloneCell(c.red),
    preWarn: { ...c.preWarn },
  };
}

// Clamp a single pre-warning threshold to an integer percent in [0, 100].
function clampPct(v: unknown, fallback: number): number {
  const n =
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
  return Math.min(100, Math.max(0, n));
}

// Optional integer percent in [0,100] (undefined when absent/invalid).
function optPct(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(100, Math.max(0, Math.round(v)))
    : undefined;
}

// Order a resolved pre-warning row so pw1 <= pw2 <= pw3 (raise later bands).
function orderPreWarn(p: PreWarnConfig): PreWarnConfig {
  const pw1 = clampPct(p.pw1, DEFAULT_PRE_WARN.pw1);
  const pw2 = Math.max(pw1, clampPct(p.pw2, DEFAULT_PRE_WARN.pw2));
  const pw3 = Math.max(pw2, clampPct(p.pw3, DEFAULT_PRE_WARN.pw3));
  return { pw1, pw2, pw3 };
}

// Migrate a stored full pre-warning row (defaults seeded + clamped + ordered).
function migratePreWarn(raw: unknown): PreWarnConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return orderPreWarn({
    pw1: clampPct(o.pw1, DEFAULT_PRE_WARN.pw1),
    pw2: clampPct(o.pw2, DEFAULT_PRE_WARN.pw2),
    pw3: clampPct(o.pw3, DEFAULT_PRE_WARN.pw3),
  });
}

// Migrate a SPARSE per-project pre-warning override (keep only present fields).
function normalizePartialPreWarn(raw: unknown): Partial<PreWarnConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<PreWarnConfig> = {};
  const pw1 = optPct(o.pw1);
  const pw2 = optPct(o.pw2);
  const pw3 = optPct(o.pw3);
  if (pw1 !== undefined) out.pw1 = pw1;
  if (pw2 !== undefined) out.pw2 = pw2;
  if (pw3 !== undefined) out.pw3 = pw3;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Resolve ONE grace band cell to effective overrun-days for a given ideal-days.
// MANUAL -> the pinned value; AUTO -> round(percent/100 * idealDays). Missing
// percent/value are treated as 0 (never NaN).
export function resolveCell(
  cell: GraceCell | undefined,
  idealDays: number,
): number {
  if (!cell) return 0;
  if (cell.mode === "auto") {
    const pct =
      typeof cell.percent === "number" &&
      Number.isFinite(cell.percent) &&
      cell.percent >= 0
        ? cell.percent
        : 0;
    return Math.max(0, Math.round((pct / 100) * Math.max(0, idealDays)));
  }
  return typeof cell.value === "number" &&
    Number.isFinite(cell.value) &&
    cell.value >= 0
    ? Math.round(cell.value)
    : 0;
}

// Clamp a RESOLVED numeric grace row to non-negative integers and enforce the
// ordering invariant yellowGrace <= orangeGrace <= redGrace by raising later
// bands as needed (deterministic auto-correct, so an inverted auto-fill or edit
// can never mislabel).
export function normalizeGrace(g: ActivityGrace): ActivityGrace {
  const idealDays = Math.max(0, Math.round(g.idealDays));
  const yellowGrace = Math.max(0, Math.round(g.yellowGrace));
  const orangeGrace = Math.max(yellowGrace, Math.round(g.orangeGrace));
  const redGrace = Math.max(orangeGrace, Math.round(g.redGrace));
  return { idealDays, yellowGrace, orangeGrace, redGrace };
}

// Sanitize a raw stored cell. Accepts the new {mode,percent,value} shape OR a
// bare number (previous numeric grace -> MANUAL with that value). Keeps both
// percent and value when present so auto<->manual toggles remember each other.
function migrateCell(raw: unknown, fallbackValue: number): GraceCell {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const percent = optInt(o.percent);
    const value = optInt(o.value);
    if (o.mode === "auto") {
      const cell: GraceCell = { mode: "auto", percent: percent ?? 0 };
      if (value !== undefined) cell.value = value;
      return cell;
    }
    const cell: GraceCell = { mode: "manual", value: value ?? fallbackValue };
    if (percent !== undefined) cell.percent = percent;
    return cell;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { mode: "manual", value: Math.max(0, Math.round(raw)) };
  }
  return { mode: "manual", value: fallbackValue };
}

// Pick a band cell from a raw per-activity object: prefer the new cell object
// (`yellow`), else the previous numeric field (`yellowGrace`), else fallback.
function cellFor(
  p: Record<string, unknown> | undefined,
  cellKey: string,
  numKey: string,
  fallback: number,
): GraceCell {
  const rawCell = p?.[cellKey];
  if (rawCell && typeof rawCell === "object")
    return migrateCell(rawCell, fallback);
  const n = p?.[numKey];
  if (typeof n === "number" && Number.isFinite(n)) {
    return { mode: "manual", value: Math.max(0, Math.round(n)) };
  }
  return { mode: "manual", value: fallback };
}

// Sanitize a SPARSE per-project override row, keeping ONLY present fields. Each
// band, if present, is a full cell (new shape) or a number (previous shape ->
// MANUAL). Ordering is NOT enforced here (the row is partial + cells are
// mode-dependent); it is enforced after resolution in resolveActivityGrace.
function normalizePartialConfig(raw: unknown): PartialActivityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: PartialActivityConfig = {};
  const ideal = optInt(o.idealDays);
  if (ideal !== undefined) out.idealDays = ideal;
  const bands = [
    ["yellow", "yellowGrace"],
    ["orange", "orangeGrace"],
    ["red", "redGrace"],
  ] as const;
  for (const [cellKey, numKey] of bands) {
    const rawCell = o[cellKey];
    if (rawCell && typeof rawCell === "object") {
      out[cellKey] = migrateCell(rawCell, 0);
    } else if (typeof o[numKey] === "number" && Number.isFinite(o[numKey])) {
      out[cellKey] = {
        mode: "manual",
        value: Math.max(0, Math.round(o[numKey] as number)),
      };
    }
  }
  const preWarn = normalizePartialPreWarn(o.preWarn);
  if (preWarn) out.preWarn = preWarn;
  return out;
}

// Sanitize the sparse per-project override map: keep only known activities, only
// present fields, and drop empty rows/projects so the stored shape stays minimal.
function migratePerProject(
  raw: unknown,
): Record<string, Record<string, PartialActivityConfig>> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, Record<string, PartialActivityConfig>> = {};
  for (const [project, acts] of Object.entries(obj)) {
    if (!project || !acts || typeof acts !== "object") continue;
    const cleanedActs: Record<string, PartialActivityConfig> = {};
    for (const step of PROCESS_SEQUENCE) {
      const cell = (acts as Record<string, unknown>)[step];
      if (!cell || typeof cell !== "object") continue;
      const cleaned = normalizePartialConfig(cell);
      if (Object.keys(cleaned).length > 0) cleanedActs[step] = cleaned;
    }
    if (Object.keys(cleanedActs).length > 0) out[project] = cleanedActs;
  }
  return out;
}

// Resolve the EFFECTIVE numeric grace for one (project, activity). Per-cell
// inheritance: a band the project overrides resolves against the project's
// effective ideal days; an inherited (global) band resolves against the global
// ideal days. AUTO cells derive from their percentage; MANUAL cells use their
// pinned value. The merged row is then ordering-normalized (yellow<=orange<=red).
// With no project (or no override) this is just the global row resolved.
export function resolveActivityGrace(
  settings: TurnaroundSettings,
  project: string | null | undefined,
  step: ProcessStep,
): ActivityGrace {
  const base = settings.activities[step] ?? DEFAULT_ACTIVITY_CONFIG;
  const ov = project ? settings.perProject?.[project]?.[step] : undefined;
  const globalIdeal = base.idealDays;
  const effIdeal = ov?.idealDays ?? globalIdeal;

  const band = (key: "yellow" | "orange" | "red"): number => {
    const oc = ov?.[key];
    if (oc) return resolveCell(oc, effIdeal);
    return resolveCell(base[key], globalIdeal);
  };

  return normalizeGrace({
    idealDays: effIdeal,
    yellowGrace: band("yellow"),
    orangeGrace: band("orange"),
    redGrace: band("red"),
  });
}

// Normalize any stored/legacy settings object into the current per-activity
// shape. Accepts the NEW cell shape (`activities[step].{yellow,orange,red}` =
// {mode,percent,value}), the PREVIOUS numeric shape (`yellowGrace`/`orangeGrace`/
// `redGrace` numbers -> MANUAL cells), and the oldest flat shape
// (`{idealDays, yellowMax, orangeMax, overrides}` -> MANUAL cells seeded from the
// global bands, red = orange). Existing explicit grace values therefore become
// MANUAL cells, preserving behaviour until the user opts a cell into a percentage.
export function migrateTurnaroundSettings(raw: unknown): TurnaroundSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const provided = obj.activities as Record<string, unknown> | undefined;
  const legacyIdeal = obj.idealDays as Record<string, number> | undefined;
  const legacyYellow =
    typeof obj.yellowMax === "number" ? obj.yellowMax : undefined;
  const legacyOrange =
    typeof obj.orangeMax === "number" ? obj.orangeMax : undefined;
  const legacyOverrides = (obj.overrides ?? {}) as Record<
    string,
    { yellowMax?: number; orangeMax?: number }
  >;

  const activities: Record<string, ActivityConfig> = {};
  for (const step of PROCESS_SEQUENCE) {
    const rawP = provided?.[step];
    const p =
      rawP && typeof rawP === "object"
        ? (rawP as Record<string, unknown>)
        : undefined;
    const ov = legacyOverrides[step];
    const orange = num(ov?.orangeMax ?? legacyOrange, DEFAULT_ORANGE_GRACE);
    const yellow = num(ov?.yellowMax ?? legacyYellow, DEFAULT_YELLOW_GRACE);
    activities[step] = {
      idealDays: pInt(p?.idealDays, num(legacyIdeal?.[step], DEFAULT_IDEAL_DAY)),
      yellow: cellFor(p, "yellow", "yellowGrace", yellow),
      orange: cellFor(p, "orange", "orangeGrace", orange),
      red: cellFor(p, "red", "redGrace", orange),
      preWarn: migratePreWarn(p?.preWarn),
    };
  }
  const stalledDays = pInt(obj.stalledDays, DEFAULT_STALLED_DAYS);
  return {
    activities,
    perProject: migratePerProject(obj.perProject),
    stalledDays,
  };
}

// Resolve the EFFECTIVE pre-warning thresholds for one (project, activity).
// Per-field inheritance: a project override field replaces the global; absent
// fields inherit the global. The merged row is clamped to [0,100] and ordered
// pw1 <= pw2 <= pw3 (raise later bands), mirroring grace resolution.
export function resolvePreWarn(
  settings: TurnaroundSettings,
  project: string | null | undefined,
  step: ProcessStep,
): PreWarnConfig {
  const base = settings.activities[step]?.preWarn ?? DEFAULT_PRE_WARN;
  const ov = project ? settings.perProject?.[project]?.[step]?.preWarn : undefined;
  return orderPreWarn({
    pw1: ov?.pw1 ?? base.pw1,
    pw2: ov?.pw2 ?? base.pw2,
    pw3: ov?.pw3 ?? base.pw3,
  });
}

// Effective stalled threshold in days (non-negative integer; default when unset).
export function resolveStalledDays(settings: TurnaroundSettings): number {
  return pInt(settings.stalledDays, DEFAULT_STALLED_DAYS);
}

// Cumulative target per canonical step: sum of ideal-days from the FIRST step up
// to and INCLUDING that step, in PROCESS_SEQUENCE order.
// e.g. C=2, RFI=1, NH=3 -> target(C)=2, target(RFI)=3, target(NH)=6.
// Optional `project` resolves per-project ideal-days overrides; omit (or pass
// null) for the global "All Projects" targets.
export function cumulativeTargets(
  settings: TurnaroundSettings,
  project?: string | null,
): Record<ProcessStep, number> {
  const out = {} as Record<ProcessStep, number>;
  let acc = 0;
  for (const step of PROCESS_SEQUENCE) {
    acc += safeDays(resolveActivityGrace(settings, project, step).idealDays);
    out[step] = acc;
  }
  return out;
}

// Cumulative target for a single activity (case-insensitive). Returns null for
// activities outside PROCESS_SEQUENCE — they have no defined target. Optional
// `project` applies that project's ideal-days overrides.
export function cumulativeTarget(
  activity: string | null | undefined,
  settings: TurnaroundSettings,
  project?: string | null,
): number | null {
  if (!isKnownActivity(activity)) return null;
  const norm = normalizeActivity(activity) as ProcessStep;
  return cumulativeTargets(settings, project)[norm];
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
  input: {
    activity: string | null | undefined;
    ageingDays: number | null;
    project?: string | null;
  },
  settings: TurnaroundSettings,
): AlertResult {
  const target = cumulativeTarget(input.activity, settings, input.project);
  if (target === null || input.ageingDays === null) {
    return { status: "na", target, overrun: null };
  }

  const overrun = input.ageingDays - target;
  const norm = normalizeActivity(input.activity) as ProcessStep;
  const grace = resolveActivityGrace(settings, input.project, norm);

  let status: AlertStatus;
  if (overrun <= 0) status = "green";
  else if (overrun <= grace.yellowGrace) status = "yellow";
  else if (overrun <= grace.orangeGrace) status = "orange";
  else status = "red";

  return { status, target, overrun };
}

// ---------------------------------------------------------------------------
// Lifecycle status — the full 8-state ladder
// ---------------------------------------------------------------------------
// A SUPERSET view layered on top of alertStatus (the breach engine, untouched).
// While a mark is still within target (overrun <= 0) it is classified by how much
// of its cumulative target it has CONSUMED (ageing / target), against the
// per-activity pre-warning thresholds. Once the target is exceeded (overrun > 0)
// the existing grace bands take over — yellow/orange/red are simply renamed
// breach1/breach2/breach3 here so the ladder reads as one escalating sequence.
//
//   na                                  -> no target or no ageing
//   within target (overrun <= 0):
//     consumed < pw1                    -> green
//     pw1 <= consumed < pw2             -> prewarn1
//     pw2 <= consumed < pw3             -> prewarn2
//     pw3 <= consumed (<= 100)          -> prewarn3
//   over target (overrun > 0):
//     alertStatus yellow/orange/red     -> breach1/breach2/breach3
//
// Breach classification is delegated verbatim to alertStatus, so pre-warning is
// strictly ADDITIVE and never changes breach bands, targets, ageing, or n/a.
export type LifecycleStatus =
  | "green"
  | "prewarn1"
  | "prewarn2"
  | "prewarn3"
  | "breach1"
  | "breach2"
  | "breach3"
  | "na";

// Canonical render order (best -> worst) for legends, summaries and sorting.
export const LIFECYCLE_ORDER: LifecycleStatus[] = [
  "green",
  "prewarn1",
  "prewarn2",
  "prewarn3",
  "breach1",
  "breach2",
  "breach3",
  "na",
];

export interface LifecycleResult {
  status: LifecycleStatus;
  target: number | null;
  overrun: number | null;
  // Percent of the cumulative target consumed (round(ageing/target*100)); null
  // when there is no usable target (na, or target 0).
  consumedPct: number | null;
  // Projected days remaining before the target is reached (max(0, target -
  // ageing)); 0 once breached; null when na.
  daysToTarget: number | null;
}

const BREACH_BY_ALERT: Record<"yellow" | "orange" | "red", LifecycleStatus> = {
  yellow: "breach1",
  orange: "breach2",
  red: "breach3",
};

export function lifecycleStatus(
  input: {
    activity: string | null | undefined;
    ageingDays: number | null;
    project?: string | null;
  },
  settings: TurnaroundSettings,
): LifecycleResult {
  const base = alertStatus(input, settings);
  const { target, overrun } = base;

  if (base.status === "na" || target === null || input.ageingDays === null) {
    return { status: "na", target, overrun, consumedPct: null, daysToTarget: null };
  }

  const ageing = input.ageingDays;
  const consumedPct = target > 0 ? Math.round((ageing / target) * 100) : null;

  // Breach phase: reuse the breach engine's band verbatim.
  if ((overrun ?? 0) > 0) {
    const status =
      base.status === "green" ? "green" : BREACH_BY_ALERT[base.status];
    return { status, target, overrun, consumedPct, daysToTarget: 0 };
  }

  // Within-target phase: classify by consumed percentage of the target.
  const daysToTarget = Math.max(0, target - ageing);
  if (target <= 0) {
    return { status: "green", target, overrun, consumedPct, daysToTarget };
  }

  const consumed = (ageing / target) * 100;
  const pw = resolvePreWarn(
    settings,
    input.project,
    normalizeActivity(input.activity) as ProcessStep,
  );

  let status: LifecycleStatus;
  if (consumed < pw.pw1) status = "green";
  else if (consumed < pw.pw2) status = "prewarn1";
  else if (consumed < pw.pw3) status = "prewarn2";
  else status = "prewarn3";

  return { status, target, overrun, consumedPct, daysToTarget };
}
