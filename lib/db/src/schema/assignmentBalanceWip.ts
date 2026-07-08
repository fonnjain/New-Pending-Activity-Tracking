import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-(project, structure) snapshot of "Job Card Not Started + blank contractor"
// balance weight from the most recently uploaded WIP file. Replaced wholesale
// (DELETE + re-insert) on every WIP commit — NOT append-only; always reflects
// the latest file only.
//
// Additive, display-only — never affects parsing, hashing, dedup, ageing,
// activity, milestone, dispatch, or accumulated-WIP math.
//
// Source: WIP Col A == "Job Card Not Started" AND Col D (Contractor) is blank.
// Weight is stored in MT (Col Q "Balance Wt." ÷ 1000).
// NOTE: "Not Started + Initial" rows (counted in release_balance_wip) ALSO have
// a blank contractor and are therefore counted here too — the overlap is
// intentional (two different lenses on the same data).
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
