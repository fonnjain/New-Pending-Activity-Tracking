import {
  pgTable,
  serial,
  text,
  date,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface ParseSummary {
  rowsRead: number;
  rowsKept: number;
  distinctRows: number;
  duplicateRowCopies: number;
  projectsFound: number;
  missingContractor: number;
  missingDate: number;
}

export interface ChangeSummary {
  prevImportId: number | null;
  addedRows: number;
  unchangedRows: number;
  movedActivity: number;
  qtyChanged: number;
  newMarks: number;
  completed: number;
  netPendingQtyChange: number;
  netPendingWtChange: number;
  flags: string[];
}

export const importsTable = pgTable("imports", {
  id: serial("id").primaryKey(),
  label: text("label"),
  sourceFilename: text("source_filename").notNull(),
  reportDate: date("report_date", { mode: "string" }),
  summary: jsonb("summary").$type<ParseSummary>().notNull(),
  changeSummary: jsonb("change_summary").$type<ChangeSummary>(),
  // Advisory-only cache of the last whole-import AI turnaround report. Never on
  // record_pool; holds no computed engine values. Filtered reports are never cached.
  aiReport: jsonb("ai_report").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertImportSchema = createInsertSchema(importsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertImport = z.infer<typeof insertImportSchema>;
export type ImportRow = typeof importsTable.$inferSelect;
