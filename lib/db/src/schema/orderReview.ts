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
  uniqueIndex,
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
  // Total Order Qty Weight (MT) of missingStructure rows. Optional — absent
  // for Order Review files parsed before this field was added.
  missingStructureWtMt?: number;
  // Join coverage of this file's (project, structure) keys against the newest
  // WIP import's structures. Computed where WIP context is available (stage +
  // ingest); 0 from a bare parse with no DB context.
  matchedToWip: number;
  unmatchedToWip: number;
}

// Per-import change log for the idempotent UPSERT intake. The Order Review file
// is a DAILY SNAPSHOT keyed on (project, structure); each upload updates the one
// current row per key in place. This records what the upload changed so the user
// sees the daily delta (mirrors the WIP change-log), without per-day duplication.
export interface OrderReviewFieldChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}
export interface OrderReviewRowChange {
  project: string;
  structure: string;
  changes: OrderReviewFieldChange[];
}
export interface OrderReviewChangeLog {
  // New (project, structure) keys not seen before.
  inserted: { project: string; structure: string }[];
  // Existing keys whose values changed, with field-level from -> to.
  updated: OrderReviewRowChange[];
  // Count of keys present and identical (no value change).
  unchanged: number;
  // Keys present in a prior file but ABSENT from this one. Kept (never deleted),
  // flagged as "not in latest order review".
  flagged: { project: string; structure: string }[];
}

// One ingest of an "Order Review" export (the second input file, a per-structure
// order/dispatch summary). Each upload is logged here with its change log, but the
// order rows themselves are UPSERTED (one current row per project+structure), not
// appended per import. Additive — never feeds WIP parsing/dedup/ageing.
export const orderReviewImportsTable = pgTable("order_review_imports", {
  id: serial("id").primaryKey(),
  label: text("label"),
  sourceFilename: text("source_filename").notNull(),
  // "As on" date read from the file banner (best-effort; null if not found).
  asOnDate: date("as_on_date", { mode: "string" }),
  summary: jsonb("summary").$type<OrderReviewSummary>().notNull(),
  // What this upload changed vs the current rows (inserted/updated/unchanged/
  // flagged). Null for the very first ingest before any prior rows existed is
  // still populated (all inserted); nullable only for forward-compat.
  changeLog: jsonb("change_log").$type<OrderReviewChangeLog>(),
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

// ONE CURRENT row per (project, structure) — the live order-book snapshot. The
// Order Review file is a daily snapshot, so each upload UPSERTS this row in place
// (no per-day append). The join key to WIP marks is (project, structure) —
// structure = the file's Tower Type Code, matched to a WIP mark's derived
// structure (alias). importId = the import in which this key was LAST SEEN (used
// to flag rows absent from the latest file: row.importId !== latest import id).
export const orderReviewRowsTable = pgTable(
  "order_review_rows",
  {
    id: serial("id").primaryKey(),
    importId: integer("import_id").notNull(),
    project: text("project").notNull(),
    structure: text("structure").notNull(),
    subType: text("sub_type"),
    sets: integer("sets"),
    // Order Qty Weight (MT) — col G. The total order weight per structure.
    weightMt: doublePrecision("weight_mt"),
    // WO (Work Order) Order Qty Weight (MT) — col J. The work-order quantity; the
    // BASE for the Release Balance (J - Release) and Dispatch Balance (J - Dispatch)
    // figures on the Order Status page (NOT the Order Qty in col G).
    woOrderQtyMt: doublePrecision("wo_order_qty_mt"),
    bomType: text("bom_type"),
    releaseMt: doublePrecision("release_mt"),
    // Progress Fabrication / Galvanising (MT) from the file's "Progress" block.
    // Used ONLY as a display fallback on the Order Status page for structures
    // absent from the WIP report (file-sourced, tagged distinctly). Never feeds
    // WIP parsing / activity / dedup / ageing / dispatch math.
    fabMt: doublePrecision("fab_mt"),
    galvMt: doublePrecision("galv_mt"),
    // Progress Inspection (MT) — col O. Additive display field only (Inventory
    // page Bucket D signal: inspectionMt > 0). Never feeds WIP parsing/activity/
    // dedup/ageing/dispatch math, and never touches fabMt/galvMt semantics.
    inspectionMt: doublePrecision("inspection_mt"),
    // Despatch MT as stated in the file (cross-checked vs computed dispatch).
    fileDespatchMt: doublePrecision("file_despatch_mt"),
    // File-stated balance figures (display + cross-check only, never authoritative):
    //   fileBalReleaseMt  = "Balance Release" (col S)  ~ WO Order Qty - Release
    //   fileBalDespatchMt = "Balance Despatch" (col W) ~ WO Order Qty - Despatch
    // Reconciled against the computed balances at a 1% tolerance + small abs floor.
    // Balance Work Order (col R) — remaining work-order qty stated by the file.
    balWoMt: doublePrecision("bal_wo_mt"),
    fileBalReleaseMt: doublePrecision("file_bal_release_mt"),
    fileBalDespatchMt: doublePrecision("file_bal_despatch_mt"),
    // Balance Fabrication (col T) / Balance Galvanising (col U). Additive
    // display fields for the Inventory page's per-bucket data columns (Fab /
    // Galva). Distinct from the PROGRESS fabMt/galvMt above (which are the
    // "Progress" block cols M/N) — these are the "Balance" block. Never feeds
    // WIP parsing/activity/dedup/ageing/dispatch math.
    balFabMt: doublePrecision("bal_fab_mt"),
    balGalvMt: doublePrecision("bal_galv_mt"),
  },
  (t) => [
    uniqueIndex("order_review_rows_project_structure_uq").on(
      t.project,
      t.structure,
    ),
  ],
);

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
