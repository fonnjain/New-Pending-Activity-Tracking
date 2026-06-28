import * as XLSX from "xlsx";
import type { OrderReviewSummary } from "@workspace/db";

// ---------------------------------------------------------------------------
// "Order Review" file (the SECOND input file)
// ---------------------------------------------------------------------------
// This is a per-structure order/dispatch summary export, distinct from the WIP
// balance/activity report. It is joined to WIP marks on (project, structure):
//   - project   = forward-filled "Project Code : NNN" banner
//   - structure = Tower Type Code (col C) — matches a WIP mark's derived structure
// The export uses a TWO-ROW header (merged group row over a sub-header row), so
// columns are matched by COMPOSITE header label first (robust to layout drift)
// with a fixed letter-position fallback (C/D/F/G/K/L/Q). Everything here is
// read-only and additive: it never touches WIP parsing, dedup, ageing, or the
// row hash.

export type OrderReviewFileType = "wip" | "order-review" | "unknown";

export interface ParsedOrderReviewRow {
  project: string;
  structure: string;
  subType: string | null;
  sets: number | null;
  weightMt: number | null;
  bomType: string | null;
  releaseMt: number | null;
  fileDespatchMt: number | null;
}

export interface OrderReviewParseResult {
  asOnDate: string | null;
  rows: ParsedOrderReviewRow[];
  summary: OrderReviewSummary;
}

type Cell = string | number | boolean | Date | null | undefined;

function cellStr(value: Cell): string {
  if (value == null) return "";
  if (value instanceof Date) return formatDate(value) ?? "";
  return String(value).trim();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Mirror of parse.ts date handling (kept local so the two files stay decoupled).
function formatDate(value: Cell): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(
      value.getUTCDate(),
    )}`;
  }
  if (typeof value === "number") {
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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// "sets" is a whole-number count stored in an integer column. Some exports carry
// a decimal in that cell (e.g. a stray weight), which Postgres rejects for an
// integer column. Round to the nearest whole number so ingest never crashes.
function toInt(value: Cell): number | null {
  const n = toNumber(value);
  return n == null ? null : Math.round(n);
}

// Project normalization, mirroring parse.ts: "920.0" -> "920", "794." -> "794".
function normalizeProject(value: string): string {
  let s = value.trim();
  if (!s) return "";
  s = s.replace(/\.0+$/, "");
  s = s.replace(/\.$/, "");
  return s.trim();
}

// Structure (Tower Type Code / col C) canonicalization: trim + collapse internal
// whitespace runs to a single space. Case is PRESERVED — the structure is the
// join key to a WIP mark's derived structure (alias), which is case-sensitive, so
// upper-casing here would break the WIP join. Collapsing whitespace prevents
// phantom duplicate keys from spacing variants across daily files.
export function normalizeStructure(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getGrid(buffer: Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.includes("Sheet1")
    ? "Sheet1"
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: true,
  });
}

// Flatten the first `limit` rows into a single lowercased haystack for keyword
// sniffing (file-type detection + banner scanning).
function gridText(grid: unknown[][], limit: number): string {
  const out: string[] = [];
  const n = Math.min(grid.length, limit);
  for (let i = 0; i < n; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;
    for (const c of cells) {
      if (c != null) out.push(String(c));
    }
  }
  return out.join(" \u0001 ").toLowerCase();
}

// Decide whether an uploaded workbook is the WIP balance/activity report, the
// Order Review summary, or neither. WIP is authoritative: a sheet carrying the
// WIP header (Project Code + Mark No. + Activity) is always WIP, never order
// review. Order Review is recognised by its own markers and the ABSENCE of the
// per-mark WIP columns.
export function detectFileType(buffer: Buffer): OrderReviewFileType {
  let grid: unknown[][];
  try {
    grid = getGrid(buffer);
  } catch {
    return "unknown";
  }
  if (grid.length === 0) return "unknown";
  const hay = gridText(grid, 15);

  const hasProjectCode = hay.includes("project code");
  const hasMarkNo = hay.includes("mark no");
  const hasActivity = /\bactivity\b/.test(hay);
  // WIP report: the per-mark balance/activity sheet.
  if (hasProjectCode && hasMarkNo && hasActivity) return "wip";

  // Order Review markers — any two of these and NO per-mark Mark No. column.
  const orWeight = hay.includes("weight") || hay.includes("wt(mt)") || hay.includes("wt (mt)");
  const orDespatch = hay.includes("despatch") || hay.includes("dispatch");
  const orTowerType = hay.includes("tower type");
  const orBom = hay.includes("bom");
  const orRelease = hay.includes("release");
  const orderScore = [orWeight, orDespatch, orTowerType, orBom, orRelease].filter(
    Boolean,
  ).length;
  if (!hasMarkNo && orderScore >= 2) return "order-review";

  return "unknown";
}

interface ColumnIndex {
  structure: number;
  subType: number;
  sets: number;
  weightMt: number;
  bomType: number;
  releaseMt: number;
  fileDespatchMt: number;
}

// A logical column spec resolved against COMPOSITE header labels (see
// buildHeaderModel). `include` is a list of term-groups tried in order; a column
// matches a group when its composite label contains EVERY term in that group and
// NONE of the `exclude` terms. The first matching column (lowest index) wins; if
// nothing matches, `fallback` (0-based letter position) is used. Composite
// matching is what disambiguates the export's duplicate headers: "Order Qty.
// Weight" (the total order weight we want, col G) vs "Weight / Set (MT)" (col E,
// per-set) and "WO Order Qty. Weight (MT)" (col J); and "Progress Release (MT)"
// (col L) vs "Balance Release (MT)".
interface HeaderSpec {
  key: keyof ColumnIndex;
  include: string[][];
  exclude?: string[];
  fallback: number;
}

// Field -> source column in this export: structure=C, subType=D, sets=F
// (Order Qty > Sets), weight=G (Order Qty > Weight = total order weight), bom=K,
// release=L (Progress > Release), despatch=Q (Progress > Despatch, seed-only).
const HEADER_SPECS: HeaderSpec[] = [
  { key: "structure", include: [["tower type"], ["type code"], ["structure"]], fallback: 2 },
  { key: "subType", include: [["sub type"], ["subtype"]], fallback: 3 },
  { key: "sets", include: [["order qty", "sets"], ["sets"]], exclude: ["wo", "work order"], fallback: 5 },
  { key: "weightMt", include: [["order qty", "weight"], ["weight (mt)"], ["weight"]], exclude: ["wo", "work order", "/ set", "per set", "balance"], fallback: 6 },
  { key: "bomType", include: [["bom"]], fallback: 10 },
  { key: "releaseMt", include: [["progress", "release"], ["release"]], exclude: ["balance"], fallback: 11 },
  { key: "fileDespatchMt", include: [["progress", "despatch"], ["progress", "dispatch"], ["despatch"], ["dispatch"]], exclude: ["balance"], fallback: 16 },
];

// Lowercase + collapse whitespace for a header cell ("BOM\nLabel" -> "bom label").
function headerText(value: Cell): string {
  return cellStr(value).replace(/\s+/g, " ").trim().toLowerCase();
}

// True when a row looks like the sub-header row of a two-row header: it carries
// several measure sub-tokens and is not itself a data/banner row.
function looksLikeSubHeader(cells: unknown[]): boolean {
  const tokens = ["sets", "weight", "release", "despatch", "dispatch", "fabrication", "galvanising", "inspection", "(mt)", "work order"];
  let hits = 0;
  for (const c of cells) {
    const t = headerText(c as Cell);
    if (!t) continue;
    if (PROJECT_BANNER.test(t)) return false;
    if (tokens.some((tok) => t.includes(tok))) hits++;
  }
  return hits >= 2;
}

// Locate the PRIMARY (group) header row: the first of the top rows carrying a
// tower-type/structure header, where measures appear either in that row or the
// sub-header row directly below it (two-row header). Returns -1 if none.
function detectHeaderRow(grid: unknown[][]): number {
  const limit = Math.min(grid.length, 15);
  const hasMeasure = (cells: unknown[]): boolean =>
    cells.some((c) => {
      const t = headerText(c as Cell);
      return t.includes("weight") || t.includes("despatch") || t.includes("dispatch") || t.includes("release");
    });
  for (let i = 0; i < limit; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;
    const hasType = cells.some((c) => {
      const t = headerText(c as Cell);
      return t.includes("tower type") || t === "structure" || t.includes("type code");
    });
    if (!hasType) continue;
    if (hasMeasure(cells)) return i;
    const next = grid[i + 1];
    if (Array.isArray(next) && hasMeasure(next)) return i;
  }
  return -1;
}

// Build one COMPOSITE label per physical column by forward-filling the group
// header row across its merged span (SheetJS leaves merged-cell continuations
// null) and joining it to the sub-header row when present. Also returns the first
// data row index (after the one- or two-row header).
function buildHeaderModel(
  grid: unknown[][],
  headerRow: number,
): { labels: string[]; dataStart: number } {
  if (headerRow < 0 || !Array.isArray(grid[headerRow])) {
    return { labels: [], dataStart: headerRow >= 0 ? headerRow + 1 : 0 };
  }
  const group = grid[headerRow] as unknown[];
  const subRow = grid[headerRow + 1];
  const twoRow = Array.isArray(subRow) && looksLikeSubHeader(subRow);
  const sub = (twoRow ? subRow : []) as unknown[];
  const width = Math.max(group.length, sub.length);
  const labels: string[] = [];
  let carry = "";
  for (let i = 0; i < width; i++) {
    const g = headerText(group[i] as Cell);
    if (g) carry = g;
    const s = twoRow ? headerText(sub[i] as Cell) : "";
    labels[i] = `${carry} ${s}`.replace(/\s+/g, " ").trim();
  }
  return { labels, dataStart: twoRow ? headerRow + 2 : headerRow + 1 };
}

// Resolve logical -> physical column indices from composite header labels.
function buildColumnIndex(labels: string[]): ColumnIndex {
  const resolve = (spec: HeaderSpec): number => {
    for (const group of spec.include) {
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        if (!l) continue;
        if (spec.exclude?.some((x) => l.includes(x))) continue;
        if (group.every((t) => l.includes(t))) return i;
      }
    }
    return spec.fallback;
  };
  const idx = {} as ColumnIndex;
  for (const spec of HEADER_SPECS) idx[spec.key] = resolve(spec);
  return idx;
}

// Pull "As on : DD/MM/YYYY" (or similar) from the banner rows above the header.
function detectAsOnDate(grid: unknown[][], headerRow: number): string | null {
  const limit = headerRow >= 0 ? headerRow : Math.min(grid.length, 15);
  for (let i = 0; i < limit; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) {
      const s = cellStr(cell as Cell);
      if (!s) continue;
      const m = s.match(/as[\s-]*on\s*:?\s*(.+)$/i) || s.match(/dated?\s*:?\s*(.+)$/i);
      if (m && m[1]) {
        const d = formatDate(m[1].trim());
        if (d) return d;
      }
    }
  }
  return null;
}

const PROJECT_BANNER = /project\s*code\s*:?\s*([A-Za-z0-9.\-/]+)/i;
const TOTAL_ROW = /^(sub\s*total|grand\s*total|total)\b/i;

// Parse an Order Review workbook into per-(project, structure) rows. Forward-fills
// the "Project Code : NNN" banner; skips Sub Total / Total rows; keeps only rows
// with a non-empty structure (Tower Type Code).
export function parseOrderReview(buffer: Buffer): OrderReviewParseResult {
  const grid = getGrid(buffer);
  const headerRow = detectHeaderRow(grid);
  const asOnDate = detectAsOnDate(grid, headerRow);
  const { labels, dataStart } = buildHeaderModel(grid, headerRow);
  const cols = buildColumnIndex(labels);

  const rows: ParsedOrderReviewRow[] = [];
  const projects = new Set<string>();
  let currentProject = "";
  let rowsRead = 0;
  let skippedTotals = 0;
  let missingStructure = 0;
  let totalWeightMt = 0;
  let totalReleaseMt = 0;
  let totalFileDespatchMt = 0;

  for (let i = dataStart; i < grid.length; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;

    // Forward-fill the project from any "Project Code : NNN" banner cell.
    let bannerHit = false;
    for (const cell of cells) {
      const s = cellStr(cell as Cell);
      if (!s) continue;
      const m = s.match(PROJECT_BANNER);
      if (m && m[1]) {
        currentProject = normalizeProject(m[1]);
        bannerHit = true;
      }
    }

    const firstText = cells.map((c) => cellStr(c as Cell)).find((s) => s !== "") ?? "";
    if (TOTAL_ROW.test(firstText)) {
      skippedTotals++;
      continue;
    }
    if (bannerHit) continue;

    const structure = normalizeStructure(cellStr(cells[cols.structure] as Cell));
    if (!structure) {
      // A row with measures but no structure is a data-quality miss; a fully
      // blank row is silently skipped.
      const anyValue = cells.some((c) => cellStr(c as Cell) !== "");
      if (anyValue) missingStructure++;
      continue;
    }

    rowsRead++;
    const weightMt = toNumber(cells[cols.weightMt] as Cell);
    const releaseMt = toNumber(cells[cols.releaseMt] as Cell);
    const fileDespatchMt = toNumber(cells[cols.fileDespatchMt] as Cell);
    if (weightMt != null) totalWeightMt += weightMt;
    if (releaseMt != null) totalReleaseMt += releaseMt;
    if (fileDespatchMt != null) totalFileDespatchMt += fileDespatchMt;
    if (currentProject) projects.add(currentProject);

    rows.push({
      project: currentProject,
      structure,
      subType: cellStr(cells[cols.subType] as Cell) || null,
      sets: toInt(cells[cols.sets] as Cell),
      weightMt,
      bomType: cellStr(cells[cols.bomType] as Cell) || null,
      releaseMt,
      fileDespatchMt,
    });
  }

  const summary: OrderReviewSummary = {
    rowsRead,
    rowsKept: rows.length,
    projectsFound: projects.size,
    totalWeightMt,
    totalReleaseMt,
    totalFileDespatchMt,
    skippedTotals,
    missingStructure,
    // WIP join coverage needs DB context; enriched by computeWipCoverage at
    // stage/ingest time. A bare parse reports 0/0.
    matchedToWip: 0,
    unmatchedToWip: 0,
  };

  return { asOnDate, rows, summary };
}
