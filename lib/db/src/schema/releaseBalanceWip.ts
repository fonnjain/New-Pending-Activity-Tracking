import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-(project, structure) snapshot of "Job Card Not Started + Initial" balance
// weight from the most recently uploaded WIP file. Replaced wholesale (DELETE +
// re-insert) on every WIP commit — NOT append-only; always reflects the latest
// file only.
//
// Additive, display-only — never affects parsing, hashing, dedup, ageing,
// activity, milestone, dispatch, or accumulated-WIP math.
//
// Source: WIP Col A == "Job Card Not Started" AND Col G == "Initial".
// Weight is stored in MT (Col Q "Balance Wt." ÷ 1000).
export const releaseBalanceWipTable = pgTable(
  "release_balance_wip",
  {
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    releaseBalanceComputedMt: doublePrecision("release_balance_computed_mt")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.project, t.structure] })],
);

export const insertReleaseBalanceWipSchema = createInsertSchema(
  releaseBalanceWipTable,
).omit({ updatedAt: true });
export type InsertReleaseBalanceWip = z.infer<
  typeof insertReleaseBalanceWipSchema
>;
export type ReleaseBalanceWipRow =
  typeof releaseBalanceWipTable.$inferSelect;
