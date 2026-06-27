import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-row priority (P1..P10) for the "Fabrication Load for TLT" report. Keyed by
// (section, column, project). This is a DISPLAY/PLANNING overlay only — it NEVER
// touches parsing, ageing, dedup, qty, the row hash, classification, or alert
// math. Rows are created on demand when a planner sets a priority.
//   section  = "operational" | "inhand"
//   column   = "welded" | "bending" | "drilling" | "platePunch" | "plateDrill"
//   project  = the TLT project (job) string
//   priority = "P1".."P10"
export const fabricationPrioritiesTable = pgTable(
  "fabrication_priorities",
  {
    section: text("section").notNull(),
    column: text("column").notNull(),
    project: text("project").notNull(),
    priority: text("priority").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.section, t.column, t.project] })],
);

export const insertFabricationPrioritySchema = createInsertSchema(
  fabricationPrioritiesTable,
).omit({ updatedAt: true });
export type InsertFabricationPriority = z.infer<
  typeof insertFabricationPrioritySchema
>;
export type FabricationPriorityRow =
  typeof fabricationPrioritiesTable.$inferSelect;
