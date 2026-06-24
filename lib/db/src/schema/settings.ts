import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

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

export type ActivityConfig = {
  idealDays: number;
  yellow: GraceCell;
  orange: GraceCell;
  red: GraceCell;
};

// Sparse per-project override of any subset of {idealDays, yellow/orange/red
// cell}. Absent fields inherit the global `activities` value (per cell).
export type PartialActivityConfig = Partial<ActivityConfig>;

export const settingsTable = pgTable("settings", {
  id: text("id").primaryKey(),
  // GLOBAL ("All Projects") per-activity config keyed by canonical activity code
  // (PROCESS_SEQUENCE): ideal days + yellow/orange/red grace cells.
  activities: jsonb("activities")
    .$type<Record<string, ActivityConfig>>()
    .notNull(),
  // Sparse per-project overrides: project -> activity code -> partial config.
  // Only overridden cells/fields are stored; everything else inherits `activities`.
  perProject: jsonb("per_project")
    .$type<Record<string, Record<string, PartialActivityConfig>>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SettingsRow = typeof settingsTable.$inferSelect;
