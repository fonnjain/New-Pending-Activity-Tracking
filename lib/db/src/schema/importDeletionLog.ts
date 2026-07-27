import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/** Append-only audit trail: every deleted WIP or Order Review import is logged
 *  here with who deleted it and when. The original importId is kept for
 *  reference (it will be gone from the imports table by the time anyone reads
 *  this log). */
export const importDeletionLogTable = pgTable("import_deletion_log", {
  id: serial("id").primaryKey(),
  // The original import id at the time of deletion.
  importId: integer("import_id"),
  // "wip" or "order-review"
  fileType: text("file_type").notNull(),
  sourceFilename: text("source_filename").notNull(),
  // The "as on" / report date of the file (YYYY-MM-DD). Null if not recorded.
  reportDate: text("report_date"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  // Display name or email of the deleting user.
  deletedBy: text("deleted_by").notNull(),
});

export type ImportDeletionLogRow = typeof importDeletionLogTable.$inferSelect;
