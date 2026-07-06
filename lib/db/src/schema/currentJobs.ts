import { pgTable, serial, text, integer, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// "Current Jobs" — a small additive overlay: a user-uploaded LIST OF PROJECT
// CODES ONLY (no structures, no weights). Selecting "Current Jobs" in the
// existing Job filter restricts every page to projects in this list (a
// set-membership filter mode, alongside "All" and single-job equality).
// Each upload REPLACES the list entirely (not append). Never touches WIP /
// Order Review parsing, hashing, dedup, ageing, or Activity/qty.

// One row per upload, for provenance/timestamp/history — mirrors the header
// tables the other two file types already have (imports / order_review_imports).
export const currentJobsImportTable = pgTable("current_jobs_import", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Distinct normalized codes stored from this upload.
  codeCount: integer("code_count").notNull(),
  // How many of those codes matched a project known to the latest WIP import
  // (record_pool) or the latest Order Review import (order_review_rows).
  matchedCount: integer("matched_count").notNull(),
  // Normalized codes from this upload that matched neither — stored (not
  // dropped) so the filter still works once the code shows up in a later
  // file, and surfaced as a non-blocking notice in the UI.
  unmatched: jsonb("unmatched").$type<string[]>().notNull(),
});

export const insertCurrentJobsImportSchema = createInsertSchema(
  currentJobsImportTable,
).omit({ id: true, uploadedAt: true });
export type InsertCurrentJobsImport = z.infer<
  typeof insertCurrentJobsImportSchema
>;
export type CurrentJobsImportRow = typeof currentJobsImportTable.$inferSelect;

// The CURRENT list itself — always fully replaced by the latest upload (or
// emptied by an explicit clear). Every uploaded code is stored here regardless
// of match, so the filter works even for a code not yet present in WIP/Order
// Review data.
export const currentJobsTable = pgTable(
  "current_jobs",
  {
    id: serial("id").primaryKey(),
    projectCode: text("project_code").notNull(),
  },
  (t) => [unique("current_jobs_project_code_uq").on(t.projectCode)],
);

export const insertCurrentJobSchema = createInsertSchema(currentJobsTable).omit({
  id: true,
});
export type InsertCurrentJob = z.infer<typeof insertCurrentJobSchema>;
export type CurrentJobRow = typeof currentJobsTable.$inferSelect;
