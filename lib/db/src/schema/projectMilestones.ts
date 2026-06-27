import { pgTable, text, date, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Permanent per-project turnaround milestones. One row per project (job).
// Captured deterministically from the append-only import history and PRESERVED
// (capture-once) so they survive after a project leaves the report. This table
// is additive: it never feeds back into parsing / activity / dedup / ageing /
// warning / velocity math.
export const projectMilestonesTable = pgTable("project_milestones", {
  // Project key = the record's `job`. "(Unassigned)" is never stored here.
  project: text("project").primaryKey(),
  // Earliest Assign Date across all marks ever seen for the project (clock start).
  projectStart: date("project_start", { mode: "string" }),
  // MILESTONE 1 "Ready for Dispatch": first import where no mark is still in an
  // earlier activity (C..GB) — every mark is at Y or gone.
  readyDate: date("ready_date", { mode: "string" }),
  readyImportId: integer("ready_import_id"),
  readyTurnaroundDays: integer("ready_turnaround_days"),
  // MILESTONE 2 "Dispatched": first import where the project is entirely absent.
  dispatchedDate: date("dispatched_date", { mode: "string" }),
  dispatchedImportId: integer("dispatched_import_id"),
  dispatchedTurnaroundDays: integer("dispatched_turnaround_days"),
  // dispatchedTurnaroundDays - readyTurnaroundDays.
  dispatchLagDays: integer("dispatch_lag_days"),
  // Distinct mark identities (markId|jobCardNo) ever seen for the project.
  marksTotal: integer("marks_total").notNull().default(0),
  // Cumulative target at Y (resolved ideal-days) — the planned turnaround.
  plannedReadyDays: integer("planned_ready_days"),
  // readyTurnaroundDays - plannedReadyDays (+ = slower than planned).
  varianceReadyDays: integer("variance_ready_days"),
  // Captured with no prior in-progress observation (e.g. all-Y on first sight).
  limitedHistory: boolean("limited_history").notNull().default(false),
  // A mark returned to an earlier activity after a milestone was captured.
  reopened: boolean("reopened").notNull().default(false),
  // Last import (id + report date) in which the project was observed present.
  // Advances forward only and is PRESERVED across import deletion/pruning, so a
  // project orphaned by a deleted import can still be recognised as Dispatched
  // when it is absent from the newest report. Internal — not exposed via the API.
  lastSeenImportId: integer("last_seen_import_id"),
  lastSeenDate: date("last_seen_date", { mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertProjectMilestoneSchema = createInsertSchema(
  projectMilestonesTable,
);
export type InsertProjectMilestone = z.infer<typeof insertProjectMilestoneSchema>;
export type ProjectMilestoneRow = typeof projectMilestonesTable.$inferSelect;
