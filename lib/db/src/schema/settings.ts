import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

// App-level turnaround-warning configuration. This is a SINGLETON row (one
// config for the whole app, not per-import) keyed by a constant id. The
// turnaround engine compares each mark's live ageing against a cumulative
// target derived from these ideal-days and renders a Green/Yellow/Orange/Red
// alert. Settings are advisory/display-only: they never touch parsing,
// ageing, dedup, or any computed record field.
export const SETTINGS_SINGLETON_ID = "default";

export type ActivityThreshold = { yellowMax: number; orangeMax: number };

export const settingsTable = pgTable("settings", {
  id: text("id").primaryKey(),
  // Ideal days for each single activity, keyed by canonical activity code.
  idealDays: jsonb("ideal_days").$type<Record<string, number>>().notNull(),
  // Global grace bands (days, or percent-of-target when graceMode = percent).
  yellowMax: integer("yellow_max").notNull(),
  orangeMax: integer("orange_max").notNull(),
  // "absolute" (days) or "percent" (% of the activity's cumulative target).
  graceMode: text("grace_mode").notNull(),
  // Optional per-activity overrides of the global grace bands.
  overrides: jsonb("overrides")
    .$type<Record<string, ActivityThreshold>>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SettingsRow = typeof settingsTable.$inferSelect;
