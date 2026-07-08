// Lightweight reader that computes the Release Balance Computed aggregate from
// a WIP workbook buffer. Reads ONLY five columns (Type, Job Card Status, Project
// Code, Alias, Balance Wt.) — purely for the new additive overlay. Does NOT
// alter any existing parsing, hashing, dedup, ageing, Activity, or qty logic.
//
// Filters: Col A "Type" == "Job Card Not Started" AND Col G "Job Card Status"
// == "Initial". Sums Col Q "Balance Wt." (kg) ÷ 1000 → MT, grouped by
// (normalizedProject, structure).
import * as XLSX from "xlsx";
import { normalizeProject, detectHeaderRow } from "./parse";
import { db, releaseBalanceWipTable, assignmentBalanceWipTable } from "@workspace/db";

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

export async function recomputeReleaseBalance(buffer: Buffer): Promise<void> {
  const rows = parseWipReleaseBalance(buffer);
  await db.transaction(async (tx) => {
    await tx.delete(releaseBalanceWipTable);
    if (rows.length > 0) {
      await tx.insert(releaseBalanceWipTable).values(
        rows.map((r) => ({
          project: r.project,
          structure: r.structure,
          releaseBalanceComputedMt: r.releaseBalanceComputedMt,
        })),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Assignment Balance — Col A "Job Card Not Started" AND Col D (Contractor) blank
// ---------------------------------------------------------------------------
// Intentional overlap with Release Balance: a "Not Started + Initial" row also
// has a blank contractor, so it is counted in BOTH. Do NOT deduplicate.

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
