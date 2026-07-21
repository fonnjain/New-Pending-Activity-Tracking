import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { deriveHoleOperation } from "@workspace/domain";
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

// --- Phase 1: mark classification (TLT vs NTLT + subtype) ---------------------
// Order Nature (col B) is authoritative. Tower Sub Type "NTLT" is a confirming
// signal only — a disagreement is counted/flagged, never overrides Order Nature.
// Classification is additive and read-time-derived; it is NEVER part of the row
// hash/identity (hashRow lists the 19 source columns explicitly).
export interface MarkClassification {
  category: string | null; // "TLT" | "NTLT" | null
  ntltSubtype: string | null; // "RSJ" | "EARTHING" | "GENERAL" | null
  groupType: string | null; // "project" (TLT) | "section" (NTLT) | null
  groupKey: string | null; // TLT = job; NTLT = cleaned section / "RSJ <dims>"
  active: boolean; // false for FOUNDATION BOLT (captured but excluded)
}

// Trim, collapse internal whitespace, uppercase. Used for NTLT section group keys.
function normalizeSectionKey(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

// Clean an RSJ section into a stable "RSJ <dims>" group key. Drops trailing
// descriptive tokens (e.g. " - [37.1]", "(30.44)", " MS", " MTR") and bracketed
// remarks, then collapses whitespace and uppercases.
function cleanRsjGroupKey(section: string | null): string {
  let s = (section ?? "").trim();
  if (!s) return "RSJ";
  // Drop bracketed remarks: "[...]" and "(...)".
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  // Drop trailing unit/material tokens.
  s = s.replace(/\b(MS|MTR|MTRS|MTR\.|MM|KG|NOS?)\b/gi, " ");
  // Drop dangling separators left behind (e.g. " - ").
  s = s.replace(/[-–]+\s*$/g, " ");
  s = s.replace(/\s+/g, " ").trim().toUpperCase();
  if (!s) return "RSJ";
  return s.startsWith("RSJ") ? s : `RSJ ${s}`;
}

// The four known Order Nature values (Col C). Any other value is treated as
// NTLT by default and counted in the upload sanity check.
const KNOWN_ORDER_NATURES = new Set([
  "STRUCTURE",
  "RSJ POLE",
  "EARTHING",
  "GENERAL",
  "FOUNDATION BOLT",
]);

// Classify a row from its Order Nature (authoritative), Tower Sub Type (confirm
// only), Section, and resolved job. Returns the classification plus whether the
// Tower Sub Type disagreed with the derived category.
export function classifyMark(input: {
  orderNature: string | null;
  towerSubType: string | null;
  section: string | null;
  job: string;
}): { classification: MarkClassification; conflict: boolean } {
  const nature = (input.orderNature ?? "").trim().toUpperCase();
  const subType = (input.towerSubType ?? "").trim().toUpperCase();

  let c: MarkClassification;
  if (nature === "STRUCTURE") {
    c = {
      category: "TLT",
      ntltSubtype: null,
      groupType: "project",
      groupKey: input.job,
      active: true,
    };
  } else if (nature === "RSJ POLE") {
    c = {
      category: "NTLT",
      ntltSubtype: "RSJ",
      groupType: "section",
      groupKey: cleanRsjGroupKey(input.section),
      active: true,
    };
  } else if (nature === "EARTHING") {
    c = {
      category: "NTLT",
      ntltSubtype: "EARTHING",
      groupType: "section",
      groupKey: normalizeSectionKey(input.section) || "EARTHING",
      active: true,
    };
  } else if (nature === "GENERAL") {
    c = {
      category: "NTLT",
      ntltSubtype: "GENERAL",
      groupType: "section",
      groupKey: normalizeSectionKey(input.section) || "GENERAL",
      active: true,
    };
  } else if (nature === "FOUNDATION BOLT") {
    // Captured for completeness but excluded from workflow metrics.
    c = {
      category: "NTLT",
      ntltSubtype: "GENERAL",
      groupType: "section",
      groupKey: normalizeSectionKey(input.section) || "FOUNDATION BOLT",
      active: false,
    };
  } else {
    // Unknown / blank Order Nature: treat as NTLT (safe default — keeps the row
    // out of TLT reports). Caller should also increment unknownOrderNatureCount.
    c = {
      category: "NTLT",
      ntltSubtype: "GENERAL",
      groupType: "section",
      groupKey: normalizeSectionKey(input.section) || "UNKNOWN",
      active: true,
    };
  }

  // Tower Sub Type "NTLT" is a confirming signal only. A conflict is when the
  // sub type says NTLT but the (authoritative) category came out TLT, or vice
  // versa. Order Nature always wins; we only flag.
  let conflict = false;
  if (subType === "NTLT" && c.category === "TLT") conflict = true;
  if (subType === "TLT" && c.category === "NTLT") conflict = true;

  return { classification: c, conflict };
}

export function normalizeProject(value: Cell): string {
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
  lastProductionDate: "Last Production Entry Date",
  workOrderNo: "Work Order No.",
  woBatchNo: "WO Batch No.",
} as const;

// ── WIP format baseline & sanity check ──────────────────────────────────────
// Update EXPECTED_WIP_COLUMNS here (ONE place) when the ERP format changes.
export const EXPECTED_WIP_COLUMNS: readonly string[] = [
  "Type",
  "Project Code",
  "Order Nature",
  "Contractor",
  "Job Card No.",
  "Job Card Date",
  "Job Card Status",
  "Tower Type",
  "Tower Sub Type",
  "Alias",
  "Mark No.",
  "Section",
  "Length",
  "Width",
  "Wt/Pcs",
  "Balance Qty.",
  "Balance Wt.",
  "Assign Date",
  "Activity",
  "Operation",
  "Ref. Job Card No.",
  "Last Production Entry Date",
  "Work Order No.",
  "Batch No.",
];

// Columns whose absence breaks core computed features.
const CRITICAL_WIP_COLUMNS = new Set<string>([
  "Type",
  "Job Card Status",
  "Contractor",
  "Alias",
  "Activity",
  "Balance Wt.",
  "Tower Sub Type",
  "Project Code",
]);

export interface WipColumnRename {
  position: number; // 1-based
  expected: string;
  found: string;
}
export interface WipColumnReorder {
  name: string;
  expectedPosition: number; // 1-based
  foundPosition: number; // 1-based
}
export interface WipFormatCheck {
  ok: boolean;
  expectedCount: number;
  foundCount: number;
  missingExpected: string[];
  unexpectedFound: string[];
  renames: WipColumnRename[];
  reorders: WipColumnReorder[];
  criticalMissing: string[];
  isOldFormat: boolean;
  impactNote: string | null;
}

function normHeader(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function checkWipFormat(columnsFound: string[]): WipFormatCheck {
  const expected = EXPECTED_WIP_COLUMNS as readonly string[];
  const expNorm = expected.map(normHeader);
  const fndNorm = columnsFound.map(normHeader);

  // Quick exact-match (normalized) — common happy path
  if (
    fndNorm.length === expNorm.length &&
    fndNorm.every((n, i) => n === expNorm[i])
  ) {
    return {
      ok: true,
      expectedCount: expected.length,
      foundCount: columnsFound.length,
      missingExpected: [],
      unexpectedFound: [],
      renames: [],
      reorders: [],
      criticalMissing: [],
      isOldFormat: false,
      impactNote: null,
    };
  }

  // Build position maps (normalized name → 1-based position, first occurrence)
  const foundPosByNorm = new Map<string, number>();
  fndNorm.forEach((n, i) => {
    if (!foundPosByNorm.has(n)) foundPosByNorm.set(n, i + 1);
  });
  const expPosByNorm = new Map<string, number>();
  expNorm.forEach((n, i) => expPosByNorm.set(n, i + 1));

  // Missing: expected names not anywhere in file
  const missingExpected: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    if (!foundPosByNorm.has(expNorm[i]!)) missingExpected.push(expected[i]!);
  }
  // Unexpected: file names not in expected
  const unexpectedFound: string[] = [];
  for (let i = 0; i < columnsFound.length; i++) {
    if (!expPosByNorm.has(fndNorm[i]!)) unexpectedFound.push(columnsFound[i]!);
  }

  // Renames: at position i, the expected name is missing AND the found name is
  // unexpected (i.e. both ends of the slot belong to the "unmatched" sets).
  const missingNormSet = new Set(missingExpected.map(normHeader));
  const unexpectedNormSet = new Set(unexpectedFound.map(normHeader));
  const renames: WipColumnRename[] = [];
  const minLen = Math.min(expected.length, columnsFound.length);
  for (let i = 0; i < minLen; i++) {
    if (missingNormSet.has(expNorm[i]!) && unexpectedNormSet.has(fndNorm[i]!)) {
      renames.push({
        position: i + 1,
        expected: expected[i]!,
        found: columnsFound[i]!,
      });
    }
  }

  // Reorders: expected column IS in file but at a different position
  const reorders: WipColumnReorder[] = [];
  for (let i = 0; i < expected.length; i++) {
    const foundPos = foundPosByNorm.get(expNorm[i]!);
    if (foundPos !== undefined && foundPos !== i + 1) {
      reorders.push({
        name: expected[i]!,
        expectedPosition: i + 1,
        foundPosition: foundPos,
      });
    }
  }

  const criticalMissing = missingExpected.filter((c) =>
    CRITICAL_WIP_COLUMNS.has(c),
  );
  const isOldFormat =
    !foundPosByNorm.has("type") && foundPosByNorm.has("project code");

  let impactNote: string | null = null;
  if (
    criticalMissing.includes("Type") ||
    criticalMissing.includes("Job Card Status")
  ) {
    impactNote =
      '"Type" and/or "Job Card Status" are missing — Release Balance Computed, Assignment Balance, and the Fabrication Report cannot be computed from this file.';
  } else if (criticalMissing.length > 0) {
    impactNote = `Critical columns missing (${criticalMissing.join(", ")}) — some features may be unavailable or show incorrect values.`;
  } else if (reorders.length > 0) {
    impactNote =
      "Column positions differ — if the parser uses fixed positions for any column, parsed values may be wrong.";
  }

  return {
    ok: false,
    expectedCount: expected.length,
    foundCount: columnsFound.length,
    missingExpected,
    unexpectedFound,
    renames,
    reorders,
    criticalMissing,
    isOldFormat,
    impactNote,
  };
}

// ── Derived identity for a Mark No. (col H). See the consolidated Rules 0, A-D
// below (VTPL Mark-Number parsing). Only IS/SC/S rows (col G) get a `proMno`
// and a 4-part markNumber; every other row keeps the 3-part form.
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
  let h = markNo.trim();
  const A = job.trim();
  let G = alias.trim();

  // RULE 0 — Normalize a stray single leading dash on the alias, in BOTH col G
  // and col H, before any other rule runs. Some source rows carry a malformed
  // leading "-" on the alias (e.g. G="-069-2NBE1", H="946 -069-2NBE1-06").
  // Remove ONLY that one leading dash; dashes inside the value (e.g. the inner
  // dash of "069-2NBE1") are left untouched so the row then parses normally.
  // This is read-time derivation only — it does not alter the stored raw col
  // G/col H values or the row hash/identity.
  if (G.startsWith("-")) G = G.slice(1);
  if (A && h.startsWith(`${A} -`)) {
    h = `${A} ${h.slice(A.length + 2)}`;
  }

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
// `rawBatch` is the RAW (pre-"Z", pre-uppercase) WO Batch No. source value —
// NOT row.mfcBatch (which is normalized to "Z" for blanks). Hashing the raw
// value means a genuine batch change is a real change while the display-only "Z"
// substitution never affects identity, and a blank batch stays blank in the hash.
function hashRow(
  row: Omit<InsertRecordPool, "hash">,
  rawBatch: string | null,
): string {
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
    row.lastProductionDate,
    row.activity,
    row.operation,
    row.refJobCardNo,
    row.workOrderNo,
    rawBatch,
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
  "lastProductionDate",
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
  CLEANABLE_FIELDS.filter(
    (f) => f !== "assignDate" && f !== "lastProductionDate",
  ),
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
  wipFormatCheck: WipFormatCheck | null;
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
      wipFormatCheck: null,
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
  // "WO Batch No." was renamed to "Batch No." in newer file exports — treat
  // either header as satisfying the woBatchNo expectation.
  const missingColumns = expected.filter((c) => {
    if (found.has(c)) return false;
    if (c === COL.woBatchNo && found.has("Batch No.")) return false;
    return true;
  });

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
    wipFormatCheck: checkWipFormat(columnsFound),
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
  let classificationConflicts = 0;
  let ntltOrphanCount = 0;
  let ntltOrphanWtMt = 0;
  let unknownOrderNatureCount = 0;
  // Per-NTLT-section: distinct Tower Types seen. Used to flag Section→TowerType
  // mismatches (a source-data quality signal, not a parse error).
  const ntltSectionTowerTypes = new Map<string, { types: Set<string>; marks: number }>();
  const projects = new Set<string>();
  const rows: ParsedRow[] = [];
  // Finished Goods WIP per project: additive, does NOT change row identity.
  const fgWipByJob: Record<string, number> = {};
  const fgWipByStructure: Record<string, Record<string, number>> = {};

  for (const row of rawRows) {
    rowsRead++;

    const orderNature = emptyToNull(row[COL.orderNature]);

    // Read Col B (Project Code) directly — NO forward-fill. Every Structure
    // (TLT) row carries a populated project code (verified: 57,525/57,525).
    // NTLT rows (RSJ POLE, EARTHING, GENERAL) have a blank project code and
    // must NOT borrow one from an adjacent row.
    const rawProject = normalizeProject(row[COL.projectCode]);

    // FG Pending For Dispatch: collect Balance Wt. (Col Q) per project.
    // Structure FG rows carry the project code in Col B directly (always
    // populated). NTLT FG rows have no project code and are accumulated under
    // UNASSIGNED_JOB, grouped by Section (Col L) — never under a neighbouring
    // project (no forward-fill; fgProject uses rawProject directly, not any
    // stale/accumulated variable). Falls through to normal mark processing so
    // identity/hashing is completely unchanged.
    const rowType = cellToString(row["Type"]);
    if (rowType && rowType.trim().toUpperCase() === "FG PENDING FOR DISPATCH") {
      const fgProject = rawProject || UNASSIGNED_JOB;
      const fgWt = toNumber(row[COL.balanceWt]) ?? 0;
      fgWipByJob[fgProject] = (fgWipByJob[fgProject] ?? 0) + fgWt;
      // TLT rows: group by alias/structure. NTLT rows: group by Section (alias is blank).
      const fgStructKey = rawProject
        ? cellToString(row[COL.alias]).trim().toUpperCase()
        : cellToString(row[COL.section]).trim().toUpperCase();
      if (fgStructKey) {
        fgWipByStructure[fgProject] = fgWipByStructure[fgProject] ?? {};
        fgWipByStructure[fgProject][fgStructKey] =
          (fgWipByStructure[fgProject][fgStructKey] ?? 0) + fgWt;
      }
    }

    // Keep only rows with a Mark No.
    const markNo = cellToString(row[COL.markNo]);
    if (!markNo) continue;

    // The project for this row is Col B read directly — no forward-fill.
    // NTLT rows have blank project codes and are bucketed under UNASSIGNED_JOB;
    // they never borrow a neighbouring project.
    const effectiveProject = rawProject;
    // Stored/displayed grouping value.
    const job = effectiveProject || UNASSIGNED_JOB;
    // Value fed to mark derivation: empty for unassigned rows so their mark
    // identity stays the bare m_no (e.g. "1") and does not embed a borrowed job.
    const jobForMark = effectiveProject;

    const alias = emptyToNull(row[COL.alias]);
    const aliasStr = alias ?? "";
    const { structure, markTail, mNo, proMno, projectSuffix, aliasCorrected, markNumber } =
      deriveMark(markNo, jobForMark, aliasStr);
    // markNumber is the canonical mark key; markId aligns with it.
    const markId = markNumber;

    if (job && job !== UNASSIGNED_JOB) projects.add(job);

    const towerSubType = emptyToNull(row[COL.towerSubType]);
    const section = emptyToNull(row[COL.section]);
    // Work Order No. (col T) stored trimmed/null (unused in logic for now).
    const workOrderNo = emptyToNull(row[COL.workOrderNo]);
    // WO Batch No. (col U) = MFC batch. Raw (trimmed) value drives the hash;
    // the stored/displayed value is normalized (uppercased, blank -> "Z" so
    // blanks sort after real batches A, B, C ...).
    // "WO Batch No." was renamed to "Batch No." in newer file exports.
    const rawBatch = emptyToNull(row[COL.woBatchNo] ?? row["Batch No."]);
    const mfcBatch = rawBatch ? rawBatch.toUpperCase() : "Z";
    // Classify the mark (TLT vs NTLT + subtype). Additive — these fields are NOT
    // hashed (hashRow lists only source columns), so identity is unchanged.
    const { classification, conflict } = classifyMark({
      orderNature,
      towerSubType,
      section,
      job,
    });
    if (conflict) classificationConflicts++;

    // Track rows with unknown/blank Order Nature for the upload sanity check.
    if (!KNOWN_ORDER_NATURES.has((orderNature ?? "").trim().toUpperCase())) {
      unknownOrderNatureCount++;
    }

    // Track NTLT marks that have no project code for the upload data-quality
    // summary. These are the 282 RSJ POLE / EARTHING / GENERAL rows attributed
    // to "(Unassigned)"; surfaced as ntltOrphanCount + ntltOrphanWtMt.
    if (classification.category === "NTLT" && !rawProject) {
      ntltOrphanCount++;
      ntltOrphanWtMt += toNumber(row[COL.balanceWt]) ?? 0;
    }

    // Track Section→TowerType mapping for NTLT rows to surface mismatches.
    if (classification.category === "NTLT" && section) {
      const sectionKey = normalizeSectionKey(section);
      const towerTypeVal = cellToString(row[COL.towerType]).trim() || "(blank)";
      const existing = ntltSectionTowerTypes.get(sectionKey);
      if (existing) {
        existing.types.add(towerTypeVal);
        existing.marks++;
      } else {
        ntltSectionTowerTypes.set(sectionKey, { types: new Set([towerTypeVal]), marks: 1 });
      }
    }

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
      towerSubType,
      alias,
      markNo,
      section,
      length: toNumber(row[COL.length]),
      width: toNumber(row[COL.width]),
      wtPcs: toNumber(row[COL.wtPcs]),
      balanceQty: toNumber(row[COL.balanceQty]) ?? 0,
      balanceWt: toNumber(row[COL.balanceWt]) ?? 0,
      assignDate: formatDate(row[COL.assignDate]),
      lastProductionDate: formatDate(row[COL.lastProductionDate]),
      activity: emptyToNull(row[COL.activity]),
      operation: emptyToNull(row[COL.operation]),
      refJobCardNo: emptyToNull(row[COL.refJobCard]),
      workOrderNo,
      mfcBatch,
      category: classification.category,
      ntltSubtype: classification.ntltSubtype,
      groupType: classification.groupType,
      groupKey: classification.groupKey,
      active: classification.active,
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

    // Derive the (stored, display/report-only) hole operation from the FINAL
    // section value — after any accepted cleanup remap above — so the stored
    // attribute always matches the persisted section. NOT part of the hash.
    const holeOp = deriveHoleOperation(base.section);
    base.sectionType = holeOp.sectionType;
    base.holeOperation = holeOp.holeOperation;
    base.holeOperationSource = holeOp.holeOperationSource;

    // Additive exclusion flag: for Activity=C only, a mark is "initial" when its
    // Job Card Status is "Initial". These marks are already counted as Release
    // Balance and must NOT contribute to any Cutting balance figure.
    // Predicate: Activity=C AND Job Card Status="Initial" (Status-only — the
    // "Type" column is NOT checked; its value can vary independently).
    // Job Card Status has exactly two values (Initial / Authorized); no third
    // case exists. Non-C marks always stay false.
    // NOT part of the hash; defaults false for old-format rows (no status col).
    const jcStatus = cellToString(row["Job Card Status"]).trim().toUpperCase();
    const activityUpper = (base.activity ?? "").trim().toUpperCase();
    // Store the raw Job Card Status so classifyWipCase() can use it directly at
    // read time — no proxies needed. Empty string → null (old-format rows without
    // the column). NOT part of the hash; defaults null for legacy rows.
    base.jobCardStatus = jcStatus || null;
    base.isInitialCutting = activityUpper === "C" && jcStatus === "INITIAL";

    rows.push({ ...base, hash: hashRow(base, rawBatch) });
  }

  const distinct = new Set(rows.map((r) => r.hash));
  const missingContractor = rows.filter((r) => r.contractor == null).length;
  const missingDate = rows.filter((r) => r.assignDate == null).length;

  // Ageing-date sanity counts (resolved per activity: Assign Date for C, else
  // Last Production Entry Date). C rows now age from Assign Date, so they are
  // only "Not started" when even the Assign Date is blank; the non-C blank
  // production-date rows remain flagged as a data gap.
  let notStarted = 0;
  let noProductionDate = 0;
  let futureProductionDate = 0;
  for (const r of rows) {
    const date = resolveAgeingDate(
      r.activity ?? null,
      r.assignDate ?? null,
      r.lastProductionDate ?? null,
    );
    if (date == null) {
      if (isPreProductionActivity(r.activity ?? null)) notStarted++;
      else noProductionDate++;
    } else if (isFutureDate(date)) {
      futureProductionDate++;
    }
  }

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
      notStarted,
      noProductionDate,
      futureProductionDate,
      classificationConflicts,
      ...(ntltOrphanCount > 0 && { ntltOrphanCount, ntltOrphanWtMt }),
      ...(unknownOrderNatureCount > 0 && { unknownOrderNatureCount }),
      ...(() => {
        const mismatches = Array.from(ntltSectionTowerTypes.entries())
          .filter(([, v]) => v.types.size > 1)
          .map(([section, v]) => ({
            section,
            towerTypes: Array.from(v.types).sort(),
            marks: v.marks,
          }));
        return mismatches.length > 0 ? { ntltSectionMismatches: mismatches } : {};
      })(),
      ...(Object.keys(fgWipByJob).length > 0 && { fgWipByJob }),
      ...(Object.keys(fgWipByStructure).length > 0 && { fgWipByStructure }),
    },
  };
}

// Today at UTC midnight (ms). Ageing is whole-day differences in UTC.
function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Activities where production has not yet begun. Marks at these stages age from
// Assign Date (Last Production Entry Date is always blank at this point).
//   C         = TLT Cutting (the first TLT fabrication step)
//   NTF       = NTLT Non-TLT Fabrication (first NTLT fab step)
//   NTFSW     = NTLT Non-TLT Fabrication with Stiffener Welding
//   BL        = NTLT Bending/Lapping
// Add new first-stage codes here if the ERP introduces them.
export const PRE_PRODUCTION_ACTIVITIES = new Set(["C", "NTF", "NTFSW", "BL"]);

export function isPreProductionActivity(activity: string | null): boolean {
  return PRE_PRODUCTION_ACTIVITIES.has((activity ?? "").trim().toUpperCase());
}

// Activity "C" (Cutting) means production has genuinely not begun.
// Kept for callers that specifically need to check TLT cutting only.
export function isCuttingActivity(activity: string | null): boolean {
  return (activity ?? "").trim().toUpperCase() === "C";
}

// True when a YYYY-MM-DD date is strictly after today (UTC). Such dates are
// clamped to today for ageing (ageing 0) and flagged for review, never dropped.
export function isFutureDate(date: string | null): boolean {
  if (!date) return false;
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime())) return false;
  return d.getTime() > todayUtcMs();
}

// The date a mark's ageing is measured from.
// Pre-production activities (C, NTF, NTFSW, BL) have no Last Production Entry
// Date yet — production has not begun — so they age from Assign Date (how long
// the mark has waited to start). Every other activity ages from Last Production
// Entry Date. A blank chosen date yields null (the caller labels it "Not started"
// for pre-production, "No production date" otherwise). NOTE: do NOT fall back
// to assignDate for post-production rows — a started mark with a blank
// production date is a genuine data gap to surface, not to paper over.
export function resolveAgeingDate(
  activity: string | null,
  assignDate: string | null,
  lastProductionDate: string | null,
): string | null {
  return isPreProductionActivity(activity) ? assignDate : lastProductionDate;
}

// Ageing = today - resolveAgeingDate (whole days, UTC), recomputed live and
// never cached. Blank/unparseable dates yield null (the caller labels them
// "Not started" at activity C with no assign date, else "No production date").
// A future chosen date is clamped to today, so ageing is 0 (never negative).
export function computeAgeing(
  activity: string | null,
  assignDate: string | null,
  lastProductionDate: string | null,
): number | null {
  const date = resolveAgeingDate(activity, assignDate, lastProductionDate);
  if (!date) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const diff = todayUtcMs() - d.getTime();
  if (diff <= 0) return 0;
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
