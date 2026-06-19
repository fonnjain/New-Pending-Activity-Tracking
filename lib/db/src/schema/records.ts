import {
  pgTable,
  serial,
  integer,
  text,
  date,
  doublePrecision,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { snapshotsTable } from "./snapshots";

export const recordsTable = pgTable(
  "records",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => snapshotsTable.id, { onDelete: "cascade" }),
    markId: text("mark_id").notNull(),
    job: text("job").notNull(),
    structure: text("structure").notNull(),
    markTail: text("mark_tail").notNull(),
    section: text("section"),
    grade: text("grade"),
    wtPcs: doublePrecision("wt_pcs"),
    balanceQty: doublePrecision("balance_qty").notNull(),
    balanceWt: doublePrecision("balance_wt").notNull(),
    activity: text("activity"),
    operation: text("operation"),
    assignDate: date("assign_date", { mode: "string" }),
    contractor: text("contractor"),
    orderNature: text("order_nature"),
    towerType: text("tower_type"),
  },
  (t) => [unique("records_snapshot_mark_unique").on(t.snapshotId, t.markId)],
);

export const insertRecordSchema = createInsertSchema(recordsTable).omit({
  id: true,
});
export type InsertRecord = z.infer<typeof insertRecordSchema>;
export type RecordRow = typeof recordsTable.$inferSelect;
