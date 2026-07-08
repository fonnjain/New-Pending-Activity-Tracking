import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Contractor sub-category overlay (config-level). Keyed by a NORMALIZED
// contractor name (uppercase + collapsed whitespace; see normalizeContractorName
// in @workspace/domain) so casing/spacing variants resolve to one row while
// distinct suffixes stay distinct. Joined to records at read time — it NEVER
// touches parsing, ageing, dedup, the row hash, or the contractor string.
//   category      = CNC | SUB_CONTRACTOR | OUT_VENDOR | UNCLASSIFIED
//   outVendorType = FAB/GALVA tags (only meaningful when category=OUT_VENDOR)
//   displayName   = the contractor name exactly as last seen/entered (for UI)
export const contractorCategoriesTable = pgTable("contractor_categories", {
  nameKey: text("name_key").primaryKey(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  outVendorType: jsonb("out_vendor_type")
    .$type<string[]>()
    .notNull()
    .default([]),
  plantLocation: text("plant_location"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertContractorCategorySchema = createInsertSchema(
  contractorCategoriesTable,
).omit({ updatedAt: true });
export type InsertContractorCategory = z.infer<
  typeof insertContractorCategorySchema
>;
export type ContractorCategoryRow =
  typeof contractorCategoriesTable.$inferSelect;
