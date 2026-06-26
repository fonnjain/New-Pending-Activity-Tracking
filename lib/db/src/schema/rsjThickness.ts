import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// RSJ Types & Thickness lookup table (config-level, NTLT -> RSJ thickness).
// Keyed by the cleaned "RSJ <dims>" prefix (matches record_pool.group_key for
// NTLT/RSJ rows). The thickness resolver looks a row's groupKey up here; a
// missing entry leaves the mark "unset" until the user adds the type. This is
// config only -- it never touches parsing, ageing, dedup, or the row hash.
export const rsjThicknessTable = pgTable("rsj_thickness", {
  id: serial("id").primaryKey(),
  // Cleaned "RSJ <dims>" section prefix (see cleanRsjGroupKey in parse.ts).
  groupKey: text("group_key").notNull().unique(),
  thicknessMm: doublePrecision("thickness_mm").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertRsjThicknessSchema = createInsertSchema(rsjThicknessTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertRsjThickness = z.infer<typeof insertRsjThicknessSchema>;
export type RsjThicknessRow = typeof rsjThicknessTable.$inferSelect;
