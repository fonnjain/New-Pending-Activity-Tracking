import {
  pgTable,
  serial,
  text,
  date,
  doublePrecision,
  boolean,
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
  // --- Work Order + MFC batch (source cols T + U; part of the row hash). ---
  // Work Order No. (col T): stored, not used in logic yet (future use).
  workOrderNo: text("work_order_no"),
  // WO Batch No. (col U) = the MFC (Manufacturer Fabrication Clearance) batch
  // letter, meaningful PER PROJECT. Stored NORMALIZED (trim/uppercase, blank ->
  // "Z" so blanks sort AFTER real batches). The RAW pre-"Z" value (not this
  // normalized one) is what joins the row hash, so a real batch change is a real
  // change but the "Z" substitution itself never affects identity. Null on
  // legacy rows (serialized as "Z").
  mfcBatch: text("mfc_batch"),
  // --- Classification (Phase 1, additive; NOT part of the row hash/identity). ---
  // Derived at parse time from Order Nature (authoritative) + Tower Sub Type.
  // "TLT" for Structure rows; "NTLT" for RSJ Pole / Earthing / General; null when
  // unknown. Drives which PROCESS_SEQUENCE a mark's sequence-dependent calcs use.
  category: text("category"),
  // NTLT subtype: "RSJ" | "EARTHING" | "GENERAL"; null for TLT/unknown.
  ntltSubtype: text("ntlt_subtype"),
  // Grouping dimension label: "project" (TLT) | "section" (NTLT). null when unknown.
  groupType: text("group_type"),
  // Resolved grouping key (TLT = job; NTLT = cleaned section / "RSJ <dims>").
  groupKey: text("group_key"),
  // Whether the mark participates in workflow metrics. FOUNDATION BOLT rows are
  // captured but inactive (active=false). Defaults true.
  active: boolean("active").notNull().default(true),
  // --- Hole operation (additive, display/report-only; NOT part of the row hash). ---
  // Derived purely from the immutable Section string (deriveHoleOperation): the
  // section family + a fixed thickness cutoff. Stable across re-imports (no
  // dependence on manual pins / RSJ lookups). Used to sort/filter/report
  // punching vs drilling. Backfilled for legacy rows from the stored `section`.
  // "ANGLE" | "PLATE" | "CHANNEL" | "BEAM" | "RSJ" | "FLAT" | "PIPE" | "ROUND" | "GRATING" | "OTHER".
  sectionType: text("section_type"),
  // "PUNCHING" | "DRILLING" | "NOT_SET"; null only on legacy rows pending backfill.
  holeOperation: text("hole_operation"),
  // "rule_thickness" | "rule_fixed" | "not_applicable" | "unknown".
  holeOperationSource: text("hole_operation_source"),
  // --- Finished Goods (placeholder, additive; NOT part of the row hash/identity). ---
  // Reserved for a future "Finished Goods" status. Left blank (null) everywhere
  // for now — nothing reads or writes it, it is not in any PROCESS_SEQUENCE or
  // ACTIVITY_BUNDLE, and it is excluded from the row hash so it never affects
  // dedup/identity. Nullable so legacy rows stay valid.
  fg: text("fg"),
  // --- WIP case classification (additive, NOT part of the row hash). ---
  // Raw "Job Card Status" (Col G) from the Excel file. Two closed values:
  // "Initial" | "Authorized". Null for old-format rows (no Status column).
  // Stored so classifyWipCase() can use it directly without proxies.
  jobCardStatus: text("job_card_status"),
  // True when Col G (Job Card Status) = "Initial", regardless of Activity.
  // In the newer WIP format the Activity column holds the PLANNED activity for
  // scheduling, NOT the current production stage — a mark at Activity=RFI with
  // Status=Initial has NOT started RFI; it is unreleased raw material counted in
  // Release Balance. Only Status="Authorized" marks have been physically released.
  // Defaults false (safe for old-format rows that have no Job Card Status column).
  isInitialCutting: boolean("is_initial_cutting").notNull().default(false),
});

export const insertRecordPoolSchema = createInsertSchema(recordPoolTable).omit({
  id: true,
});
export type InsertRecordPool = z.infer<typeof insertRecordPoolSchema>;
export type RecordPoolRow = typeof recordPoolTable.$inferSelect;
