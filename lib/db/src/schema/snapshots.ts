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

export interface SnapshotSummary {
  rowsRead: number;
  marksAfterDedupe: number;
  projectsFound: number;
  missingContractor: number;
  missingDate: number;
  duplicateMarksCollapsed: number;
}

export const snapshotsTable = pgTable("snapshots", {
  id: serial("id").primaryKey(),
  label: text("label"),
  sourceFilename: text("source_filename").notNull(),
  reportDate: date("report_date", { mode: "string" }),
  summary: jsonb("summary").$type<SnapshotSummary>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSnapshotSchema = createInsertSchema(snapshotsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSnapshot = z.infer<typeof insertSnapshotSchema>;
export type Snapshot = typeof snapshotsTable.$inferSelect;
