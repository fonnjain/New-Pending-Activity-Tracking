import { pgTable, serial, text, timestamp, doublePrecision, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Inventory page (5-bucket board A-E). Buckets B/C/D are auto-computed (never
// stored); A and E are MANUAL, persisted lists the user maintains directly on
// the page. Two separate tables because A is free-text project entry while E
// is a dropdown pick from known projects — kept structurally identical so both
// share one CRUD shape, but never merged into a single table (different entry
// UX + independent lifecycles).
//   projectCode = the project/structure label as entered by the user (free
//                 text for A, picked from a dropdown for E).
//   side        = "in_house" | "out_vendor" — which half of the bucket board
//                 this entry renders under.
export const inventoryManualATable = pgTable("inventory_manual_a", {
  id: serial("id").primaryKey(),
  projectCode: text("project_code").notNull(),
  // Work Order Qty weight (MT), manually typed. Bucket A projects are BRAND
  // NEW (not in WIP or Order Review yet), so nothing can be auto-filled --
  // the user types the project's WO Order Qty weight directly. Drives the
  // single Bucket A summary line ("Under Production Weight" = sum across all
  // A entries). Not used by Bucket E (E aggregates real Order Review data).
  woOrderQtyMt: doublePrecision("wo_order_qty_mt"),
  side: text("side").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInventoryManualASchema = createInsertSchema(
  inventoryManualATable,
).omit({ id: true, createdAt: true });
export type InsertInventoryManualA = z.infer<
  typeof insertInventoryManualASchema
>;
export type InventoryManualARow = typeof inventoryManualATable.$inferSelect;

export const inventoryManualETable = pgTable("inventory_manual_e", {
  id: serial("id").primaryKey(),
  projectCode: text("project_code").notNull(),
  // MFC Batch letter (A/B/C/D) or "Z" (= not yet batched). Governs which
  // structures are removed from Buckets C and D when this E entry is active.
  // Default "Z" handles any pre-migration rows.
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

// Backfill colour override for an MFC batch on the Inventory Bucket list page.
// One row per mfcBatch; upsert-replace semantics.  colour is one of the three
// choices presented in the UI: 'green' | 'white' | 'yellow'.
// Used only for Excel export background fill — not applied to the on-screen UI.
export const inventoryMfcColorTable = pgTable("inventory_mfc_color", {
  mfcBatch: text("mfc_batch").primaryKey(),
  color: text("color").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInventoryMfcColorSchema = createInsertSchema(
  inventoryMfcColorTable,
);
export type InsertInventoryMfcColor = z.infer<
  typeof insertInventoryMfcColorSchema
>;
export type InventoryMfcColorRow = typeof inventoryMfcColorTable.$inferSelect;
