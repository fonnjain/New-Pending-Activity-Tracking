import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { canonicalActivity, deriveHoleOperation } from "@workspace/domain";
import type { InsertRecordPool, ParseSummary } from "@workspace/db";

export type { ParseSummary };

/** The permanent ERP WIP CSV export has one fixed, 28-column header row. */
export const WIP_CSV_COLUMN_COUNT = 28;

/** True only when a CSV header has the fixed column count required at ingest. */
export function hasExactWipCsvColumnCount(columnsFound: readonly string[]): boolean {
  return columnsFound.length === WIP_CSV_COLUMN_COUNT;
}

// A parsed source row, identical in shape to a record_pool insert plus its
// content hash. In-sheet duplicates are PRESERVED (no within-file de-dup).
export type ParsedRow = Omit<InsertRecordPool, "hash"> & { hash: string };

export interface ParseResult {
  rows: ParsedRow[];
  summary: ParseSummary;
  /** CSV source dates later than the selected report date. Import routes refuse these. */
  futureDateCount: number;
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
  "SOLAR STRUCTURE",
  "RAILWAY STRUCTURE",
  "RURAL ELECTRIFICATION",
  "JOB WORK",
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
  } else if (
    nature === "GENERAL" ||
    nature === "SOLAR STRUCTURE" ||
    nature === "RAILWAY STRUCTURE" ||
    nature === "RURAL ELECTRIFICATION" ||
    nature === "JOB WORK"
  ) {
    c = {
      category: "NTLT",
      ntltSubtype: "GENERAL",
      groupType: "section",
      groupKey: normalizeSectionKey(input.section) || nature,
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
  jobCardDate: "Job Card Date",
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
  // ERP additions, Aug-2026 (cols Y + Z). OPTIONAL — files before 16-Aug-2026 do
  // not carry them and must keep importing with the fields null (see
  // OPTIONAL_WIP_COLUMNS below). Stored raw; no logic depends on them yet.
  bomStatus: "BOM Status",
  isWeldedStructure: "Is Welded Structure",
  salesOrderStatus: "Sales Order Status",
  isLastActivity: "Is Last Activity",
} as const;

// --- Source Column Watch -------------------------------------------------
// ERP pass-through columns whose contents we snapshot on every import so the
// day they start carrying real information gets noticed. Extensible by design:
// append an entry here and the Data Check panel + export render it — no other
// code changes. Descriptive only; never a DC rule, never affects pass/fail.
// Declared here (before the column-tier lists) because a watched column is by
// construction also a KNOWN column: OPTIONAL_WIP_COLUMNS derives from it.
export const WATCHED_SOURCE_COLUMNS: ReadonlyArray<{ key: string; header: string }> = [
  { key: "bomStatus", header: COL.bomStatus },
  { key: "isWeldedStructure", header: COL.isWeldedStructure },
];

// COL entries that are allowed to be absent from a file's header row — they are
// captured when present but never reported as "missing expected columns".
// Derived from WATCHED_SOURCE_COLUMNS: adding a watched column automatically
// makes it optional-known everywhere (format check included).
const OPTIONAL_WIP_COLUMNS = new Set<string>(
  [
    ...WATCHED_SOURCE_COLUMNS.map((c) => c.header),
    COL.salesOrderStatus,
    COL.isLastActivity,
  ],
);

// ── WIP format baseline & sanity check ──────────────────────────────────────
// Three tiers of column classification (see also CRITICAL_WIP_COLUMN_LIST and
// KNOWN_WIP_COLUMN_LIST below):
//   1. Critical — required; missing means the file is refused at ingest.
//   2. Known    — recognised; may or may not be present, neither case warns.
//   3. Unknown  — anything else; the only tier that produces the staging
//                 "unexpected column" warning.
// When the ERP adds a column we decide to accept, add it to
// KNOWN_WIP_COLUMN_LIST (one line). EXPECTED_WIP_COLUMNS remains the ordered
// historical baseline used only for the rename/reorder heuristics.
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

// Columns whose absence breaks core computed features. This is the ONE
// critical-column list: a WIP file missing any of these is refused at ingest
// (see missingCriticalWipColumns) — a partial import is worse than no import,
// because nothing downstream can distinguish it from a complete one (that's
// how the 19 gated imports happened). "Batch No." is satisfied by either the
// new "Batch No." or the legacy "WO Batch No." header.
export const CRITICAL_WIP_COLUMN_LIST: readonly string[] = [
  "Type",
  "Mark No.",
  "Contractor",
  "Job Card Status",
  "Alias",
  "Batch No.",
  "Order Nature",
  "Project Code",
  "Balance Wt.",
  "Activity",
];
const CRITICAL_WIP_COLUMNS = new Set<string>(CRITICAL_WIP_COLUMN_LIST);

// Known-but-optional columns: recognised, presence NOT required. A file having
// them is normal; a file lacking them is also normal (pre-16-Aug-2026 exports
// lack the last two). Neither case produces a warning — only columns outside
// critical ∪ known do. Adding the next accepted ERP column is a one-line edit
// here. Watched columns (Source Column Watch) are appended automatically —
// a column being watched implies it is known.
const KNOWN_WIP_COLUMN_BASE: readonly string[] = [
  "Job Card No.",
  "Job Card Date",
  "Tower Type",
  "Tower Sub Type",
  "Section",
  "Length",
  "Width",
  "Wt/Pcs",
  "Balance Qty.",
  "Assign Date",
  "Operation",
  "Ref. Job Card No.",
  "Last Production Entry Date",
  "Work Order No.",
];
export const KNOWN_WIP_COLUMN_LIST: readonly string[] = [
  ...KNOWN_WIP_COLUMN_BASE,
  ...Array.from(OPTIONAL_WIP_COLUMNS),
];

// Returns the critical columns absent from a WIP file's header row. Matching is
// EXACT (trimmed, case-sensitive) — deliberately as strict as the parser itself,
// which indexes rows by the exact header string (row[COL.markNo] etc.). A
// case-variant header like "Mark no." would pass a normalized check but parse
// as null on every row, recreating the silent-corruption failure this gate
// exists to prevent — so it must be refused too. The single equivalence is the
// "WO Batch No." → "Batch No." rename, which the parser also resolves.
// Empty array ⇒ the file may be ingested. Non-empty ⇒ refuse outright — no
// partial import, no override. Extra/unknown columns never appear here.
export function missingCriticalWipColumns(columnsFound: string[]): string[] {
  const found = new Set(columnsFound.map((c) => c.trim()));
  return CRITICAL_WIP_COLUMN_LIST.filter((c) => {
    if (found.has(c)) return false;
    if (c === "Batch No." && found.has("WO Batch No.")) return false;
    return true;
  });
}

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
  /** Missing REQUIRED (critical) columns only — always equals criticalMissing. */
  missingExpected: string[];
  /** Columns in the file recognised by neither the critical nor known list. */
  unexpectedFound: string[];
  /** Known-optional columns absent from this file. Informational, never a warning. */
  optionalAbsent: string[];
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
  const fndNorm = columnsFound.map(normHeader);

  // Recognised = critical ∪ known-optional ∪ the one legacy header alias
  // ("WO Batch No." → "Batch No.", which the parser also resolves).
  const recognizedNorm = new Set<string>([
    ...CRITICAL_WIP_COLUMN_LIST.map(normHeader),
    ...KNOWN_WIP_COLUMN_LIST.map(normHeader),
    normHeader("WO Batch No."),
  ]);

  // Build position maps (normalized name → 1-based position, first occurrence)
  const foundPosByNorm = new Map<string, number>();
  fndNorm.forEach((n, i) => {
    if (!foundPosByNorm.has(n)) foundPosByNorm.set(n, i + 1);
  });

  // Tier 1 — missing critical columns (exact-match gate, same as ingest refusal)
  const criticalMissing = missingCriticalWipColumns(columnsFound);
  // Tier 2 — known columns absent from this file (informational only)
  const optionalAbsent = KNOWN_WIP_COLUMN_LIST.filter(
    (c) => !foundPosByNorm.has(normHeader(c)),
  );
  // Tier 3 — columns recognised by neither list: the only warning-worthy case
  const unexpectedFound: string[] = [];
  for (let i = 0; i < columnsFound.length; i++) {
    if (!recognizedNorm.has(fndNorm[i]!)) unexpectedFound.push(columnsFound[i]!);
  }

  const ok = criticalMissing.length === 0 && unexpectedFound.length === 0;

  // Rename heuristic against the ordered historical baseline: at position i,
  // the baseline name is missing-critical AND the found name is unrecognised.
  const expected = EXPECTED_WIP_COLUMNS as readonly string[];
  const expNorm = expected.map(normHeader);
  const missingNormSet = new Set(criticalMissing.map(normHeader));
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

  // Reorders vs the historical baseline. Informational only — the parser is
  // name-based, so order never affects parsing and never blocks or warns.
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
  }

  return {
    ok,
    expectedCount:
      CRITICAL_WIP_COLUMN_LIST.length + KNOWN_WIP_COLUMN_LIST.length,
    foundCount: columnsFound.length,
    missingExpected: criticalMissing,
    unexpectedFound,
    optionalAbsent,
    renames,
    reorders: ok ? [] : reorders,
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
  // IS / SC / S / SS / SR are all "prefix-class" aliases: the Mark No. encodes a
  // project-specific prefix (e.g. "IS-807", "SS-890", "SR-924") followed by the
  // inner structure code. Rule B handles all of them to produce a 4-part markNumber.
  const isISSC =
    gUpper === "IS" ||
    gUpper === "SC" ||
    gUpper === "S" ||
    gUpper === "SS" ||
    gUpper === "SR";

  // RULE A — bare mark: no space, no backslash, and both col A and col G empty
  // (Earthing / General / RSJ Pole). markNumber = mNo (may be non-numeric).
  if (!h.includes(" ") && !h.includes("\\") && A === "" && G === "") {
    return makeMark("", "", h, "");
  }

  // RULE B — IS / SC / S / SS / SR rows: the only rows that get a proMno and a
  // 4-part markNumber "project \ proMno \ structure \ mNo".
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

  // RULE D — backslash form (residual: any alias not in the IS/SC/S/SS/SR set).
  // Source format: "<A> <prefix>\<structure>\<mNo>" — always exactly three
  // backslash-separated segments; no structure value ever contains a backslash.
  // Strip the leading "<A> " prefix, then discard segment[0] (the project-specific
  // prefix, e.g. "CBOM-920") and take segment[1] as structure, segment[2] as mNo.
  //
  // Do NOT use lastIndexOf: that would keep the prefix inside the structure
  // (e.g. "CBOM-920\2CE" instead of "2CE"), making it un-joinable to Order Review.
  if (h.includes("\\")) {
    const body = A && h.startsWith(`${A} `) ? h.slice(A.length + 1).trim() : h;
    const parts = body.split("\\");
    // parts[0] = project-specific prefix — discarded
    // parts[1] = structure (inner tower type code)
    // parts[2..] = mNo (per-mark serial; join with "\" if multiple segments)
    const structure = (parts[1] ?? "").trim();
    const mNo = parts.slice(2).join("\\").trim();
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

/**
 * Direct RFC-4180-style CSV reader for the permanent WIP export. It deliberately
 * avoids SheetJS: CSV fields are quoted, may contain commas, and use CRLF lines.
 */
function readCsvGrid(buffer: Buffer): string[][] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

/** True only for a direct CSV WIP header; Order Review CSV is not supported. */
export function isCsvWip(buffer: Buffer): boolean {
  try {
    // Detection is called before parsing and in a few guards. Only inspect the
    // header line here; building a 75k-row grid just to identify a CSV wastes
    // substantial memory during upload.
    const lineEnd = buffer.indexOf(0x0a);
    const headerBuffer = lineEnd >= 0 ? buffer.subarray(0, lineEnd + 1) : buffer;
    const headers = (readCsvGrid(headerBuffer)[0] ?? []).map((header) => header.trim());
    return (
      headers.includes(COL.projectCode) &&
      headers.includes(COL.markNo) &&
      headers.includes(COL.activity)
    );
  } catch {
    return false;
  }
}

function csvRowsAsObjects(buffer: Buffer): { headers: string[]; rows: RawRow[] } {
  const grid = readCsvGrid(buffer);
  const headers = (grid[0] ?? []).map((value) => value.trim());
  if (headers.length === 0 || !headers.includes(COL.projectCode)) {
    throw new Error("CSV header row is missing Project Code");
  }
  return {
    headers,
    rows: grid.slice(1).map((values) => {
      const row: RawRow = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? null;
      });
      return row;
    }),
  };
}

function parseCsvDayFirst(value: Cell): string | null {
  const raw = cellToString(value);
  if (!raw) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
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
  if (isCsvWip(buffer)) {
    try {
      const { headers, rows } = csvRowsAsObjects(buffer);
      const found = new Set(headers);
      const missingColumns = Object.values(COL).filter((c) => {
        if (OPTIONAL_WIP_COLUMNS.has(c)) return false;
        if (found.has(c)) return false;
        if (c === COL.woBatchNo && found.has("Batch No.")) return false;
        return true;
      });
      const rowsWithMark = rows.filter((row) => cellToString(row[COL.markNo])).length;
      const problems: string[] = [];
      if (!hasExactWipCsvColumnCount(headers)) {
        problems.push(
          `Expected ${WIP_CSV_COLUMN_COUNT} CSV columns but found ${headers.length}.`,
        );
      }
      if (missingColumns.length > 0) {
        problems.push(`Missing expected columns: ${missingColumns.join(", ")}.`);
      }
      if (rowsWithMark === 0) {
        problems.push('No data rows have a non-empty "Mark No.".');
      }
      return {
        sheetName: "CSV",
        headerRow: 0,
        columnsFound: headers,
        missingColumns,
        rowsRead: rows.length,
        rowsWithMark,
        problems,
        wipFormatCheck: checkWipFormat(headers),
      };
    } catch {
      return {
        sheetName: null,
        headerRow: null,
        columnsFound: [],
        missingColumns: Object.values(COL),
        rowsRead: 0,
        rowsWithMark: 0,
        problems: ["The file could not be read as a CSV report."],
        wipFormatCheck: null,
      };
    }
  }
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
    if (OPTIONAL_WIP_COLUMNS.has(c)) return false;
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

// --- Source Column Watch (types) -------------------------------------------
// WATCHED_SOURCE_COLUMNS itself is declared above, next to OPTIONAL_WIP_COLUMNS,
// so that "watched implies known" holds by construction.
export interface SourceColumnWatchColumn {
  key: string;
  header: string;
  // false = the file was inspected and the column is absent ("not present in
  // this file"). Imports whose summary lacks the snapshot entirely predate it.
  present: boolean;
  values: { value: string | null; marks: number; weightMt: number }[];
  crossTab: { orderNature: string; value: string | null; marks: number }[];
}

export function parseWorkbook(
  buffer: Buffer,
  cleanups?: Cleanup[],
  options?: { reportDate?: string | null },
): ParseResult {
  const csv = isCsvWip(buffer);
  let headerRow = 0;
  let headerCells: unknown[] = [];
  let rawRows: RawRow[];
  if (csv) {
    const parsedCsv = csvRowsAsObjects(buffer);
    headerCells = parsedCsv.headers;
    rawRows = parsedCsv.rows;
  } else {
    const { ws } = resolveSheet(buffer);
    // Header is no longer fixed to the third row. Scan the first rows for the one
    // that contains a cell exactly equal to "Project Code"; data begins on the
    // next row. Falls back to the third row (index 2) when not found.
    headerRow = detectHeaderRow(ws);
    rawRows = XLSX.utils.sheet_to_json<RawRow>(ws, {
      range: headerRow,
      defval: null,
      raw: true,
    });
    headerCells =
      XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, range: headerRow, raw: true })[0] ?? [];
  }
  const cleanupMap = buildCleanupMap(cleanups);

  // Closed value sets for Col A and Col G (verified on WIP 21-Jul, 60,594 rows).
  const KNOWN_WIP_TYPES = new Set([
    "JOB CARD NOT STARTED",
    "JOB CARD WIP",
    "FG PENDING FOR DISPATCH",
  ]);
  const KNOWN_JC_STATUSES = new Set(["INITIAL", "AUTHORIZED"]);

  let rowsRead = 0;
  let classificationConflicts = 0;
  let ntltOrphanCount = 0;
  let ntltOrphanWtMt = 0;
  let unknownOrderNatureCount = 0;
  let futureDateCount = 0;
  let unclassifiedRowCount = 0;
  let unclassifiedWtKg = 0;
  // Up to 5 distinct type+status combos captured as diagnostic samples.
  const unclassifiedSampleMap = new Map<string, { type: string; status: string }>();
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

    const sourceActivity = emptyToNull(row[COL.activity]);
    // Blank Job Card WIP rows remain blank in storage so the existing DC18 source
    // warning can identify them. classifyWipPhase() maps only that scoped case to
    // Quality Check at read time; all other blank-source behaviour is unchanged.
    const activity = canonicalActivity(sourceActivity);

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
       assignDate: csv ? parseCsvDayFirst(row[COL.assignDate]) : formatDate(row[COL.assignDate]),
       lastProductionDate: csv
         ? parseCsvDayFirst(row[COL.lastProductionDate])
         : formatDate(row[COL.lastProductionDate]),
      activity,
      // Preserve the source value only when canonicalization changed it. This
      // remains null for every ordinary/existing row and is deliberately absent
      // from hashRow so canonical activity identity remains stable.
       activityRaw:
         sourceActivity != null && activity !== sourceActivity ? sourceActivity : null,
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

    // Additive exclusion flag: a mark is "not released" (still in the Release
    // Balance stage) when its Job Card Status is "Initial", regardless of its
    // Activity column value. In the newer WIP format the Activity column holds
    // the PLANNED activity for scheduling, not the current production stage —
    // so a mark with Activity=RFI + Status=Initial has NOT started RFI; it is
    // unreleased raw material. Only marks with Status="Authorized" (or no status
    // column at all) have been physically released to the shop floor.
    // Predicate: Job Card Status == "INITIAL" (activity-independent).
    // NOT part of the hash; defaults false for old-format rows (no status col).
    const jcStatus = cellToString(row["Job Card Status"]).trim().toUpperCase();
    const activityUpper = (base.activity ?? "").trim().toUpperCase();
    void activityUpper; // retained for future use
    // Store Col A "Type" (job_card_type) so classifyWipCase() can work without
    // any activity-based proxies. Empty string → null (old-format files without
    // the Type column). NOT part of the hash; additive/display-only.
    // Canonical values: "Job Card Not Started" | "Job Card WIP" | "FG Pending For Dispatch"
    // (stored in original case, matched case-insensitively in classifyWipCase).
    base.jobCardType = rowType.trim() || null;
    // Store the raw Job Card Status so classifyWipCase() can use it directly at
    // read time — no proxies needed. Empty string → null (old-format rows without
    // the column). NOT part of the hash; defaults null for legacy rows.
    base.jobCardStatus = jcStatus || null;
    base.isInitialCutting = jcStatus === "INITIAL";
    // ERP additions Aug-2026 (cols Y + Z): stored as raw trimmed strings, null
    // when the column is absent (files before 16-Aug-2026). NOT part of the
    // hash — attributes of the structure, not the mark's state — following the
    // category/ntltSubtype/groupType/holeOperation pattern. No logic reads them.
    base.bomStatus = emptyToNull(row[COL.bomStatus]);
    base.isWeldedStructure = emptyToNull(row[COL.isWeldedStructure]);
    base.salesOrderStatus = emptyToNull(row[COL.salesOrderStatus]);
    base.isLastActivity = emptyToNull(row[COL.isLastActivity]);

    if (csv && options?.reportDate) {
      for (const date of [
        parseCsvDayFirst(row[COL.jobCardDate]),
        base.assignDate,
        base.lastProductionDate,
      ]) {
        if (date != null && date > options.reportDate) futureDateCount++;
      }
    }

    // Detect rows that fall outside the verified closed value sets for Col A / Col G.
    // Only applies when the "Type" column is present (new-format files); old-format
    // files have no rowType and are skipped. A non-zero count means the file has a
    // new value not yet handled — surface as a warning rather than silently bucketing.
    const rowTypeUpper = rowType.trim().toUpperCase();
    if (rowTypeUpper) {
      const unknownType = !KNOWN_WIP_TYPES.has(rowTypeUpper);
      // For rows with a known Type (excluding FG whose status is always blank),
      // any non-empty Job Card Status must also be a known value.
      const unknownStatus =
        !unknownType &&
        rowTypeUpper !== "FG PENDING FOR DISPATCH" &&
        jcStatus !== "" &&
        !KNOWN_JC_STATUSES.has(jcStatus);
      if (unknownType || unknownStatus) {
        unclassifiedRowCount++;
        unclassifiedWtKg += base.balanceWt ?? 0;
        if (unclassifiedSampleMap.size < 5) {
          const key = `${rowTypeUpper}|${jcStatus}`;
          if (!unclassifiedSampleMap.has(key)) {
            unclassifiedSampleMap.set(key, { type: rowType.trim(), status: jcStatus });
          }
        }
      }
    }

    rows.push({ ...base, hash: hashRow(base, rawBatch) });
  }

  // --- Source Column Watch (Data Check panel) -------------------------------
  // Per-import snapshot of the watched ERP pass-through columns, captured at
  // parse time from THIS file's rows. Stored in imports.summary so it stays
  // accurate forever: record_pool values are shared across imports and get
  // re-stamped by later files, so a live pool join could never reconstruct
  // what an earlier file actually contained. Descriptive only — no rule, no
  // pass/fail, nothing downstream reads it for logic.
  // Presence is read from the detected header row itself (not from a data
  // row), so a file with headers but zero data rows still reports correctly.
  const headerKeys = new Set(
    headerCells.filter((c): c is string => typeof c === "string").map((c) => c.trim()),
  );
  const sourceColumnWatch: SourceColumnWatchColumn[] = WATCHED_SOURCE_COLUMNS.map(
    ({ key, header }) => {
      const present = headerKeys.has(header);
      if (!present) return { key, header, present, values: [], crossTab: [] };
      const valueAgg = new Map<string, { value: string | null; marks: number; weightKg: number }>();
      const crossAgg = new Map<string, { orderNature: string; value: string | null; marks: number }>();
      for (const r of rows) {
        const raw = (r as Record<string, unknown>)[key];
        const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
        const vKey = value ?? "\u0000blank";
        const v = valueAgg.get(vKey) ?? { value, marks: 0, weightKg: 0 };
        v.marks++;
        v.weightKg += r.balanceWt ?? 0;
        valueAgg.set(vKey, v);
        const nature = (r.orderNature ?? "").trim() || "(blank)";
        const cKey = `${nature}\u0000${vKey}`;
        const c = crossAgg.get(cKey) ?? { orderNature: nature, value, marks: 0 };
        c.marks++;
        crossAgg.set(cKey, c);
      }
      return {
        key,
        header,
        present,
        values: Array.from(valueAgg.values())
          .sort((a, b) => b.marks - a.marks)
          .map(({ value, marks, weightKg }) => ({
            value,
            marks,
            weightMt: weightKg / 1000,
          })),
        crossTab: Array.from(crossAgg.values()).sort((a, b) => b.marks - a.marks),
      };
    },
  );

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
    futureDateCount,
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
      ...(unclassifiedRowCount > 0 && {
        unclassifiedRowCount,
        unclassifiedWtKg,
        unclassifiedSamples: Array.from(unclassifiedSampleMap.values()),
      }),
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
      // Always written (even when every watched column is absent) so the Data
      // Check panel can distinguish "file predates the snapshot" (key missing)
      // from "file inspected, column absent" (present: false).
      sourceColumnWatch,
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
