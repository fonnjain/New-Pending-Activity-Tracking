import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { importsTable } from "./imports";

// Per-(importId, project, structure) snapshot of Assignment Balance.
// Append-only: each WIP upload inserts rows for its own import_id and deletes
// ONLY the rows with that same import_id before reinserting — historical imports
// are never overwritten.  This mirrors the release_balance_wip design so a
// historical view shows each import's assignment balance alongside its other
// figures (not today's balance grafted onto every past import).
//
// Additive, display-only — never affects parsing, hashing, dedup, ageing,
// activity, milestone, dispatch, or accumulated-WIP math.
//
// Definition: Col A == "Job Card Not Started" AND Col G == "Authorized"
//   AND Col D (Contractor) is blank.
// Weight is stored in MT (Col Q "Balance Wt." ÷ 1000).
//
// Excludes Initial (Not Started + Initial) rows: those are already counted in
// Release Balance.  Assignment Balance therefore represents work that has been
// released to the shop floor (Authorized) but has not yet been assigned to a
// contractor — the actionable queue.
export const assignmentBalanceWipTable = pgTable(
  "assignment_balance_wip",
  {
    importId: integer("import_id")
      .notNull()
      .references(() => importsTable.id, { onDelete: "cascade" }),
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    assignmentBalanceComputedMt: doublePrecision("assignment_balance_computed_mt")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.importId, t.project, t.structure] })],
);

export const insertAssignmentBalanceWipSchema = createInsertSchema(
  assignmentBalanceWipTable,
).omit({ updatedAt: true });
export type InsertAssignmentBalanceWip = z.infer<
  typeof insertAssignmentBalanceWipSchema
>;
export type AssignmentBalanceWipRow =
  typeof assignmentBalanceWipTable.$inferSelect;
