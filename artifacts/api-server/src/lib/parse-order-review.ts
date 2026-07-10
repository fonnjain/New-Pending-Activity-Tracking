import * as XLSX from "xlsx";
import type { OrderReviewSummary } from "@workspace/db";
import { logger } from "./logger";

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
  // Order Qty Weight (MT) — col G (total order weight).
  weightMt: number | null;
  // WO Order Qty Weight (MT) — col J (work-order qty; base for balance figures).
  woOrderQtyMt: number | null;
  bomType: string | null;
  releaseMt: number | null;
  fabMt: number | null;
  galvMt: number | null;
  // Progress Inspection (MT) — col O.
  inspectionMt: number | null;
  fileDespatchMt: number | null;
  // File-stated balances: Balance Release (col S), Balance Despatch (col W).
  fileBalReleaseMt: number | null;
  fileBalDespatchMt: number | null;
  // Balance Fabrication (col T) / Balance Galvanising (col U).
  balFabMt: number | null;
  balGalvMt: number | null;
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

// Fix 1: Strip a single leading "-" from an OR structure code, mirroring what the
// WIP parser already does to its Alias column.
// Guard: result must be non-empty AND contain at least one non-dash character.
// This preserves all-dash VR082 placeholders ("-", "--", "---", "----") which would
// reduce to all-dash or empty strings — both of which the guard blocks.
function stripLeadingDash(structure: string): string {
  if (!structure.startsWith("-")) return structure;
  const stripped = structure.slice(1);
  // Empty result or all-dash result → do NOT strip.
  if (!stripped || !/[^-]/.test(stripped)) return structure;
  return stripped;
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
  woOrderQtyMt: number;
  bomType: number;
  releaseMt: number;
  fabMt: number;
  galvMt: number;
  inspectionMt: number;
  fileDespatchMt: number;
  fileBalReleaseMt: number;
  fileBalDespatchMt: number;
  balFabMt: number;
  balGalvMt: number;
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
  // WO (Work Order) Order Qty Weight — col J. Requires an explicit "wo"/"work
  // order" term so it never collides with the col G Order Qty Weight above (which
  // excludes those very terms).
  { key: "woOrderQtyMt", include: [["wo order qty", "weight"], ["work order", "weight"], ["wo", "weight"]], exclude: ["/ set", "per set", "balance"], fallback: 9 },
  { key: "bomType", include: [["bom"]], fallback: 10 },
  { key: "releaseMt", include: [["progress", "release"], ["release"]], exclude: ["balance"], fallback: 11 },
  { key: "fabMt", include: [["progress", "fabrication"], ["fabrication (mt)"], ["fabrication"]], exclude: ["balance", "work order", "wo"], fallback: 12 },
  { key: "galvMt", include: [["progress", "galvanis"], ["galvanising (mt)"], ["galvanizing (mt)"], ["galvanis"]], exclude: ["balance", "work order", "wo"], fallback: 13 },
  { key: "inspectionMt", include: [["progress", "inspection"], ["inspection (mt)"], ["inspection"]], exclude: ["balance", "work order", "wo"], fallback: 14 },
  { key: "fileDespatchMt", include: [["progress", "despatch"], ["progress", "dispatch"], ["despatch"], ["dispatch"]], exclude: ["balance"], fallback: 16 },
  // File-stated balances (col S / col W). These are the ONLY specs that require a
  // "balance" term; every other measure spec excludes it, so there is no overlap.
  { key: "fileBalReleaseMt", include: [["balance", "release"]], fallback: 18 },
  { key: "fileBalDespatchMt", include: [["balance", "despatch"], ["balance", "dispatch"]], fallback: 22 },
  // Balance Fabrication (col T) / Balance Galvanising (col U). Same "balance"
  // discipline as the two specs above — the plain fabMt/galvMt specs exclude
  // "balance", so there is no overlap.
  { key: "balFabMt", include: [["balance", "fabrication"]], fallback: 19 },
  { key: "balGalvMt", include: [["balance", "galvanis"]], fallback: 20 },
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
        // Banner text is day-first (VTPL convention, e.g. "06/07/2026" = 6 Jul).
        // Use parseLooseDate (day-first-aware), NOT formatDate's `new Date(s)`
        // fallback, which mis-reads it as MM/DD/YYYY (US) and silently stores
        // the wrong asOnDate, desyncing it from detectReportAsOnDate's pairing date.
        const d = parseLooseDate(m[1].trim());
        if (d) return d;
      }
    }
  }
  return null;
}

// Parse a date out of free text (a report banner cell or a filename). Handles the
// VTPL report convention (day-first DD/MM/YYYY, also `.` or `-` separators) and ISO
// YYYY-MM-DD. Returns a YYYY-MM-DD string or null. NOTE: `new Date(text)` is NOT
// used — it cannot parse day-first dates like "29/06/2026" (returns Invalid Date),
// which is exactly why the in-file banner went undetected before.
function parseLooseDate(text: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (y: number, m: number, d: number): string | null =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;
  // ISO first: YYYY[sep]M[sep]D.
  let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // Day-first: D[sep]M[sep]YYYY (the report convention). If the day/month are
  // unambiguously swapped (month > 12 but day <= 12) fall back to month-first.
  m = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    if (b > 12 && a <= 12) return valid(y, a, b);
    return valid(y, b, a);
  }
  return null;
}

// Detect the report's "As on" pairing date. Looks in two places, in order:
//   1. The in-file banner — any of the top rows mentioning "as on" / "dated"
//      (e.g. "As On Date :29/06/2026"). Authoritative when present.
//   2. The filename (e.g. "wip 29.06.2026.xls", "Order Review29-6-2026.xlsx") —
//      WIP exports carry NO banner, so the name is the only in-band date source.
// Used to pair a WIP import with its Order Review strictly by date. Returns a
// YYYY-MM-DD string, or null when no parseable date is present anywhere.
export function detectReportAsOnDate(
  buffer: Buffer,
  filename?: string,
): string | null {
  try {
    const grid = getGrid(buffer);
    const limit = Math.min(grid.length, 15);
    for (let i = 0; i < limit; i++) {
      const cells = grid[i];
      if (!Array.isArray(cells)) continue;
      for (const cell of cells) {
        const s = cellStr(cell as Cell);
        if (s && /as[\s-]*on|dated?\b/i.test(s)) {
          const d = parseLooseDate(s);
          if (d) return d;
        }
      }
    }
  } catch {
    // fall through to the filename
  }
  if (filename) {
    const fromName = parseLooseDate(filename);
    if (fromName) return fromName;
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
  let currentStructure = ""; // forward-filled across BOM rows (Proto→Mass→Pre)
  // Tracks (project\x01structure) keys already emitted — used by the
  // leading-dash strip collision guard below.
  const seenStructures = new Set<string>();
  let rowsRead = 0;
  let skippedTotals = 0;
  let missingStructure = 0;
  let totalWeightMt = 0;
  let totalReleaseMt = 0;
  let totalFileDespatchMt = 0;

  for (let i = dataStart; i < grid.length; i++) {
    const cells = grid[i];
    if (!Array.isArray(cells)) continue;

    // Peek at the structure column and check for numeric payload BEFORE the
    // banner scan. Some Order Review exports write the full "Project Code : NNN"
    // text in the project column on every Mass/Pre data row (not only on a
    // dedicated section-banner row). Those rows must be parsed as data, not
    // silently skipped as banners. We distinguish them from pure section-banner
    // rows (which have banner text in at most one cell, everything else blank)
    // by two signals:
    //   1. rawStructure non-empty  → definitely a data row (structure is present)
    //   2. hasNumericData true     → data row carrying MT / set figures
    // Only when BOTH are false is the row treated as a pure banner and skipped.
    const rawStructureCell = normalizeStructure(cellStr(cells[cols.structure] as Cell));
    // Fix 2: if the structure cell itself contains a project-banner string (e.g.
    // "Project Code : 920"), this is a header/banner row that leaked into the data
    // range — treat it as structure-less so isPureBanner fires and the row is
    // skipped without polluting currentStructure.
    const rawStructure = PROJECT_BANNER.test(rawStructureCell) ? "" : rawStructureCell;
    const hasNumericData = cells.some((c) => {
      const s = cellStr(c as Cell);
      if (!s || PROJECT_BANNER.test(s)) return false;
      return toNumber(c as Cell) !== null;
    });

    // Forward-fill the project from any "Project Code : NNN" banner cell.
    let bannerHit = false;
    for (const cell of cells) {
      const s = cellStr(cell as Cell);
      if (!s) continue;
      const m = s.match(PROJECT_BANNER);
      if (m && m[1]) {
        const nextProject = normalizeProject(m[1]);
        // A pure banner row has no structure in Col C and no numeric data.
        // Data rows that embed the project code inline have MT values in other
        // columns — they must be processed as data, not skipped.
        const isPureBanner = !rawStructure && !hasNumericData;
        if (nextProject !== currentProject) {
          if (isPureBanner) {
            // Project change on a pure banner row — reset the structure carry
            // so continuation rows from the previous project don't bleed into
            // the new project. On data rows the structure column handles this.
            currentStructure = "";
          }
        }
        // Same-project banners (e.g. one per BOM section: Proto / Mass / Pre)
        // must NOT wipe currentStructure; the next continuation row (blank Col C)
        // should still inherit the last structure from the preceding section.
        currentProject = nextProject;
        if (isPureBanner) {
          bannerHit = true;
        }
      }
    }

    const firstText = cells.map((c) => cellStr(c as Cell)).find((s) => s !== "") ?? "";
    if (TOTAL_ROW.test(firstText)) {
      skippedTotals++;
      continue;
    }
    if (bannerHit) continue;

    // Forward-fill structure across BOM rows within a project.
    // The first (Proto) row has the Tower Type Code in Col C; Mass/Pre continuation
    // rows have blank Col C and belong to the same structure. We carry the last
    // non-blank structure seen in this project group — exactly like currentProject.
    if (rawStructure) {
      // Fix 1: strip a single leading "-" so OR "-069-2NBA1" matches WIP "069-2NBA1".
      // The all-dash guard in stripLeadingDash protects VR082 placeholders
      // ("-", "--", "---", "----") whose stripped form would be all-dash or empty.
      const candidate = stripLeadingDash(rawStructure);
      if (candidate !== rawStructure) {
        // Collision guard: if the stripped structure was already emitted for this
        // project (e.g. the file happens to contain both "-ABC" and "ABC"), keep
        // the original to avoid silently merging two distinct structures.
        const collisionKey = `${currentProject}\u0001${candidate}`;
        if (seenStructures.has(collisionKey)) {
          logger.warn(
            { project: currentProject, original: rawStructure, stripped: candidate },
            "OR leading-dash strip skipped: collision with existing structure",
          );
          currentStructure = rawStructure;
        } else {
          currentStructure = candidate;
        }
      } else {
        currentStructure = rawStructure;
      }
    }
    if (!currentStructure) {
      // No structure yet in this project group — genuinely orphaned row.
      const anyValue = cells.some((c) => cellStr(c as Cell) !== "");
      if (anyValue) missingStructure++;
      continue;
    }
    const structure = currentStructure;

    rowsRead++;
    const weightMt = toNumber(cells[cols.weightMt] as Cell);
    const woOrderQtyMt = toNumber(cells[cols.woOrderQtyMt] as Cell);
    const releaseMt = toNumber(cells[cols.releaseMt] as Cell);
    const fabMt = toNumber(cells[cols.fabMt] as Cell);
    const galvMt = toNumber(cells[cols.galvMt] as Cell);
    const inspectionMt = toNumber(cells[cols.inspectionMt] as Cell);
    const fileDespatchMt = toNumber(cells[cols.fileDespatchMt] as Cell);
    const fileBalReleaseMt = toNumber(cells[cols.fileBalReleaseMt] as Cell);
    const fileBalDespatchMt = toNumber(cells[cols.fileBalDespatchMt] as Cell);
    const balFabMt = toNumber(cells[cols.balFabMt] as Cell);
    const balGalvMt = toNumber(cells[cols.balGalvMt] as Cell);
    if (weightMt != null) totalWeightMt += weightMt;
    if (releaseMt != null) totalReleaseMt += releaseMt;
    if (fileDespatchMt != null) totalFileDespatchMt += fileDespatchMt;
    if (currentProject) projects.add(currentProject);
    seenStructures.add(`${currentProject}\u0001${structure}`);

    rows.push({
      project: currentProject,
      structure,
      subType: cellStr(cells[cols.subType] as Cell) || null,
      sets: toInt(cells[cols.sets] as Cell),
      weightMt,
      woOrderQtyMt,
      bomType: cellStr(cells[cols.bomType] as Cell) || null,
      releaseMt,
      fabMt,
      galvMt,
      inspectionMt,
      fileDespatchMt,
      fileBalReleaseMt,
      fileBalDespatchMt,
      balFabMt,
      balGalvMt,
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

// ── Order Review format & sanity check ──────────────────────────────────────
// All checks are WARN-ONLY and never block the import. They run synchronously
// at stage time (Parts 1 & 2) and optionally via a Claude call (Part 3).

export interface OrFormatCheck {
  ok: boolean;
  /** True when the two-row header block could be located in the grid. */
  headerFound: boolean;
  /** True when the sub-header row (carrying "Sets", "Weight (MT)", …) was detected. */
  twoRowHeader: boolean;
  /** Number of non-empty composite label columns found. */
  foundCount: number;
  /** Number of columns in the EXPECTED_OR_COLUMNS baseline. */
  expectedCount: number;
  /** Display names of expected columns not found in the file (not counting renames). */
  missingExpected: string[];
  /** Subset of missingExpected whose absence breaks key features (buckets / join). */
  criticalMissing: string[];
  /** Columns where text changed (e.g. "Despatch" → "Dispatch"). */
  renames: { expected: string; foundAs: string }[];
  /** Human-readable summary of the combined impact, or null when the check passed. */
  impactNote: string | null;
}

export interface OrDataFlag {
  check: string;
  severity: "warn" | "info";
  message: string;
  impact: string;
}

export interface OrSanityResult {
  formatCheck: OrFormatCheck;
  dataFlags: OrDataFlag[];
  /** True only when format passed and no warn-severity data flags were raised. */
  passedAll: boolean;
}

interface OrSpec {
  display: string;
  /** All terms must appear in at least one composite label for the column to be "found". */
  terms: string[];
  /** Optional alternate term-sets; if matched while primary terms fail → rename. */
  alternates?: string[][];
  critical: boolean;
}

/**
 * Canonical column layout for the Order Review two-row merged-header export.
 * One entry per expected logical column (display names only — the actual matching
 * is done by OR_SPECS below). This is the single source of truth for "what the
 * format should look like"; update here when the export format changes.
 */
export const EXPECTED_OR_COLUMNS: readonly string[] = [
  "Tower Type",
  "Tower Sub Type",
  "Weight / Set (MT)",
  "Order Qty — Sets",
  "Order Qty — Weight (MT)",
  "WO Order Qty — Sets",
  "WO Order Qty — Weight (MT)",
  "BOM Label",
  "Progress — Release (MT)",
  "Progress — Fabrication (MT)",
  "Progress — Galvanising (MT)",
  "Progress — Inspection (MT)",
  "Progress — Despatch (MT)",
  "Balance — Work Order (MT)",
  "Balance — Release (MT)",
  "Balance — Fabrication (MT)",
  "Balance — Galvanising (MT)",
  "Balance — Inspection (MT)",
  "Balance — Despatch (MT)",
];

// Fuzzy-matching specs for format drift detection.  Each column is matched
// against composite labels by requiring ALL `terms` to appear in at least one
// label. `alternates` triggers rename detection (primary terms absent, alt terms
// present → same concept with a different spelling).
const OR_SPECS: OrSpec[] = [
  { display: "Tower Type",                 terms: ["tower type"],                    critical: true  },
  { display: "Tower Sub Type",             terms: ["tower sub"],                     critical: false },
  { display: "Weight / Set (MT)",          terms: ["weight", "set"],                 critical: false },
  { display: "Order Qty — Sets",           terms: ["order qty", "sets"],             critical: false },
  { display: "Order Qty — Weight (MT)",    terms: ["order qty", "weight"],           critical: false },
  { display: "WO Order Qty — Sets",        terms: ["wo order qty", "sets"],          critical: false },
  { display: "WO Order Qty — Weight (MT)", terms: ["wo", "order", "weight"],         critical: true  },
  { display: "BOM Label",                  terms: ["bom"],                           critical: true  },
  { display: "Progress — Release (MT)",    terms: ["progress", "release"],           critical: false },
  { display: "Progress — Fabrication (MT)",terms: ["progress", "fab"],               critical: false },
  {
    display: "Progress — Galvanising (MT)", terms: ["progress", "galvanis"],         critical: true,
    alternates: [["progress", "galvaniz"]],
  },
  { display: "Progress — Inspection (MT)", terms: ["progress", "inspection"],        critical: true  },
  {
    display: "Progress — Despatch (MT)",   terms: ["progress", "despatch"],          critical: false,
    alternates: [["progress", "dispatch"]],
  },
  { display: "Balance — Work Order (MT)",  terms: ["balance", "work order"],         critical: false },
  { display: "Balance — Release (MT)",     terms: ["balance", "release"],            critical: true  },
  { display: "Balance — Fabrication (MT)", terms: ["balance", "fab"],                critical: true  },
  {
    display: "Balance — Galvanising (MT)", terms: ["balance", "galvanis"],           critical: true,
    alternates: [["balance", "galvaniz"]],
  },
  { display: "Balance — Inspection (MT)", terms: ["balance", "inspection"],          critical: false },
  {
    display: "Balance — Despatch (MT)",    terms: ["balance", "despatch"],           critical: false,
    alternates: [["balance", "dispatch"]],
  },
];

function labelsContainAll(labels: string[], terms: string[]): boolean {
  return labels.some((lbl) => terms.every((t) => lbl.includes(t)));
}

/** Part 1 — Format drift check. Runs purely on the raw buffer (no DB). */
export function checkOrderReviewFormat(buffer: Buffer): OrFormatCheck {
  let grid: unknown[][];
  try {
    grid = getGrid(buffer);
  } catch {
    return {
      ok: false, headerFound: false, twoRowHeader: false,
      foundCount: 0, expectedCount: EXPECTED_OR_COLUMNS.length,
      missingExpected: [...EXPECTED_OR_COLUMNS],
      criticalMissing: OR_SPECS.filter((s) => s.critical).map((s) => s.display),
      renames: [],
      impactNote: "The file could not be read as a spreadsheet.",
    };
  }

  const headerRow = detectHeaderRow(grid);
  const headerFound = headerRow >= 0;
  const { labels } = buildHeaderModel(grid, headerRow);
  const nextRow = grid[headerRow + 1];
  const twoRowHeader =
    headerFound && Array.isArray(nextRow) && looksLikeSubHeader(nextRow);

  const missingExpected: string[] = [];
  const criticalMissing: string[] = [];
  const renames: { expected: string; foundAs: string }[] = [];

  for (const spec of OR_SPECS) {
    if (labelsContainAll(labels, spec.terms)) continue;
    let renamed = false;
    if (spec.alternates) {
      for (const altTerms of spec.alternates) {
        if (labelsContainAll(labels, altTerms)) {
          renames.push({
            expected: spec.display,
            foundAs: spec.display
              .replace("Despatch", "Dispatch")
              .replace("Galvanising", "Galvanizing"),
          });
          renamed = true;
          break;
        }
      }
    }
    if (!renamed) {
      missingExpected.push(spec.display);
      if (spec.critical) criticalMissing.push(spec.display);
    }
  }

  const ok = headerFound && missingExpected.length === 0 && renames.length === 0;
  const nonEmpty = labels.filter((l) => l.trim()).length;

  let impactNote: string | null = null;
  if (!headerFound) {
    impactNote =
      "The two-row header block could not be located — the file layout may have changed significantly. All measures fall back to fixed column positions and may be read from the wrong columns.";
  } else if (criticalMissing.includes("Tower Type")) {
    impactNote =
      '"Tower Type" (structure code) is missing — structures cannot be identified and no WIP join is possible.';
  } else if (criticalMissing.length > 0) {
    const balCrit = criticalMissing.filter((c) => c.startsWith("Balance"));
    impactNote = balCrit.length > 0
      ? `Critical balance columns missing (${balCrit.join(", ")}) — order status figures and release balance will be incorrect.`
      : `Critical columns missing (${criticalMissing.join(", ")}) — some features will show incorrect values.`;
  } else if (renames.length > 0) {
    impactNote =
      "Column text differs from the expected layout (e.g. spelling variants). The parser falls back to position-based matching; verify that parsed values are correct.";
  }

  return {
    ok, headerFound, twoRowHeader,
    foundCount: nonEmpty,
    expectedCount: EXPECTED_OR_COLUMNS.length,
    missingExpected, criticalMissing, renames, impactNote,
  };
}

const OR_TOL_MT = 0.5;

/** Part 2 — Deterministic data sanity checks over the parsed result. */
export function runOrderReviewDataChecks(
  parseResult: OrderReviewParseResult,
  buffer: Buffer,
  opts?: {
    prevSummary?: { unmatchedToWip?: number } | null;
    prevAsOnDate?: string | null;
  },
): OrDataFlag[] {
  const flags: OrDataFlag[] = [];
  const { rows, summary, asOnDate } = parseResult;

  if (!summary || rows.length === 0) {
    flags.push({
      check: "empty_file", severity: "warn",
      message: "No structure rows were parsed from this file.",
      impact: "All Order Status figures will show zero. Verify this is the correct file.",
    });
    return flags;
  }

  if ((summary.projectsFound ?? 0) === 0) {
    flags.push({
      check: "no_projects", severity: "warn",
      message: "No project codes were found in the file.",
      impact: "All project-level order figures will be absent from Order Status.",
    });
  }

  const allZero = rows.every(
    (r) => (r.weightMt ?? 0) === 0 && (r.releaseMt ?? 0) === 0 && (r.fileDespatchMt ?? 0) === 0,
  );
  if (allZero) {
    flags.push({
      check: "all_zero_measures", severity: "warn",
      message: "All weight, release, and despatch measures are zero across every structure.",
      impact: "Release Balance Computed, Assignment Balance, and the Fabrication Report will all show zero. The file may be empty or the column mapping may have failed.",
    });
  }

  if ((summary.missingStructure ?? 0) > 0) {
    flags.push({
      check: "missing_structure", severity: "info",
      message: `${summary.missingStructure} row${summary.missingStructure === 1 ? "" : "s"} had no structure code (Tower Type) and will not join to WIP marks.`,
      impact: "Those rows are excluded from Order Status. Check if a Tower Type column rename caused them to be missed.",
    });
  }

  const prevSummary = opts?.prevSummary;
  if (prevSummary != null) {
    const prevUnmatched = prevSummary.unmatchedToWip ?? 0;
    const currUnmatched = summary.unmatchedToWip ?? 0;
    if (prevUnmatched > 0 && currUnmatched > prevUnmatched * 1.2) {
      const pct = Math.round(((currUnmatched - prevUnmatched) / prevUnmatched) * 100);
      flags.push({
        check: "unmatched_spike", severity: "warn",
        message: `Unmatched-to-WIP structures jumped from ${prevUnmatched} to ${currUnmatched} (+${pct}%) vs the previous import.`,
        impact: "More structures won't contribute to Order Status figures. This may indicate a naming or format change in the file or a WIP pairing mismatch.",
      });
    }
  }

  // Duplicate (project, structure) keys
  const structureKeys = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.project}\u0001${r.structure}`;
    structureKeys.set(key, (structureKeys.get(key) ?? 0) + 1);
  }
  const dupCount = [...structureKeys.values()].filter((v) => v > 1).length;
  if (dupCount > 0) {
    flags.push({
      check: "duplicate_structures", severity: "warn",
      message: `${dupCount} (project, structure) pair${dupCount === 1 ? "" : "s"} appear more than once in the parsed data.`,
      impact: "Duplicate keys are UPSERT'd — the last row wins. Verify no BOM-summing boundary was lost.",
    });
  }

  // Negative values
  let negBalReleaseCount = 0;
  let negBalReleaseTotalMt = 0;
  let implausibleNegCount = 0;
  for (const r of rows) {
    if ((r.fileBalReleaseMt ?? 0) < 0) {
      negBalReleaseCount++;
      negBalReleaseTotalMt += r.fileBalReleaseMt ?? 0;
    }
    if ((r.sets ?? 0) < 0 || (r.weightMt ?? 0) < 0 || (r.woOrderQtyMt ?? 0) < 0) {
      implausibleNegCount++;
    }
  }
  if (negBalReleaseCount > 0) {
    flags.push({
      check: "negative_balance_release", severity: "info",
      message: `${negBalReleaseCount} structure${negBalReleaseCount === 1 ? "" : "s"} have negative Balance Release (total: ${negBalReleaseTotalMt.toFixed(2)} MT), indicating over-release.`,
      impact: "Over-released structures are allowed but review whether the quantities are intentional.",
    });
  }
  if (implausibleNegCount > 0) {
    flags.push({
      check: "negative_quantities", severity: "warn",
      message: `${implausibleNegCount} structure${implausibleNegCount === 1 ? "" : "s"} have negative Order Qty, WO Order Qty, or Weight values.`,
      impact: "Negative quantities are unexpected and may indicate a column mapping error. Check the file.",
    });
  }

  // Totals reconciliation vs file Grand Total footer
  try {
    const grid = getGrid(buffer);
    const hRow = detectHeaderRow(grid);
    const { labels, dataStart } = buildHeaderModel(grid, hRow);
    const cols = buildColumnIndex(labels);

    let footerWoOrderQty: number | null = null;
    let footerRelease: number | null = null;
    let footerDespatch: number | null = null;
    let footerBalRelease: number | null = null;

    for (let i = dataStart; i < grid.length; i++) {
      const cells = grid[i];
      if (!Array.isArray(cells)) continue;
      const firstText =
        cells.map((c) => cellStr(c as Cell)).find((s) => s !== "") ?? "";
      if (/^(grand\s*total|total)\b/i.test(firstText)) {
        footerWoOrderQty = toNumber(cells[cols.woOrderQtyMt] as Cell);
        footerRelease    = toNumber(cells[cols.releaseMt]    as Cell);
        footerDespatch   = toNumber(cells[cols.fileDespatchMt] as Cell);
        footerBalRelease = toNumber(cells[cols.fileBalReleaseMt] as Cell);
        break;
      }
    }

    if (footerWoOrderQty !== null || footerRelease !== null || footerDespatch !== null) {
      const sumWo       = rows.reduce((s, r) => s + (r.woOrderQtyMt    ?? 0), 0);
      const sumRelease  = rows.reduce((s, r) => s + (r.releaseMt       ?? 0), 0);
      const sumDespatch = rows.reduce((s, r) => s + (r.fileDespatchMt  ?? 0), 0);
      const sumBalRel   = rows.reduce((s, r) => s + (r.fileBalReleaseMt ?? 0), 0);

      const mismatches: string[] = [];
      if (footerWoOrderQty !== null && Math.abs(sumWo - footerWoOrderQty) > OR_TOL_MT)
        mismatches.push(`WO Order Qty (parsed ${sumWo.toFixed(2)} MT vs footer ${footerWoOrderQty.toFixed(2)} MT)`);
      if (footerRelease !== null && Math.abs(sumRelease - footerRelease) > OR_TOL_MT)
        mismatches.push(`Progress Release (parsed ${sumRelease.toFixed(2)} MT vs footer ${footerRelease.toFixed(2)} MT)`);
      if (footerDespatch !== null && Math.abs(sumDespatch - footerDespatch) > OR_TOL_MT)
        mismatches.push(`Progress Despatch (parsed ${sumDespatch.toFixed(2)} MT vs footer ${footerDespatch.toFixed(2)} MT)`);
      if (footerBalRelease !== null && Math.abs(sumBalRel - footerBalRelease) > OR_TOL_MT)
        mismatches.push(`Balance Release (parsed ${sumBalRel.toFixed(2)} MT vs footer ${footerBalRelease.toFixed(2)} MT)`);

      if (mismatches.length > 0) {
        flags.push({
          check: "totals_reconciliation", severity: "warn",
          message: `Parsed totals differ from the file Grand Total footer by > ${OR_TOL_MT} MT: ${mismatches.join("; ")}.`,
          impact: "Some BOM rows may have been missed or double-counted. Verify the parsed row count matches the expected total.",
        });
      }
    }
  } catch {
    // Non-critical — skip totals check silently
  }

  // As-on date sanity
  if (opts?.prevAsOnDate && asOnDate && asOnDate < opts.prevAsOnDate) {
    flags.push({
      check: "stale_date", severity: "warn",
      message: `This file's as-on date (${asOnDate}) is older than the current Order Review import (${opts.prevAsOnDate}).`,
      impact: "Importing this file will replace more recent Order Review data with older data.",
    });
  }

  return flags;
}

/**
 * Run Parts 1 & 2 and combine into a single OrSanityResult.
 * Called at stage time; the buffer is still in memory (not yet in the DB).
 */
export function checkOrderReview(
  buffer: Buffer,
  parseResult: OrderReviewParseResult,
  opts?: {
    prevSummary?: { unmatchedToWip?: number } | null;
    prevAsOnDate?: string | null;
  },
): OrSanityResult {
  const formatCheck = checkOrderReviewFormat(buffer);
  const dataFlags   = runOrderReviewDataChecks(parseResult, buffer, opts);
  const passedAll   =
    formatCheck.ok && dataFlags.filter((f) => f.severity === "warn").length === 0;
  return { formatCheck, dataFlags, passedAll };
}
