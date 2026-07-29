import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-(project, structure) snapshot of Assignment Balance from the latest WIP
// import.  Always reflects the most-recent upload — replaced wholesale on each
// import.  Additive, display-only — never affects parsing, hashing, dedup,
// ageing, activity, milestone, dispatch, or accumulated-WIP math.
//
// Definition: Col A == "Job Card Not Started" AND Col G == "Authorized"
//   AND Col D (Contractor) is blank.
// Weight is stored in MT (Col Q "Balance Wt." ÷ 1000).
//
// Excludes Initial (Not Started + Initial) rows: those are already counted in
// Release Balance.  Assignment Balance therefore represents work that has been
// released to the shop floor (Authorized) but has not yet been assigned to a
// contractor — the actionable queue.
//
// Note: the fabricationProjectCompletion route computes this inline from
// record_pool per (project, structure, mfcBatch), so this pre-computed table
// is retained only for legacy consumers and the admin recompute endpoint.
export const assignmentBalanceWipTable = pgTable(
  "assignment_balance_wip",
  {
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    assignmentBalanceComputedMt: doublePrecision("assignment_balance_computed_mt")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.project, t.structure] })],
);

export const insertAssignmentBalanceWipSchema = createInsertSchema(
  assignmentBalanceWipTable,
).omit({ updatedAt: true });
export type InsertAssignmentBalanceWip = z.infer<
  typeof insertAssignmentBalanceWipSchema
>;
export type AssignmentBalanceWipRow =
  typeof assignmentBalanceWipTable.$inferSelect;
