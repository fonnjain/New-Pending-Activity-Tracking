import {
  pgTable,
  serial,
  text,
  date,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface OrderReviewSummary {
  rowsRead: number;
  rowsKept: number;
  projectsFound: number;
  totalWeightMt: number;
  totalReleaseMt: number;
  totalFileDespatchMt: number;
  skippedTotals: number;
  missingStructure: number;
}

// One immutable ingest of an "Order Review" export (the second input file, a
// per-structure order/dispatch summary). Append-only like WIP imports; newest
// wins for display. Additive — never feeds WIP parsing/dedup/ageing.
export const orderReviewImportsTable = pgTable("order_review_imports", {
  id: serial("id").primaryKey(),
  label: text("label"),
  sourceFilename: text("source_filename").notNull(),
  // "As on" date read from the file banner (best-effort; null if not found).
  asOnDate: date("as_on_date", { mode: "string" }),
  summary: jsonb("summary").$type<OrderReviewSummary>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertOrderReviewImportSchema = createInsertSchema(
  orderReviewImportsTable,
).omit({ id: true, createdAt: true });
export type InsertOrderReviewImport = z.infer<
  typeof insertOrderReviewImportSchema
>;
export type OrderReviewImportRow = typeof orderReviewImportsTable.$inferSelect;

// One row per (project, structure) within an Order Review ingest. The join key
// to WIP marks is (project, structure) — structure = the file's Tower Type Code,
// matched to a WIP mark's derived structure (alias).
export const orderReviewRowsTable = pgTable("order_review_rows", {
  id: serial("id").primaryKey(),
  importId: integer("import_id").notNull(),
  project: text("project").notNull(),
  structure: text("structure").notNull(),
  subType: text("sub_type"),
  sets: integer("sets"),
  weightMt: doublePrecision("weight_mt"),
  bomType: text("bom_type"),
  releaseMt: doublePrecision("release_mt"),
  // Despatch MT as stated in the file (used for cross-check vs computed dispatch).
  fileDespatchMt: doublePrecision("file_despatch_mt"),
});

export const insertOrderReviewRowSchema = createInsertSchema(
  orderReviewRowsTable,
).omit({ id: true });
export type InsertOrderReviewRow = z.infer<typeof insertOrderReviewRowSchema>;
export type OrderReviewRow = typeof orderReviewRowsTable.$inferSelect;

// Running computed Dispatch (tonnes) per (project, structure). Additive overlay
// — never touches WIP parsing / activity / dedup / ageing / warning / milestone
// math. Two layers:
//   seedMt    = one-time baseline taken from the FIRST Order Review file's
//               Despatch MT for this key (capture-once; never re-seeded).
//   accruedMt = sum of tonnes that left the Yard (marks at Y in a WIP import,
//               absent in the next) across WIP imports AFTER the seed import.
// The computed dispatch = seedMt + accruedMt. Both are rebuilt deterministically
// by a full replay (idempotent), mirroring the milestone engine.
export const orderDispatchTable = pgTable(
  "order_dispatch",
  {
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    seedMt: doublePrecision("seed_mt").notNull().default(0),
    seedDate: date("seed_date", { mode: "string" }),
    // Newest WIP import id at the moment of seeding (null if no WIP existed).
    // Yard departures are only accrued for WIP import pairs after this id.
    seedImportId: integer("seed_import_id"),
    accruedMt: doublePrecision("accrued_mt").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.project, t.structure] })],
);

export const insertOrderDispatchSchema = createInsertSchema(
  orderDispatchTable,
).omit({ updatedAt: true });
export type InsertOrderDispatch = z.infer<typeof insertOrderDispatchSchema>;
export type OrderDispatchRow = typeof orderDispatchTable.$inferSelect;

// Append-only audit trail of every dispatch movement: the initial seed plus each
// per-WIP-import accrual delta. Rebuilt on each deterministic recompute.
export const dispatchLedgerTable = pgTable("dispatch_ledger", {
  id: serial("id").primaryKey(),
  project: text("project").notNull(),
  structure: text("structure").notNull(),
  // The WIP import's report date (or seed as-on date) the delta is attributed to.
  entryDate: date("entry_date", { mode: "string" }),
  deltaMt: doublePrecision("delta_mt").notNull(),
  runningMt: doublePrecision("running_mt").notNull(),
  // "seed" | "wip_departure".
  source: text("source").notNull(),
  // WIP import that produced the delta (null for the seed entry).
  importId: integer("import_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDispatchLedgerSchema = createInsertSchema(
  dispatchLedgerTable,
).omit({ id: true, createdAt: true });
export type InsertDispatchLedger = z.infer<typeof insertDispatchLedgerSchema>;
export type DispatchLedgerRow = typeof dispatchLedgerTable.$inferSelect;

