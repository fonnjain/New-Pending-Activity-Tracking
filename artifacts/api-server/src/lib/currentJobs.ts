import * as XLSX from "xlsx";
import { desc, eq } from "drizzle-orm";
import {
  db,
  currentJobsImportTable,
  currentJobsTable,
  importsTable,
  importRowsTable,
  recordPoolTable,
  orderReviewImportsTable,
  orderReviewRowsTable,
  type CurrentJobsImportRow,
  type CurrentJobRow,
} from "@workspace/db";
import { normalizeProject } from "./parse";

// "Current Jobs" — a LIST OF PROJECT CODES ONLY (one column, no structures, no
// weights). Purely additive: never touches WIP/Order Review parsing, hashing,
// dedup, ageing, Activity, or qty. Each upload REPLACES the previous list.

const HEADER_TOKENS = new Set(["project", "project code", "code", "job"]);

// Trailing summary rows some exports append at the bottom of the Project Code
// column (e.g. a "TOTAL" row with a structure count in another column) are
// not real project codes and must never be treated as an unmatched code.
const FOOTER_TOKENS = new Set(["total", "totals", "grand total"]);

// Scan the first ~10 rows for a cell whose trimmed text matches a known header
// token; return its {row, col}, or null when no such cell is found (plain
// single-column files with no header row).
function detectHeaderCell(rows: unknown[][]): { row: number; col: number } | null {
  const limit = Math.min(rows.length, 10);
  for (let r = 0; r < limit; r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      if (typeof cell === "string" && HEADER_TOKENS.has(cell.trim().toLowerCase())) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

// Parse the first sheet: auto-detect a "Project Code"-style header cell
// anywhere in the first ~10 rows (title/subtitle preamble rows are common in
// real exports) and read that column from the next row onward. Falls back to
// column 0 of every row when no header token is found (plain single-column
// list with no header at all). Normalizes every code with the SAME
// normalizer WIP/Order Review use (strip trailing "." / ".0"), and
// de-duplicates within the file.
export function parseCurrentJobsFile(buffer: Buffer): { codes: string[] } {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return { codes: [] };

  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });

  const headerCell = detectHeaderCell(rows);
  const col = headerCell?.col ?? 0;
  const startRow = headerCell ? headerCell.row + 1 : 0;

  const seen = new Set<string>();
  const codes: string[] = [];
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const cell = row?.[col];
    if (cell == null || cell === "") continue;
    const raw = cell instanceof Date ? "" : String(cell).trim();
    if (!raw) continue;
    const lower = raw.trim().toLowerCase();
    if (HEADER_TOKENS.has(lower) || FOOTER_TOKENS.has(lower)) continue;
    const normalized = normalizeProject(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    codes.push(normalized);
  }
  return { codes };
}

// "Known project" = normalized projects present in the latest WIP import
// (record_pool) UNION the latest Order Review import (order_review_rows).
async function loadKnownProjects(): Promise<Set<string>> {
  const known = new Set<string>();

  const [latestWip] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);
  if (latestWip) {
    const rows = await db
      .select({ job: recordPoolTable.job })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, latestWip.id));
    for (const r of rows) {
      if (r.job) known.add(r.job);
    }
  }

  const [latestOrderReview] = await db
    .select({ id: orderReviewImportsTable.id })
    .from(orderReviewImportsTable)
    .orderBy(desc(orderReviewImportsTable.id))
    .limit(1);
  if (latestOrderReview) {
    const rows = await db
      .select({ project: orderReviewRowsTable.project })
      .from(orderReviewRowsTable)
      .where(eq(orderReviewRowsTable.importId, latestOrderReview.id));
    for (const r of rows) {
      if (r.project) known.add(r.project);
    }
  }

  return known;
}

export interface IngestCurrentJobsResult {
  header: CurrentJobsImportRow;
  codes: string[];
}

// Replace semantics: clears the current list and inserts the new set, plus a
// header row for provenance, in one transaction.
export async function ingestCurrentJobs(
  fileName: string,
  codes: string[],
): Promise<IngestCurrentJobsResult> {
  const known = await loadKnownProjects();
  const unmatched = codes.filter((c) => !known.has(c));
  const matchedCount = codes.length - unmatched.length;

  const header = await db.transaction(async (tx) => {
    await tx.delete(currentJobsTable);
    if (codes.length > 0) {
      await tx.insert(currentJobsTable).values(codes.map((projectCode) => ({ projectCode })));
    }
    const [row] = await tx
      .insert(currentJobsImportTable)
      .values({
        fileName,
        codeCount: codes.length,
        matchedCount,
        unmatched,
      })
      .returning();
    return row!;
  });

  return { header, codes };
}

export interface CurrentJobsState {
  codes: string[];
  meta: CurrentJobsImportRow | null;
}

export async function loadCurrentJobs(): Promise<CurrentJobsState> {
  const rows: CurrentJobRow[] = await db
    .select()
    .from(currentJobsTable)
    .orderBy(currentJobsTable.projectCode);
  const [meta] = await db
    .select()
    .from(currentJobsImportTable)
    .orderBy(desc(currentJobsImportTable.id))
    .limit(1);
  return { codes: rows.map((r) => r.projectCode), meta: meta ?? null };
}

export async function clearCurrentJobs(): Promise<void> {
  await db.delete(currentJobsTable);
}
