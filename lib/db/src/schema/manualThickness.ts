import { pgTable, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Manual thickness values for NTLT/GENERAL marks (and any other mark the user
// pins by hand). Config-level, keyed by mark_id so a value SURVIVES re-imports
// and is re-applied whenever the mark reappears. Never part of the row hash; the
// thickness resolver reads it live. Editing it never alters qty/activity/ageing.
export const manualThicknessTable = pgTable("manual_thickness", {
  markId: text("mark_id").primaryKey(),
  thicknessMm: doublePrecision("thickness_mm").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertManualThicknessSchema = createInsertSchema(
  manualThicknessTable,
).omit({ updatedAt: true });
export type InsertManualThickness = z.infer<typeof insertManualThicknessSchema>;
export type ManualThicknessRow = typeof manualThicknessTable.$inferSelect;
