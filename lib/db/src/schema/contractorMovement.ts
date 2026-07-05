import {
  pgTable,
  serial,
  text,
  date,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Contractor Performance report ledger: a daily record of how much work
// (marks + weight) moved from one activity to the next, credited to the
// contractor who performed the FROM activity (the one who completed and
// released that stage). Additive, display-only overlay -- never feeds
// parsing / activity / dedup / ageing math.
//
// Rebuilt deterministically by a full id-ASC replay of ALL imports (mirrors
// the accumulated-WIP / computed-dispatch engines): for every mark identity,
// whenever its activity differs between two consecutive imports it appears
// in, one movement is recorded, dated to the import that first observed the
// new activity ("entryDate" = that import's report date, else its
// created_at day). No cutoff -- this is a lifetime daily log, not a
// point-in-time balance. "Each time" is intentional: a mark that regresses
// and later re-crosses the same activity pair again is counted again.
//
// One row per (entryDate, project, contractor, fromActivity, toActivity) --
// already aggregated at write time (markCount + weightKg summed), which is
// the natural detail-log grain for the report's "detail" Excel sheet. The
// report's summary matrix (contractor x date) is derived from these rows at
// read time, not stored separately.
export const contractorMovementTable = pgTable("contractor_movement", {
  id: serial("id").primaryKey(),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  project: text("project").notNull(),
  // Null/blank contractor displays as "Unassigned" at read time.
  contractor: text("contractor"),
  fromActivity: text("from_activity").notNull(),
  toActivity: text("to_activity").notNull(),
  markCount: integer("mark_count").notNull().default(0),
  weightKg: doublePrecision("weight_kg").notNull().default(0),
  // The import whose read first observed the mark at `toActivity`. Kept for
  // traceability/debugging; not currently surfaced via the API.
  importId: integer("import_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertContractorMovementSchema = createInsertSchema(
  contractorMovementTable,
).omit({ id: true, createdAt: true });
export type InsertContractorMovement = z.infer<
  typeof insertContractorMovementSchema
>;
export type ContractorMovementRow = typeof contractorMovementTable.$inferSelect;
