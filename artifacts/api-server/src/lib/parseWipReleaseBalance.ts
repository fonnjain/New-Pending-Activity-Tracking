// Lightweight reader that computes the Release Balance Computed aggregate from
// a WIP workbook buffer. Reads ONLY five columns (Type, Job Card Status, Project
// Code, Alias, Balance Wt.) — purely for the new additive overlay. Does NOT
// alter any existing parsing, hashing, dedup, ageing, Activity, or qty logic.
//
// Filters: Col A "Type" == "Job Card Not Started" AND Col G "Job Card Status"
// == "Initial". Sums Col Q "Balance Wt." (kg) ÷ 1000 → MT, grouped by
// (normalizedProject, structure).
//
// Storage is scoped per import_id: recomputeReleaseBalance() deletes only the
// rows for the given import before reinserting, so historical imports are never
// overwritten by a newer upload.
import * as XLSX from "xlsx";
import { normalizeProject, detectHeaderRow } from "./parse";
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
  releaseBalanceComputedMt: number;
}

export function parseWipReleaseBalance(
  buffer: Buffer,
): ReleaseBalanceStructureRow[] {
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
    const status = cellStr(row["Job Card Status"]).toLowerCase();
    if (type !== "job card not started" || status !== "initial") continue;

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
          releaseBalanceComputedMt: r.releaseBalanceComputedMt,
        })),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Pool-based backfill — computes Release Balance for every import directly from
// the record_pool using the is_initial_cutting flag (which captures the same
// "JCNS + Initial" condition as the file-based parser).  Used at boot and via
// the admin recompute endpoint to populate historical imports whose file bytes
// are no longer available.
// ---------------------------------------------------------------------------
export async function backfillReleaseBalanceFromPool(): Promise<number> {
  // 1. Find all imports that already have release_balance_wip rows so we can
  //    skip them (they were populated by the file-based recompute and are already
  //    correct).
  const existingImportIds = new Set<number>(
    (
      await db
        .selectDistinct({ importId: releaseBalanceWipTable.importId })
        .from(releaseBalanceWipTable)
    ).map((r) => r.importId),
  );

  // 2. Get all import IDs.
  const allImports = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(importsTable.id);

  const toBackfill = allImports.filter((i) => !existingImportIds.has(i.id));
  if (toBackfill.length === 0) return 0;

  // 3. For each import without rows, compute from the pool.
  //    Release Balance = sum of balance_wt / 1000 for rows where
  //    is_initial_cutting = true AND category = 'TLT', grouped by (job, structure).
  let totalInserted = 0;
  for (const { id: importId } of toBackfill) {
    const computed = await db
      .select({
        project: recordPoolTable.job,
        structure: recordPoolTable.structure,
        releaseBalanceComputedMt: sql<number>`coalesce(sum(${recordPoolTable.balanceWt}) / 1000.0, 0)`,
      })
      .from(importRowsTable)
      .innerJoin(
        recordPoolTable,
        eq(importRowsTable.poolId, recordPoolTable.id),
      )
      .where(
        and(
          eq(importRowsTable.importId, importId),
          eq(recordPoolTable.isInitialCutting, true),
          eq(recordPoolTable.category, "TLT"),
        ),
      )
      .groupBy(recordPoolTable.job, recordPoolTable.structure);

    if (computed.length > 0) {
      await db
        .insert(releaseBalanceWipTable)
        .values(
          computed.map((r) => ({
            importId,
            project: r.project,
            structure: r.structure,
            releaseBalanceComputedMt: r.releaseBalanceComputedMt,
          })),
        )
        .onConflictDoNothing();
      totalInserted += computed.length;
    }
  }
  return totalInserted;
}

// ---------------------------------------------------------------------------
// Assignment Balance — Col A "Job Card Not Started" AND Col G "Authorized"
// AND Col D (Contractor) blank.
// ---------------------------------------------------------------------------
// Definition: released-but-unassigned work. Excludes Initial (Not Started +
// Initial) rows — those are already in Release Balance. By requiring
// Status="Authorized" Assignment is now a strict subset of Cutting Balance
// (Cutting = JCNS + Authorized regardless of contractor), which means it
// cannot exceed Cutting and the Total column is not double-counted.
//
// Observable consequence: Assignment ≈ 37-42% of Cutting on 21-28 Jul data.

export interface AssignmentBalanceStructureRow {
  project: string;
  structure: string;
  assignmentBalanceComputedMt: number;
}

export function parseWipAssignmentBalance(
  buffer: Buffer,
): AssignmentBalanceStructureRow[] {
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
      assignmentBalanceComputedMt: sql<number>`coalesce(sum(${recordPoolTable.balanceWt}) / 1000.0, 0)`,
    })
    .from(importRowsTable)
    .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
    .where(
      and(
        eq(importRowsTable.importId, latest.id),
        sql`${recordPoolTable.jobCardType} = 'Job Card Not Started'`,
        sql`(${recordPoolTable.jobCardStatus} IS NULL OR upper(${recordPoolTable.jobCardStatus}) = 'AUTHORIZED')`,
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
