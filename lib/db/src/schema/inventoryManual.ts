import { pgTable, serial, text, timestamp, doublePrecision } from "drizzle-orm/pg-core";
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
