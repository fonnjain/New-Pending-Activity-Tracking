import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Contractor alias table — maps a normalized alias key to the canonical
// contractor_categories name_key. Populated when a dedup proposal is approved.
// NEVER rebuilt or cleared on WIP upload — it is reference data, like
// contractor Type and Plant Location settings.
// aliasKey  = normalizeContractorName(rawName)  — the join key from WIP rows
// canonicalKey = the nameKey of the canonical contractor_categories entry
// rawName      = the original raw string as it appeared in the WIP file (display)
export const contractorAliasesTable = pgTable("contractor_aliases", {
  aliasKey: text("alias_key").primaryKey(),
  canonicalKey: text("canonical_key").notNull(),
  rawName: text("raw_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ContractorAliasRow = typeof contractorAliasesTable.$inferSelect;
