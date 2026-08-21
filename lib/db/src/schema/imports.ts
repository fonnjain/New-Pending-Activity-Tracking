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
  // NTLT rows (RSJ POLE / EARTHING / GENERAL) with no project code, attributed
  // to "(Unassigned)" grouped by Section (Col L). Absent when zero such rows exist.
  ntltOrphanCount?: number;
  ntltOrphanWtMt?: number;
  // Rows whose Order Nature (Col C) was not one of the four known values
  // (Structure / RSJ POLE / EARTHING / GENERAL). Treated as NTLT by default.
  // Absent when zero such rows exist (the normal case).
  unknownOrderNatureCount?: number;
  // NTLT Sections (Col L) that map to more than one Tower Type (Col H) within
  // this file — a source-data quality signal, not a parse error. Each entry:
  //   { section, towerTypes: string[], marks: number }
  // Absent when all Sections are 1:1 with a Tower Type.
  ntltSectionMismatches?: Array<{ section: string; towerTypes: string[]; marks: number }>;
  // Rows whose Col A "Type" or Col G "Job Card Status" did not match any of the
  // verified closed value sets.  A non-zero count signals a file format change.
  // Absent (or zero) in the normal case.  Up to 5 distinct type+status combos
  // are captured as samples to aid diagnosis.
  unclassifiedRowCount?: number;
  // Total Balance Wt. (kg) of unclassified rows — same population as
  // unclassifiedRowCount. Absent when zero such rows exist (normal case).
  unclassifiedWtKg?: number;
  unclassifiedSamples?: Array<{ type: string; status: string }>;
  // Finished Goods WIP per project: sum of Balance Wt. (Col Q) for rows where
  // the WIP file's "Type" column (Col A, new ≥Jul-2026 format) equals
  // "FG Pending For Dispatch". Values in kg (same unit as balanceWt).
  // Absent when the file has no FG rows or no "Type" column (old format).
  fgWipByJob?: Record<string, number>;
  // Same breakdown at project+structure granularity. Outer key = project;
  // inner key = alias (uppercased) = structure identifier.
  fgWipByStructure?: Record<string, Record<string, number>>;
  // Source Column Watch (Data Check panel): per-import snapshot of the watched
  // ERP pass-through columns (BOM Status, Is Welded Structure, ...), captured
  // at parse time from THIS file's rows. Descriptive only — never a DC rule,
  // never read for logic. Absent on imports that predate the snapshot; on
  // those, the watched columns were not present in the file. `present: false`
  // means the file was inspected and the column is absent.
  sourceColumnWatch?: Array<{
    key: string;
    header: string;
    present: boolean;
    values: Array<{ value: string | null; marks: number; weightMt: number }>;
    crossTab: Array<{ orderNature: string; value: string | null; marks: number }>;
  }>;
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
