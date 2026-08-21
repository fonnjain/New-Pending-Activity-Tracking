// Lightweight reader that computes the Release Balance Computed aggregate from
// a WIP workbook buffer. Reads ONLY six columns (Type, Job Card Status, Project
// Code, Alias, Balance Wt., Batch No.) — purely for the new additive overlay.
// Does NOT alter any existing parsing, hashing, dedup, ageing, Activity, or
// qty logic.
//
// Filters: Col A "Type" == "Job Card Not Started" AND Col G "Job Card Status"
// == "Initial". Sums Col Q "Balance Wt." (kg) ÷ 1000 → MT, grouped by
// (normalizedProject, structure, mfcBatch).
//
// mfcBatch is the WIP file "Batch No." / "WO Batch No." (col U/X), upper-cased;
// blank → 'Z' (the app-wide placeholder for "no batch assigned").
//
// Storage is scoped per import_id: recomputeReleaseBalance() deletes only the
// rows for the given import before reinserting, so historical imports are never
// overwritten by a newer upload.
import * as XLSX from "xlsx";
import { normalizeProject, detectHeaderRow, isCsvWip, parseWorkbook } from "./parse";
import {
  db,
  releaseBalanceWipTable,
  assignmentBalanceWipTable,
  importRowsTable,
  recordPoolTable,
  importsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

type Cell = string | number | boolean | null | undefined;

function cellStr(v: Cell): string {
  if (v == null) return "";
  return String(v).trim();
}

function cellNum(v: Cell): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export interface ReleaseBalanceStructureRow {
  project: string;
  structure: string;
  mfcBatch: string;
  releaseBalanceComputedMt: number;
}

export function parseWipReleaseBalance(
  buffer: Buffer,
): ReleaseBalanceStructureRow[] {
  if (isCsvWip(buffer)) {
    const agg = new Map<string, number>();
    for (const row of parseWorkbook(buffer).rows) {
      if (
        (row.jobCardType ?? "").trim().toLowerCase() !== "job card not started" ||
        (row.jobCardStatus ?? "").trim().toLowerCase() !== "initial"
      ) {
        continue;
      }
      if (!row.job || row.job === "(Unassigned)" || !row.structure) continue;
      const key = `${row.job}\u0000${row.structure}\u0000${row.mfcBatch ?? "Z"}`;
      agg.set(key, (agg.get(key) ?? 0) + (row.balanceWt ?? 0) / 1000);
    }
    return Array.from(agg.entries()).map(([key, releaseBalanceComputedMt]) => {
      const [project, structure, mfcBatch] = key.split("\u0000");
      return { project, structure, mfcBatch, releaseBalanceComputedMt };
    });
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { cellDates: true });
  } catch {
    return [];
  }
  const sheetName = wb.SheetNames.includes("Sheet1")
    ? "Sheet1"
    : wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

  const headerRow = detectHeaderRow(ws);
  type RawRow = Record<string, Cell>;
  const rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, {
    range: headerRow,
    defval: null,
    raw: true,
  });

  // Key: project\u0000structure\u0000mfcBatch
  const agg = new Map<string, number>();

  for (const row of rawRows) {
    const type = cellStr(row["Type"]).toLowerCase();
    const status = cellStr(row["Job Card Status"]).toLowerCase();
    if (type !== "job card not started" || status !== "initial") continue;

    const rawProject = cellStr(row["Project Code"]);
    const project = normalizeProject(rawProject);
    if (!project || project === "(Unassigned)") continue;

    const structure = cellStr(row["Alias"]);
    if (!structure) continue;

    // "WO Batch No." was renamed to "Batch No." in newer file exports.
    const rawBatch = cellStr(row["WO Batch No."] ?? row["Batch No."]);
    const mfcBatch = rawBatch ? rawBatch.toUpperCase() : "Z";

    const balWtKg = cellNum(row["Balance Wt."]) ?? 0;
    const balMt = balWtKg / 1000;

    const key = `${project}\u0000${structure}\u0000${mfcBatch}`;
    agg.set(key, (agg.get(key) ?? 0) + balMt);
  }

  return Array.from(agg.entries()).map(([key, mt]) => {
    const parts = key.split("\u0000");
    return {
      project: parts[0],
      structure: parts[1],
      mfcBatch: parts[2],
      releaseBalanceComputedMt: mt,
    };
  });
}

// Recompute Release Balance for one specific import from its WIP file buffer.
// Only touches rows WHERE import_id = importId — never deletes another import's data.
export async function recomputeReleaseBalance(
  buffer: Buffer,
  importId: number,
): Promise<void> {
  const rows = parseWipReleaseBalance(buffer);
  await db.transaction(async (tx) => {
    // Scoped delete — only this import's rows, never the whole table.
    await tx
      .delete(releaseBalanceWipTable)
      .where(eq(releaseBalanceWipTable.importId, importId));
    if (rows.length > 0) {
      await tx.insert(releaseBalanceWipTable).values(
        rows.map((r) => ({
          importId,
          project: r.project,
          structure: r.structure,
          mfcBatch: r.mfcBatch,
          releaseBalanceComputedMt: r.releaseBalanceComputedMt,
        })),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Pool-based backfill — computes Release Balance for EVERY import directly from
// the record_pool, grouped by (import_id, project, structure, mfc_batch).
//
// This replaces the entire table on every call (TRUNCATE + re-insert) so that:
//  (a) the batch dimension is always correct (derived from record_pool.mfc_batch,
//      never stamped as a blanket 'Z'), and
//  (b) a schema migration that adds the mfc_batch column (default 'Z') does not
//      leave all historical rows incorrectly attributed to a single fake batch.
//
// Invariant: summing across all batches for a (import_id, project, structure)
// produces the same total as the old single-row value — the data is split by
// batch, not changed.
//
// Safe to call at boot: the function is idempotent and fast enough for
// ~20 imports × ~300 structures = ~6,000 rows.
// ---------------------------------------------------------------------------
export async function backfillReleaseBalanceFromPool(): Promise<number> {
  // 1. Get all import IDs.
  const allImports = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(importsTable.id);

  if (allImports.length === 0) return 0;

  // 2. TRUNCATE the table so we re-derive everything at batch grain.
  //    (After a schema migration that added mfc_batch with DEFAULT 'Z', all
  //    existing rows are incorrectly stamped 'Z'. A full re-derive fixes that.)
  await db.delete(releaseBalanceWipTable);

  // 3. For each import, compute from the pool grouped by
  //    (project, structure, mfc_batch).
  //    Release Balance = JCNS + Initial rows (is_initial_cutting = true for
  //    legacy imports, or per-import job_card_status = 'INITIAL' for newer ones).
  const mfcBatchExpr = sql<string>`COALESCE(${recordPoolTable.mfcBatch}, 'Z')`;

  let totalInserted = 0;
  for (const { id: importId } of allImports) {
    const computed = await db
      .select({
        project: recordPoolTable.job,
        structure: recordPoolTable.structure,
        mfcBatch: mfcBatchExpr,
        releaseBalanceComputedMt: sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
      })
      .from(importRowsTable)
      .innerJoin(
        recordPoolTable,
        eq(importRowsTable.poolId, recordPoolTable.id),
      )
      .where(
        and(
          eq(importRowsTable.importId, importId),
          eq(recordPoolTable.category, "TLT"),
          // Use per-import status when available; fall back to pool flag for
          // pre-migration imports where import_rows.job_card_status is null.
          sql`COALESCE(upper(${importRowsTable.jobCardStatus}) = 'INITIAL', ${recordPoolTable.isInitialCutting}, false)`,
        ),
      )
      .groupBy(
        recordPoolTable.job,
        recordPoolTable.structure,
        mfcBatchExpr,
      );

    if (computed.length > 0) {
      await db
        .insert(releaseBalanceWipTable)
        .values(
          computed.map((r) => ({
            importId,
            project: r.project,
            structure: r.structure,
            mfcBatch: r.mfcBatch,
            releaseBalanceComputedMt: r.releaseBalanceComputedMt,
          })),
        );
      totalInserted += computed.length;
    }
  }
  return totalInserted;
}

// ---------------------------------------------------------------------------
// Awaiting Assignment Balance — Col A "Job Card Not Started" AND Col G "Authorized"
// AND Col D (Contractor) blank.
// ---------------------------------------------------------------------------
// Definition: released-but-unassigned work. Excludes Initial (Not Started +
// Initial) rows — those are already in Release Balance.
//
// Under the new six-bucket model, Awaiting Assignment is a PEER bucket to
// Cutting (JCNS + Authorized + non-blank contractor). They are disjoint and
// together partition all JCNS+Authorized work. Both must be INCLUDED in totals —
// neither is a subset of the other, and including both is NOT double-counting.
//
// Observable consequence: Awaiting Assign ≈ 44% of (Awaiting+Cutting) on 30-Jul data.

export interface AssignmentBalanceStructureRow {
  project: string;
  structure: string;
  assignmentBalanceComputedMt: number;
}

export function parseWipAssignmentBalance(
  buffer: Buffer,
): AssignmentBalanceStructureRow[] {
  if (isCsvWip(buffer)) {
    const agg = new Map<string, number>();
    for (const row of parseWorkbook(buffer).rows) {
      if (
        (row.jobCardType ?? "").trim().toLowerCase() !== "job card not started" ||
        (row.jobCardStatus ?? "").trim().toLowerCase() !== "authorized" ||
        (row.contractor ?? "").trim() !== ""
      ) {
        continue;
      }
      if (!row.job || row.job === "(Unassigned)" || !row.structure) continue;
      const key = `${row.job}\u0000${row.structure}`;
      agg.set(key, (agg.get(key) ?? 0) + (row.balanceWt ?? 0) / 1000);
    }
    return Array.from(agg.entries()).map(([key, assignmentBalanceComputedMt]) => {
      const [project, structure] = key.split("\u0000");
      return { project, structure, assignmentBalanceComputedMt };
    });
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { cellDates: true });
  } catch {
    return [];
  }
  const sheetName = wb.SheetNames.includes("Sheet1")
    ? "Sheet1"
    : wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

  const headerRow = detectHeaderRow(ws);
  type RawRow = Record<string, Cell>;
  const rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, {
    range: headerRow,
    defval: null,
    raw: true,
  });

  const agg = new Map<string, number>();

  for (const row of rawRows) {
    const type = cellStr(row["Type"]).toLowerCase();
    if (type !== "job card not started") continue;

    // Must be Authorized — Initial rows are already counted in Release Balance.
    const status = cellStr(row["Job Card Status"]).toLowerCase();
    if (status !== "authorized") continue;

    const contractor = cellStr(row["Contractor"]);
    if (contractor !== "") continue;

    const rawProject = cellStr(row["Project Code"]);
    const project = normalizeProject(rawProject);
    if (!project || project === "(Unassigned)") continue;

    const structure = cellStr(row["Alias"]);
    if (!structure) continue;

    const balWtKg = cellNum(row["Balance Wt."]) ?? 0;
    const balMt = balWtKg / 1000;

    const key = `${project}\u0000${structure}`;
    agg.set(key, (agg.get(key) ?? 0) + balMt);
  }

  return Array.from(agg.entries()).map(([key, mt]) => {
    const sep = key.indexOf("\u0000");
    return {
      project: key.slice(0, sep),
      structure: key.slice(sep + 1),
      assignmentBalanceComputedMt: mt,
    };
  });
}

/**
 * Pool-based backfill of assignment_balance_wip using the LATEST import's
 * record_pool rows. Mirrors the file-based definition exactly:
 *   job_card_type = 'Job Card Not Started'
 *   AND (job_card_status IS NULL OR job_card_status = 'AUTHORIZED')
 *   AND (contractor IS NULL OR contractor = '')
 * Grouped by (project, structure), summed in MT. Replaces the table wholesale
 * (same as the file-based recompute). Safe to call from admin/recompute since
 * it needs no file buffer — derives entirely from what's already in the pool.
 * No-op (clears table) when there are no imports.
 */
export async function backfillAssignmentBalanceFromPool(): Promise<number> {
  // Find the latest import id.
  const [latest] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(sql`${importsTable.id} desc`)
    .limit(1);

  if (!latest) {
    await db.delete(assignmentBalanceWipTable);
    return 0;
  }

  const computed = await db
    .select({
      project: recordPoolTable.job,
      structure: recordPoolTable.structure,
      assignmentBalanceComputedMt: sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(
      and(
        eq(importRowsTable.importId, latest.id),
        sql`COALESCE(${importRowsTable.jobCardType}, ${recordPoolTable.jobCardType}) = 'Job Card Not Started'`,
        // IS NULL allows for marks whose type row lacks a status (transitional).
        // Per-import status takes precedence over pool value.
        sql`(COALESCE(${importRowsTable.jobCardStatus}, ${recordPoolTable.jobCardStatus}) IS NULL OR upper(COALESCE(${importRowsTable.jobCardStatus}, ${recordPoolTable.jobCardStatus})) = 'AUTHORIZED')`,
        sql`(${recordPoolTable.contractor} IS NULL OR trim(${recordPoolTable.contractor}) = '')`,
      ),
    )
    .groupBy(recordPoolTable.job, recordPoolTable.structure);

  await db.transaction(async (tx) => {
    await tx.delete(assignmentBalanceWipTable);
    if (computed.length > 0) {
      await tx.insert(assignmentBalanceWipTable).values(
        computed.map((r) => ({
          project: r.project,
          structure: r.structure,
          assignmentBalanceComputedMt: r.assignmentBalanceComputedMt,
        })),
      );
    }
  });

  return computed.length;
}

export async function recomputeAssignmentBalance(buffer: Buffer): Promise<void> {
  const rows = parseWipAssignmentBalance(buffer);
  await db.transaction(async (tx) => {
    await tx.delete(assignmentBalanceWipTable);
    if (rows.length > 0) {
      await tx.insert(assignmentBalanceWipTable).values(
        rows.map((r) => ({
          project: r.project,
          structure: r.structure,
          assignmentBalanceComputedMt: r.assignmentBalanceComputedMt,
        })),
      );
    }
  });
}
