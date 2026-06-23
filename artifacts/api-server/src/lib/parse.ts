import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import type { InsertRecordPool, ParseSummary } from "@workspace/db";

export type { ParseSummary };

// A parsed source row, identical in shape to a record_pool insert plus its
// content hash. In-sheet duplicates are PRESERVED (no within-file de-dup).
export type ParsedRow = Omit<InsertRecordPool, "hash"> & { hash: string };

export interface ParseResult {
  rows: ParsedRow[];
  summary: ParseSummary;
}

type Cell = string | number | boolean | Date | null | undefined;
type RawRow = Record<string, Cell>;

function cellToString(value: Cell): string {
  if (value == null) return "";
  if (value instanceof Date) return formatDate(value) ?? "";
  return String(value).trim();
}

// Bucket label for rows that genuinely have no Project Code (project-less item
// types like RSJ POLE / EARTHING / GENERAL, or rows whose Order Nature is
// blank/unknown). Stored as the `job` value so they group/filter under their own
// selectable group in the UI without borrowing a project from an adjacent row.
export const UNASSIGNED_JOB = "(Unassigned)";

function normalizeProject(value: Cell): string {
  let s = cellToString(value);
  if (!s) return "";
  // "920.0" -> "920", "794." -> "794"
  s = s.replace(/\.0+$/, "");
  s = s.replace(/\.$/, "");
  return s.trim();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(value: Cell): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(
      value.getUTCDate(),
    )}`;
  }
  if (typeof value === "number") {
    // Excel serial date
    const parsed = XLSX.SSF?.parse_date_code?.(value);
    if (parsed && parsed.y) {
      return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
    }
    return null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate(),
  )}`;
}

function toNumber(value: Cell): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value: Cell): string | null {
  const s = cellToString(value);
  return s === "" ? null : s;
}

// Column names exactly as they appear on the third row of Sheet1
const COL = {
  projectCode: "Project Code",
  orderNature: "Order Nature",
  contractor: "Contractor",
  jobCard: "Job Card No.",
  towerType: "Tower Type",
  towerSubType: "Tower Sub Type",
  alias: "Alias",
  markNo: "Mark No.",
  section: "Section",
  length: "Length",
  width: "Width",
  wtPcs: "Wt/Pcs",
  balanceQty: "Balance Qty.",
  balanceWt: "Balance Wt.",
  assignDate: "Assign Date",
  activity: "Activity",
  operation: "Operation",
  refJobCard: "Ref. Job Card No.",
} as const;

// Derived identity for a Mark No. (col H). See the consolidated Rules A-D below
// (VTPL Mark-Number parsing). Only IS/SC/S rows (col G) get a `proMno` and a
// 4-part markNumber; every other row keeps the 3-part form.
export interface DerivedMark {
  structure: string; // = aliasCorrected (the structure/alias code)
  markTail: string; // = mNo (the mark's own number, kept whole)
  mNo: string;
  proMno: string; // IS/SC/S rows only; "" otherwise
  projectSuffix: string; // legacy; superseded by proMno (kept for back-compat)
  aliasCorrected: string; // = structure
  markNumber: string; // canonical mark key (aligns with markId)
}

// Separator used to compose markNumber: " \ " (space-backslash-space).
const MARK_SEP = " \\ ";

// Compose a DerivedMark. 4-part markNumber when proMno is set (IS/SC/S), else a
// 3-part "project \ structure \ mNo", or the bare mNo when there is no project
// or structure (bare marks).
function makeMark(
  project: string,
  structure: string,
  mNo: string,
  proMno: string,
): DerivedMark {
  let markNumber: string;
  if (proMno) {
    markNumber = [project, proMno, structure, mNo].join(MARK_SEP);
  } else if (project || structure) {
    markNumber = [project, structure, mNo].join(MARK_SEP);
  } else {
    markNumber = mNo;
  }
  return {
    structure,
    markTail: mNo,
    mNo,
    proMno,
    projectSuffix: "",
    aliasCorrected: structure,
    markNumber,
  };
}

export function deriveMark(
  markNo: string,
  job: string,
  alias: string,
): DerivedMark {
  const h = markNo.trim();
  const A = job.trim();
  const G = alias.trim();
  const gUpper = G.toUpperCase();
  const isISSC = gUpper === "IS" || gUpper === "SC" || gUpper === "S";

  // RULE A — bare mark: no space, no backslash, and both col A and col G empty
  // (Earthing / General / RSJ Pole). markNumber = mNo (may be non-numeric).
  if (!h.includes(" ") && !h.includes("\\") && A === "" && G === "") {
    return makeMark("", "", h, "");
  }

  // RULE B — IS / SC / S rows: the only rows that get a proMno and a 4-part
  // markNumber "project \ proMno \ structure \ mNo".
  if (isISSC) {
    // 1. Strip the "<A> <G>-" prefix to get the body.
    const prefix = `${A} ${G}-`;
    let body: string;
    if (h.startsWith(prefix)) {
      body = h.slice(prefix.length);
    } else {
      // Defensive: peel a leading "<A> " then a leading "<G>" + separator.
      let rest = A && h.startsWith(`${A} `) ? h.slice(A.length + 1) : h;
      if (rest.toUpperCase().startsWith(gUpper)) {
        rest = rest.slice(G.length).replace(/^[\\\- ]/, "");
      }
      body = rest;
    }
    body = body.trim();

    // 2. Strip a leading "VT" only when it sits directly before the inner
    // project digits (e.g. "VT837" -> "837"). "VT" inside structure codes like
    // "3IVTS"/"2CVT" is left intact because it is not at the start.
    if (/^VT\d/.test(body)) body = body.slice(2);

    // 3. Absorb an inner numeric project token (optional trailing dot) into
    // proMno when it is followed by a separator/letters or ends the body.
    let proMno: string;
    const m = body.match(/^(\d+\.?)(?=$|[\\\- ]|[A-Za-z])/);
    if (m) {
      const num = m[1];
      proMno = `${G}-${num}`;
      body = body.slice(num.length).replace(/^[\\\- ]/, "");
    } else {
      proMno = G;
    }

    // 4. structure = first token (split on first \, -, or space); mNo = the
    // rest, kept whole (variant letters and trailing tokens like "R-4" intact).
    const sepIdx = body.search(/[\\\- ]/);
    let structure: string;
    let mNo: string;
    if (sepIdx === -1) {
      structure = body;
      mNo = "";
    } else {
      structure = body.slice(0, sepIdx);
      mNo = body.slice(sepIdx + 1).trim();
    }
    return makeMark(A, structure, mNo, proMno);
  }

  // RULE D — backslash form, non-IS/SC: structure = segment before the LAST
  // backslash, mNo = segment after it (kept whole). 3-part markNumber.
  if (h.includes("\\")) {
    const idx = h.lastIndexOf("\\");
    let structure = h.slice(0, idx).trim();
    const mNo = h.slice(idx + 1).trim();
    // Drop a leading "<A> " so the project is not duplicated inside structure.
    if (A && structure.startsWith(`${A} `)) {
      structure = structure.slice(A.length + 1).trim();
    }
    return makeMark(A, structure, mNo, "");
  }

  // RULE C — standard space form "<A> <G>-<mNo>", non-IS/SC. structure = col G;
  // mNo = remainder after the known prefix, kept whole (do NOT split on the
  // first dash — the alias itself may contain a dash, e.g. "2DF-5").
  const structure = G;
  const prefix = `${A} ${G}-`;
  let mNo: string;
  if (A && G && h.startsWith(prefix)) {
    mNo = h.slice(prefix.length).trim();
  } else {
    // Defensive: strip up to and including the FIRST hyphen (or keep as-is).
    const idx = h.indexOf("-");
    mNo = idx >= 0 ? h.slice(idx + 1).trim() : h;
  }
  return makeMark(A, structure, mNo, "");
}

// Canonical, order-stable serialization of all normalized source fields, hashed
// to a hex digest. Two rows with identical normalized content share a hash.
function hashRow(row: Omit<InsertRecordPool, "hash">): string {
  const parts = [
    row.job,
    row.orderNature,
    row.contractor,
    row.jobCardNo,
    row.towerType,
    row.towerSubType,
    row.alias,
    row.markNo,
    row.section,
    row.length,
    row.width,
    row.wtPcs,
    row.balanceQty,
    row.balanceWt,
    row.assignDate,
    row.activity,
    row.operation,
    row.refJobCardNo,
  ].map((v) => (v == null ? "\u0000" : String(v)));
  return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

// Scan the first ~10 rows of a sheet-as-grid for a cell whose trimmed text
// equals "Project Code" (case-insensitive); return that 0-based row index, or
// null when none is found.
function detectHeaderInGrid(grid: unknown[][]): number | null {
  const limit = Math.min(grid.length, 10);
  for (let i = 0; i < limit; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) {
      if (
        typeof cell === "string" &&
        cell.trim().toLowerCase() === "project code"
      ) {
        return i;
      }
    }
  }
  return null;
}

// The header is no longer assumed to be on the third row. Falls back to index 2
// when no "Project Code" header is found.
export function detectHeaderRow(ws: XLSX.WorkSheet): number {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: true,
  });
  return detectHeaderInGrid(grid) ?? 2;
}

// Descriptive fields that may be value-cleaned before commit. Deliberately
// EXCLUDES anything that changes row identity (job/structure/markTail/markNo/
// alias) or any computed/engine field. Mirrors the AI sanitize allow-list.
export const CLEANABLE_FIELDS = [
  "contractor",
  "section",
  "assignDate",
  "towerType",
  "towerSubType",
  "orderNature",
  "refJobCardNo",
] as const;
export type CleanableField = (typeof CLEANABLE_FIELDS)[number];

// Descriptive fields whose cleanups must preserve the exact alphanumeric token
// sequence (formatting-only: whitespace, punctuation-spacing, casing). Every
// cleanable field EXCEPT assignDate is token-preserving — date normalization
// (e.g. "1/5/2025" -> "2025-01-05") legitimately changes the tokens, names do
// not.
const TOKEN_PRESERVING_FIELDS = new Set<string>(
  CLEANABLE_FIELDS.filter((f) => f !== "assignDate"),
);

// Canonical alphanumeric token sequence of a value: lowercased, runs of
// non-alphanumeric collapsed to a single space, trimmed. Two values share this
// when they differ only by whitespace, punctuation-spacing, or casing.
export function alnumTokens(s: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A cleanup on a name-like field is "truncating/merging" when it drops or adds
// real tokens (e.g. "DASHMESH ENTERPRISES GP-2" -> "DASHMESH ENTERPRISES").
// Such a change merges DISTINCT entities and corrupts analytics, so it must be
// rejected server-side regardless of what the model proposes.
export function isTruncatingCleanup(
  field: string,
  from: string | null,
  to: string | null,
): boolean {
  if (!TOKEN_PRESERVING_FIELDS.has(field)) return false;
  return alnumTokens(from) !== alnumTokens(to);
}

export interface Cleanup {
  field: string;
  from: string | null;
  to: string | null;
}

const NULL_SENTINEL = "\u0000__null__";

function buildCleanupMap(
  cleanups: Cleanup[] | undefined,
): Map<CleanableField, Map<string, string | null>> {
  const map = new Map<CleanableField, Map<string, string | null>>();
  if (!cleanups) return map;
  const allowed = new Set<string>(CLEANABLE_FIELDS);
  for (const c of cleanups) {
    if (!allowed.has(c.field)) continue;
    const field = c.field as CleanableField;
    let inner = map.get(field);
    if (!inner) {
      inner = new Map();
      map.set(field, inner);
    }
    inner.set(c.from ?? NULL_SENTINEL, c.to);
  }
  return map;
}

// Resolve the worksheet to parse (Sheet1 when present, else the first sheet).
function resolveSheet(buffer: Buffer): { name: string; ws: XLSX.WorkSheet } {
  const wb = XLSX.read(buffer, { cellDates: true });
  const name = wb.SheetNames.includes("Sheet1")
    ? "Sheet1"
    : wb.SheetNames[0];
  if (!name) throw new Error("Workbook has no sheets");
  const ws = wb.Sheets[name];
  if (!ws) throw new Error("Could not read sheet");
  return { name, ws };
}

export interface StructuralRead {
  sheetName: string | null;
  headerRow: number | null;
  columnsFound: string[];
  missingColumns: string[];
  rowsRead: number;
  rowsWithMark: number;
  problems: string[];
}

// Best-effort, AI-free structural read of an uploaded file. Never authoritative;
// used by the staging flow to describe the file before commit.
export function readStructural(buffer: Buffer): StructuralRead {
  let name: string;
  let ws: XLSX.WorkSheet;
  try {
    ({ name, ws } = resolveSheet(buffer));
  } catch {
    return {
      sheetName: null,
      headerRow: null,
      columnsFound: [],
      missingColumns: Object.values(COL),
      rowsRead: 0,
      rowsWithMark: 0,
      problems: ["The file could not be read as a spreadsheet."],
    };
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: true,
  });
  const detected = detectHeaderInGrid(grid);
  const headerRow = detected ?? 2;
  const headerCells = Array.isArray(grid[headerRow]) ? grid[headerRow] : [];
  const columnsFound = headerCells
    .map((c) => (typeof c === "string" ? c.trim() : c == null ? "" : String(c)))
    .filter((c) => c.length > 0);

  const found = new Set(columnsFound);
  const expected = Object.values(COL);
  const missingColumns = expected.filter((c) => !found.has(c));

  const rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, {
    range: headerRow,
    defval: null,
    raw: true,
  });
  const rowsRead = rawRows.length;
  let rowsWithMark = 0;
  for (const row of rawRows) {
    if (cellToString(row[COL.markNo])) rowsWithMark++;
  }

  const problems: string[] = [];
  if (detected === null) {
    problems.push(
      'No "Project Code" header row was found in the first rows; assuming the third row.',
    );
  }
  if (missingColumns.length > 0) {
    problems.push(`Missing expected columns: ${missingColumns.join(", ")}.`);
  }
  if (rowsWithMark === 0) {
    problems.push('No data rows have a non-empty "Mark No.".');
  }

  return {
    sheetName: name,
    headerRow,
    columnsFound,
    missingColumns,
    rowsRead,
    rowsWithMark,
    problems,
  };
}

export function parseWorkbook(
  buffer: Buffer,
  cleanups?: Cleanup[],
): ParseResult {
  const { ws } = resolveSheet(buffer);

  // Header is no longer fixed to the third row. Scan the first rows for the one
  // that contains a cell exactly equal to "Project Code"; data begins on the
  // next row. Falls back to the third row (index 2) when not found.
  const headerRow = detectHeaderRow(ws);
  const cleanupMap = buildCleanupMap(cleanups);
  const rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, {
    range: headerRow,
    defval: null,
    raw: true,
  });

  let rowsRead = 0;
  let lastProject = "";
  const projects = new Set<string>();
  const rows: ParsedRow[] = [];

  for (const row of rawRows) {
    rowsRead++;

    const orderNature = emptyToNull(row[COL.orderNature]);

    // Conditional forward-fill of Project Code. A blank Project Code is only a
    // "continuation of the structure group above" for Structure rows, which
    // inherit the last seen project. Project-less item types (RSJ POLE,
    // EARTHING, GENERAL) — and any row whose Order Nature is blank/unknown —
    // genuinely have no project and must NOT borrow one from an adjacent row;
    // they are bucketed under "(Unassigned)" instead.
    const rawProject = normalizeProject(row[COL.projectCode]);
    if (rawProject) lastProject = rawProject;

    // The real project for this row: its own code, or — only for Structure
    // members with a blank code — the inherited group project. Project-less item
    // types (RSJ POLE / EARTHING / GENERAL) and blank/unknown Order Nature get
    // no project (and a leading Structure row with no project yet also falls
    // through to "(Unassigned)" rather than a silent empty job).
    const isStructure = (orderNature ?? "").trim().toLowerCase() === "structure";
    const effectiveProject = rawProject || (isStructure ? lastProject : "");
    // Stored/displayed grouping value.
    const job = effectiveProject || UNASSIGNED_JOB;
    // Value fed to mark derivation: empty for unassigned rows so their mark
    // identity stays the bare m_no (e.g. "1") and does not embed a borrowed job.
    const jobForMark = effectiveProject;

    // keep only rows with a Mark No.
    const markNo = cellToString(row[COL.markNo]);
    if (!markNo) continue;

    const alias = emptyToNull(row[COL.alias]);
    const aliasStr = alias ?? "";
    const { structure, markTail, mNo, proMno, projectSuffix, aliasCorrected, markNumber } =
      deriveMark(markNo, jobForMark, aliasStr);
    // markNumber is the canonical mark key; markId aligns with it.
    const markId = markNumber;

    if (job && job !== UNASSIGNED_JOB) projects.add(job);

    const base: Omit<InsertRecordPool, "hash"> = {
      job,
      structure,
      markTail,
      markId,
      mNo,
      proMno,
      projectSuffix,
      aliasCorrected,
      markNumber,
      orderNature,
      contractor: emptyToNull(row[COL.contractor]),
      jobCardNo: emptyToNull(row[COL.jobCard]),
      towerType: emptyToNull(row[COL.towerType]),
      towerSubType: emptyToNull(row[COL.towerSubType]),
      alias,
      markNo,
      section: emptyToNull(row[COL.section]),
      length: toNumber(row[COL.length]),
      width: toNumber(row[COL.width]),
      wtPcs: toNumber(row[COL.wtPcs]),
      balanceQty: toNumber(row[COL.balanceQty]) ?? 0,
      balanceWt: toNumber(row[COL.balanceWt]) ?? 0,
      assignDate: formatDate(row[COL.assignDate]),
      activity: emptyToNull(row[COL.activity]),
      operation: emptyToNull(row[COL.operation]),
      refJobCardNo: emptyToNull(row[COL.refJobCard]),
    };

    // Apply accepted descriptive-field cleanups (value remap) BEFORE hashing so
    // cleaned rows dedup correctly. Identity fields are never touched here.
    if (cleanupMap.size > 0) {
      for (const field of CLEANABLE_FIELDS) {
        const inner = cleanupMap.get(field);
        if (!inner) continue;
        const cur = base[field] as string | null;
        const key = cur ?? NULL_SENTINEL;
        if (inner.has(key)) {
          (base as Record<string, unknown>)[field] = inner.get(key) ?? null;
        }
      }
    }

    rows.push({ ...base, hash: hashRow(base) });
  }

  const distinct = new Set(rows.map((r) => r.hash));
  const missingContractor = rows.filter((r) => r.contractor == null).length;
  const missingDate = rows.filter((r) => r.assignDate == null).length;

  return {
    rows,
    summary: {
      rowsRead,
      rowsKept: rows.length,
      distinctRows: distinct.size,
      duplicateRowCopies: rows.length - distinct.size,
      projectsFound: projects.size,
      missingContractor,
      missingDate,
    },
  };
}

export function computeAgeing(assignDate: string | null): number | null {
  if (!assignDate) return null;
  const d = new Date(`${assignDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const diff = todayUtc - d.getTime();
  return Math.floor(diff / 86400000);
}

export function computeRoute(
  operation: string | null,
  activity: string | null,
): { routeSteps: string[]; currentStepIndex: number | null } {
  const routeSteps = (operation ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!activity) return { routeSteps, currentStepIndex: null };
  const idx = routeSteps.findIndex((s) => s === activity);
  return { routeSteps, currentStepIndex: idx >= 0 ? idx : null };
}
