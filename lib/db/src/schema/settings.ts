import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// App-level turnaround-warning configuration. This is a SINGLETON row (one
// config for the whole app, not per-import) keyed by a constant id. The
// turnaround engine compares each mark's live ageing against a cumulative
// target derived from the per-activity ideal-days and renders a
// Green/Yellow/Orange/Red alert using that activity's own grace bands. Settings
// are advisory/display-only: they never touch parsing, ageing, dedup, or any
// computed record field.
export const SETTINGS_SINGLETON_ID = "default";

export type ActivityGrace = {
  idealDays: number;
  yellowGrace: number;
  orangeGrace: number;
  redGrace: number;
};

export const settingsTable = pgTable("settings", {
  id: text("id").primaryKey(),
  // Per-activity config keyed by canonical activity code (PROCESS_SEQUENCE):
  // ideal days + yellow/orange/red grace days for that activity.
  activities: jsonb("activities")
    .$type<Record<string, ActivityGrace>>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SettingsRow = typeof settingsTable.$inferSelect;
