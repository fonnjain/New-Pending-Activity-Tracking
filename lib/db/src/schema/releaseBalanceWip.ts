import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-(import_id, project, structure) snapshot of "Job Card Not Started + Initial"
// balance weight. Scoped per import so that viewing an older import shows that
// import's own Release Balance, not the latest file's.
//
// Populated by recomputeReleaseBalance(buffer, importId) immediately after each
// WIP commit. Historical imports are backfilled from the record_pool using the
// is_initial_cutting flag (which captures the same "JCNS + Initial" condition).
//
// Additive, display-only — never affects parsing, hashing, dedup, ageing,
// activity, milestone, dispatch, or accumulated-WIP math.
//
// Source: WIP Col A == "Job Card Not Started" AND Col G == "Initial".
// Weight is stored in MT (Col Q "Balance Wt." ÷ 1000).
export const releaseBalanceWipTable = pgTable(
  "release_balance_wip",
  {
    importId: integer("import_id").notNull(),
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    releaseBalanceComputedMt: doublePrecision("release_balance_computed_mt")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.project, t.structure] }),
    index("release_balance_wip_import_id_idx").on(t.importId),
  ],
);

export const insertReleaseBalanceWipSchema = createInsertSchema(
  releaseBalanceWipTable,
).omit({ updatedAt: true });
export type InsertReleaseBalanceWip = z.infer<
  typeof insertReleaseBalanceWipSchema
>;
export type ReleaseBalanceWipRow =
  typeof releaseBalanceWipTable.$inferSelect;
