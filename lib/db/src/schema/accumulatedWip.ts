import {
  pgTable,
  serial,
  text,
  date,
  doublePrecision,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Permanent per-project accumulated WIP throughput totals. Additive,
// display-only overlay -- never feeds parsing / activity / dedup / ageing /
// milestone / dispatch math. Rebuilt deterministically by a full id-ASC
// replay of the WIP import history (mirrors the order-dispatch engine), from
// the very first WIP file (no cutoff -- these are lifetime throughput
// counters, not a point-in-time balance).
//   fabricationMt  = tonnes added each time a mark left TS into G (TLT
//                    projects only -- the quality -> galvanising boundary).
//   galvanizingMt  = tonnes added each time a mark left Y (dispatched /
//                    completed).
// "Each time" is intentional: a mark that re-enters an earlier activity and
// crosses the same boundary again later is counted again (cumulative
// historical throughput, not a net/point-in-time status).
export const accumulatedWipTable = pgTable("accumulated_wip", {
  // Project key = the record's `job`. "(Unassigned)" is never stored here.
  project: text("project").primaryKey(),
  fabricationMt: doublePrecision("fabrication_mt").notNull().default(0),
  galvanizingMt: doublePrecision("galvanizing_mt").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAccumulatedWipSchema = createInsertSchema(
  accumulatedWipTable,
).omit({ updatedAt: true });
export type InsertAccumulatedWip = z.infer<typeof insertAccumulatedWipSchema>;
export type AccumulatedWipRow = typeof accumulatedWipTable.$inferSelect;

// Append-only audit trail of every accumulation event (rebuilt from scratch on
// each deterministic recompute -- TRUNCATE + reinsert, mirroring
// dispatch_ledger). Not currently exposed via the API; kept for future
// drill-down / debugging.
export const accumulatedWipLedgerTable = pgTable("accumulated_wip_ledger", {
  id: serial("id").primaryKey(),
  project: text("project").notNull(),
  // "fabrication" (TS -> G, TLT only) | "galvanizing" (left Y).
  kind: text("kind").notNull(),
  markId: text("mark_id").notNull(),
  jobCardNo: text("job_card_no"),
  entryDate: date("entry_date", { mode: "string" }),
  deltaMt: doublePrecision("delta_mt").notNull(),
  importId: integer("import_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAccumulatedWipLedgerSchema = createInsertSchema(
  accumulatedWipLedgerTable,
).omit({ id: true, createdAt: true });
export type InsertAccumulatedWipLedger = z.infer<
  typeof insertAccumulatedWipLedgerSchema
>;
export type AccumulatedWipLedgerRow =
  typeof accumulatedWipLedgerTable.$inferSelect;
