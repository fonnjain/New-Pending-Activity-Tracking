import {
  pgTable,
  serial,
  text,
  date,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A permanent, append-only store of distinct (full-row-hash) source rows.
// Rows are never mutated or deleted; deduplication happens across uploads via `hash`.
export const recordPoolTable = pgTable("record_pool", {
  id: serial("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  job: text("job").notNull(),
  structure: text("structure").notNull(),
  markTail: text("mark_tail").notNull(),
  markId: text("mark_id").notNull(),
  // Derived from "Mark No." (col H). See parse.ts deriveMark for the three cases.
  mNo: text("m_no").notNull().default(""),
  // IS/SC/S rows only (the 4-part markNumber's project-mark token); "" otherwise.
  proMno: text("pro_mno").notNull().default(""),
  projectSuffix: text("project_suffix").notNull().default(""),
  aliasCorrected: text("alias_corrected").notNull().default(""),
  markNumber: text("mark_number").notNull().default(""),
  orderNature: text("order_nature"),
  contractor: text("contractor"),
  jobCardNo: text("job_card_no"),
  towerType: text("tower_type"),
  towerSubType: text("tower_sub_type"),
  alias: text("alias"),
  markNo: text("mark_no").notNull(),
  section: text("section"),
  length: doublePrecision("length"),
  width: doublePrecision("width"),
  wtPcs: doublePrecision("wt_pcs"),
  balanceQty: doublePrecision("balance_qty").notNull(),
  balanceWt: doublePrecision("balance_wt").notNull(),
  assignDate: date("assign_date", { mode: "string" }),
  // Col S (19th). Drives ageing (today - lastProductionDate). Blank for ~32% of
  // rows; nullable. Part of the row hash so a changed production date is a real change.
  lastProductionDate: date("last_production_date", { mode: "string" }),
  activity: text("activity"),
  operation: text("operation"),
  refJobCardNo: text("ref_job_card_no"),
});

export const insertRecordPoolSchema = createInsertSchema(recordPoolTable).omit({
  id: true,
});
export type InsertRecordPool = z.infer<typeof insertRecordPoolSchema>;
export type RecordPoolRow = typeof recordPoolTable.$inferSelect;
