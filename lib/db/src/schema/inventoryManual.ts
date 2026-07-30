import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Inventory page (5-bucket board A-E).
//
// Bucket A is fully data-driven (Order Review rows where WO Order Qty ≈ 0 AND
// Release Qty ≈ 0). No manual A table — `inventory_manual_a` was retired.
//
// Bucket E ("Material Ready But Not Dispatched") remains manual: a dropdown-
// pick list the user maintains on the page.  One row per (project, mfcBatch,
// side) the user has confirmed is physically ready.
//
//   projectCode = project label as entered by the user (picked from dropdown)
//   mfcBatch    = MFC batch letter (A/B/C/D) or "Z" (= not yet batched)
//   side        = "in_house" | "out_vendor"

export const inventoryManualETable = pgTable("inventory_manual_e", {
  id: serial("id").primaryKey(),
  projectCode: text("project_code").notNull(),
  mfcBatch: text("mfc_batch").notNull().default("Z"),
  side: text("side").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInventoryManualESchema = createInsertSchema(
  inventoryManualETable,
).omit({ id: true, createdAt: true });
export type InsertInventoryManualE = z.infer<
  typeof insertInventoryManualESchema
>;
export type InventoryManualERow = typeof inventoryManualETable.$inferSelect;

// Permanent side-override for auto-computed Buckets B/C/D.  When a project is
// moved from In-House to Out-Vendor (or vice versa) on the Inventory page the
// override is stored here and applied client-side on every render so the
// project always appears on the correct side regardless of the contractor
// classification in the WIP file.
//
//   projectCode = project label (matches the value coming from Order Review /
//                 WIP "project" field).
//   bucket      = 'b' | 'c' | 'd' — which auto-bucket the override applies to.
//   side        = 'in_house' | 'out_vendor' — the target side.
//
// Unique on (projectCode, bucket): upsert-replace semantics.
export const inventorySideOverrideTable = pgTable(
  "inventory_side_override",
  {
    id: serial("id").primaryKey(),
    projectCode: text("project_code").notNull(),
    bucket: text("bucket").notNull(),
    side: text("side").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("inventory_side_override_project_bucket").on(table.projectCode, table.bucket)],
);

export const insertInventorySideOverrideSchema = createInsertSchema(
  inventorySideOverrideTable,
).omit({ id: true, createdAt: true });
export type InsertInventorySideOverride = z.infer<
  typeof insertInventorySideOverrideSchema
>;
export type InventorySideOverrideRow = typeof inventorySideOverrideTable.$inferSelect;

// Legacy per-batch colour table (inventory_mfc_color).  Kept in the schema so
// the existing table is not dropped on `db push`; no new writes, no new reads.
// Can be physically dropped once confirmed unused.
export const inventoryMfcColorTable = pgTable("inventory_mfc_color", {
  mfcBatch: text("mfc_batch").primaryKey(),
  color: text("color").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// MFC Batch Colour — per (project, mfcBatch) pair.
//
// Records the backfill colour assigned to a specific (project, MFC batch)
// combination, plus two optional milestone dates:
//   dateOfClientMfc  = date the client confirmed the MFC batch (YYYY-MM-DD)
//   projectStartDate = date the project is scheduled to start (YYYY-MM-DD)
//
// Used on the Bucket List page: displayed as a colour dot on the relevant
// project rows and included in the Excel export as a cell background fill.
// A reminder notice is shown when a stored entry's project is no longer in
// Bucket A (i.e. it has moved into active production).
export const inventoryMfcBatchColorTable = pgTable(
  "inventory_mfc_batch_color",
  {
    id: serial("id").primaryKey(),
    project: text("project").notNull(),
    mfcBatch: text("mfc_batch").notNull(),
    // One of: white | yellow | green | blue
    color: text("color").notNull(),
    // Optional milestone dates stored as YYYY-MM-DD text strings.
    dateOfClientMfc: text("date_of_client_mfc"),
    projectStartDate: text("project_start_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("inventory_mfc_batch_color_project_batch").on(
      table.project,
      table.mfcBatch,
    ),
  ],
);

export const insertInventoryMfcBatchColorSchema = createInsertSchema(
  inventoryMfcBatchColorTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInventoryMfcBatchColor = z.infer<
  typeof insertInventoryMfcBatchColorSchema
>;
export type InventoryMfcBatchColorRow =
  typeof inventoryMfcBatchColorTable.$inferSelect;

// Per-PROJECT milestone dates — "Date of Client MFC" and "Project start date".
//
// IMPORTANT — UPLOAD-INDEPENDENT: this table is keyed on project only and is
// NEVER truncated, rebuilt, or modified by any WIP import/upload.  Dates
// entered here persist across imports permanently.  Do NOT add import_id
// scoping or wholesale deletes.  The gate for leaving Pre-Bucket B is colour
// alone (see inventory_mfc_batch_color); these dates are informational only.
//
// Note: colour is per (project, mfc_batch) in inventory_mfc_batch_color;
// dates are per PROJECT here.  Both tables are upload-independent.
export const inventoryProjectDatesTable = pgTable("inventory_project_dates", {
  project: text("project").primaryKey(),
  dateOfClientMfc: text("date_of_client_mfc"),
  projectStartDate: text("project_start_date"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InventoryProjectDatesRow =
  typeof inventoryProjectDatesTable.$inferSelect;
