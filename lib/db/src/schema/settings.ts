import { pgTable, text, jsonb, timestamp, integer, date } from "drizzle-orm/pg-core";

// App-level turnaround-warning configuration. This is a SINGLETON row (one
// config for the whole app, not per-import) keyed by a constant id. The
// turnaround engine compares each mark's live ageing against a cumulative
// target derived from the per-activity ideal-days and renders a
// Green/Yellow/Orange/Red alert using that activity's own grace bands. Settings
// are advisory/display-only: they never touch parsing, ageing, dedup, or any
// computed record field.
export const SETTINGS_SINGLETON_ID = "default";

// One grace band cell: MANUAL (pinned `value`) or AUTO (percent of this
// activity's ideal days). Resolved to effective days by the domain engine.
export type GraceCell = {
  mode: "auto" | "manual";
  percent?: number;
  value?: number;
};

// Three within-target pre-warning thresholds (percent of cumulative target
// consumed). Resolved/ordered by the domain engine.
export type PreWarnConfig = {
  pw1: number;
  pw2: number;
  pw3: number;
};

export type ActivityConfig = {
  idealDays: number;
  yellow: GraceCell;
  orange: GraceCell;
  red: GraceCell;
  preWarn: PreWarnConfig;
};

// Sparse per-project override of any subset of {idealDays, yellow/orange/red
// cell, preWarn}. Absent fields inherit the global `activities` value (per cell).
export type PartialActivityConfig = Partial<
  Omit<ActivityConfig, "preWarn">
> & { preWarn?: Partial<PreWarnConfig> };

// One NTLT category's config: a global ("All Sections") per-activity map plus
// sparse per-SECTION overrides (the NTLT analogue of activities + perProject).
export type CategorySettings = {
  activities: Record<string, ActivityConfig>;
  perSection?: Record<string, Record<string, PartialActivityConfig>>;
};

// The three NTLT subtypes' configs (TLT stays in the top-level columns).
export type NtltSettings = Partial<
  Record<"RSJ" | "EARTHING" | "GENERAL", CategorySettings>
>;

export const settingsTable = pgTable("settings", {
  id: text("id").primaryKey(),
  // GLOBAL ("All Projects") per-activity config keyed by canonical activity code
  // (PROCESS_SEQUENCE): ideal days + yellow/orange/red grace cells. (TLT category.)
  activities: jsonb("activities")
    .$type<Record<string, ActivityConfig>>()
    .notNull(),
  // Sparse per-project overrides (TLT): project -> activity code -> partial config.
  // Only overridden cells/fields are stored; everything else inherits `activities`.
  perProject: jsonb("per_project")
    .$type<Record<string, Record<string, PartialActivityConfig>>>()
    .notNull()
    .default({}),
  // The three NTLT categories' configs (RSJ/Earthing/General). TLT stays above.
  // Seeded with defaults by migrateTurnaroundSettings on read.
  ntlt: jsonb("ntlt").$type<NtltSettings>().notNull().default({}),
  // App-level stalled-mark threshold (days). A mark whose activity/last-production
  // signature has not changed for >= this many days is flagged stalled.
  stalledDays: integer("stalled_days").notNull().default(10),
  // Global "valid data starts here" cutoff (YYYY-MM-DD) or NULL (default). When
  // set, the whole app — client selection AND every server-side history replay
  // (change log, movement, velocity, milestones, dispatch) — considers ONLY WIP
  // imports dated (report date, else upload date) on/after this day; older
  // imports are ignored as if never uploaded. NULL = no cutoff = byte-identical
  // to prior behaviour. Advisory/scoping only: never touches parsing, activity,
  // qty, dedup/hash identity, or ageing math.
  validFromDate: date("valid_from_date"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SettingsRow = typeof settingsTable.$inferSelect;
