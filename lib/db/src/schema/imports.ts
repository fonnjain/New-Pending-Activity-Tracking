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
  // Last Production Entry Date (col S) sanity counts.
  // notStarted: blank production date AND activity == "C" (genuinely not begun).
  // noProductionDate: blank production date AND activity != "C" (progressed but date missing — data-quality flag).
  // futureProductionDate: production date later than today (clamped to today for ageing).
  notStarted: number;
  noProductionDate: number;
  futureProductionDate: number;
  // Rows where Tower Sub Type "NTLT" disagreed with the Order-Nature-derived
  // category (Order Nature is authoritative; the conflict is only counted/flagged).
  classificationConflicts?: number;
  // Finished Goods WIP per project: sum of Balance Wt. (Col Q) for rows where
  // the WIP file's "Type" column (Col A, new ≥Jul-2026 format) equals
  // "FG Pending For Dispatch". Values in the same unit as balanceWt (kg raw
  // from the file). Absent when the file has no FG rows or no "Type" column
  // (old format). Currently null/0 in practice; infrastructure for future use.
  fgWipByJob?: Record<string, number>;
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
  // "As on" date parsed from the report banner (falls back to the upload date).
  // Used ONLY to pair a WIP import with its Order Review by date; never feeds
  // ageing / milestone / dispatch math (those key off reportDate / createdAt).
  asOnDate: date("as_on_date", { mode: "string" }),
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
