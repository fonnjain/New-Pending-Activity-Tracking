// Static import so Vite bundles ExcelJS into the main chunk rather than a lazy
// chunk.  Dynamic `await import("exceljs")` was previously used here, which
// caused a "Failed to fetch dynamically imported module" error in production
// when the chunk hash changed between builds and the old deployment still served
// the old hash.
import ExcelJS from "exceljs";
import { trackReportGenerated } from "@/lib/usage-tracking";

// Returns a compact timestamp string safe for use in filenames: YYYYMMDD_HHmmss
// e.g. "20260810_143022". Use this for all export filenames so downloads are
// unique and sort chronologically in the file system.
export function exportTimestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// Header names + order EXACTLY as parse.ts expects them on the third row of
// Sheet1. Each tuple is [header label, record field]. Keeping this in lockstep
// with the server COL map is what makes a cleaned file round-trip through the
// deterministic engine unchanged (except for the accepted descriptive edits).
const CLEANED_COLUMNS: [string, string][] = [
  ["Project Code", "job"],
  ["Order Nature", "orderNature"],
  ["Contractor", "contractor"],
  ["Job Card No.", "jobCardNo"],
  ["Tower Type", "towerType"],
  ["Tower Sub Type", "towerSubType"],
  ["Alias", "alias"],
  ["Mark No.", "markNo"],
  ["Section", "section"],
  ["Length", "length"],
  ["Width", "width"],
  ["Wt/Pcs", "wtPcs"],
  ["Balance Qty.", "balanceQty"],
  ["Balance Wt.", "balanceWt"],
  ["Assign Date", "assignDate"],
  ["Activity", "activity"],
  ["Operation", "operation"],
  ["Ref. Job Card No.", "refJobCardNo"],
  ["Last Production Entry Date", "lastProductionDate"],
];

// Build a cleaned .xlsx in the exact layout parse.ts reads (Sheet1, header on
// the third row, 18 columns) with accepted descriptive-field suggestions
// applied per record (matched by full-row hash). The user re-uploads this file
// and the engine recomputes everything; nothing is mutated server-side.
export async function exportCleanedXlsx(
  filename: string,
  records: any[],
  overridesByHash: Map<string, Record<string, string | null>>,
) {
  const XLSX = await import("xlsx");
  const header = CLEANED_COLUMNS.map(([label]) => label);
  const aoa: any[][] = [[], [], header];

  for (const r of records) {
    const overrides = overridesByHash.get(r.hash);
    const row = CLEANED_COLUMNS.map(([, field]) => {
      if (overrides && field in overrides) {
        const v = overrides[field];
        return v == null ? "" : v;
      }
      const val = r[field];
      return val == null ? "" : val;
    });
    aoa.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
  trackReportGenerated(filename, "xlsx");
}

// Column spec for the styled .xlsx export. `numeric` right-aligns the column and
// applies a thousands-separated number format (`decimals` controls precision);
// `total` adds a SUM for that column in the totals row at the bottom.
export type XlsxColumn = {
  label: string;
  field: string;
  numeric?: boolean;
  decimals?: number;
  total?: boolean;
  // Optional Excel header-cell comment (hover note), e.g. to declare
  // export-only columns that have no on-screen equivalent.
  headerNote?: string;
};

// A summary/subtotal row inserted between the data and the grand-total row.
// `label` goes in the first column; `values` maps a column field to its numeric
// subtotal. A row with empty `values` acts as a bold section heading.
export type XlsxSummaryRow = {
  label: string;
  values: Record<string, number>;
  // "subtotal" = sub-group row (medium dark border + light fill);
  // "total" = top-level group total (heavy border + slightly darker fill).
  // Omit for a plain bold section heading (empty values row).
  level?: "subtotal" | "total";
};

function numFmt(decimals: number): string {
  return decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
}

// A data section within a sheet. When a sheet uses `sections`, rows and
// summaryRows from each section are written in order (section rows, then
// section summaryRows) before moving to the next section. The grand-total row
// still sums across all sections' rows.
// `blankRows` inserts that many blank/empty rows after this section's summary
// rows, useful for a visual gap between the overview block and the detail data.
// `headerRow` inserts a dark styled column-header row (identical to row 1)
// before this section's data rows — used to label a second block of data after
// an overview + gap at the top of the same sheet.
export type XlsxSection = {
  rows: any[];
  summaryRows?: XlsxSummaryRow[];
  blankRows?: number;
  headerRow?: boolean;
};

// A single worksheet definition for a multi-sheet export.
// Use `sections` when you need per-group summary rows interleaved with data
// (e.g. In-House summary before Out-Vendor rows). If `sections` is set,
// top-level `rows` and `summaryRows` are ignored.
export type XlsxSheet = {
  name: string;
  columns: XlsxColumn[];
  rows?: any[];
  summaryRows?: XlsxSummaryRow[];
  sections?: XlsxSection[];
};

// Parse a value for a numeric column: a finite number when possible, else
// null (never NaN), so anomalous non-numeric data never corrupts a cell.
function toNum(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Excel sheet names: <=31 chars, no \ / ? * [ ] : characters, and unique within
// a workbook. Falls back to "Sheet" and disambiguates collisions with a suffix.
function uniqueSheetName(name: string, used: Set<string>): string {
  const base = (name || "Sheet").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// A labelled group of rows for the combined block-grid sheet.
// Each group maps to one bucket×side block placed side by side with others.
export type XlsxBlockGroup = {
  label: string;        // block title (e.g. "B - Raw Material Incomplete")
  columns: XlsxColumn[]; // NO "side" column — the side is the band label
  rows: any[];
  summaryRows?: XlsxSummaryRow[];
};

// Write one fully-styled worksheet (header band, auto-sized columns, per-section
// summary rows interleaved with data, totals row, and grid borders).
function writeSheet(wb: any, sheet: XlsxSheet, usedNames: Set<string>) {
  const { columns } = sheet;

  // Normalise: sections take precedence over legacy flat rows/summaryRows.
  const sections: XlsxSection[] = sheet.sections ?? [
    { rows: sheet.rows ?? [], summaryRows: sheet.summaryRows ?? [] },
  ];
  const allRows = sections.flatMap((s) => s.rows);

  const ws = wb.addWorksheet(uniqueSheetName(sheet.name, usedNames), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Columns: auto-sized width from all data rows.
  ws.columns = columns.map((c) => {
    const decimals = c.decimals ?? (c.numeric ? 2 : 0);
    let maxLen = c.label.length;
    for (const r of allRows) {
      const v = r[c.field];
      if (v == null) continue;
      const text = c.numeric
        ? (toNum(v) ?? "").toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : String(v);
      if (text.length > maxLen) maxLen = text.length;
    }
    return {
      header: c.label,
      key: c.field,
      width: Math.min(48, Math.max(10, maxLen + 2)),
      style: c.numeric
        ? { numFmt: numFmt(decimals), alignment: { horizontal: "right" } }
        : { alignment: { horizontal: "left" } },
    };
  });

  // Track summary row numbers → level so borders/fills can differ from data rows.
  const summaryRowLevel = new Map<number, "subtotal" | "total">();
  // Track blank gap row numbers so the border loop can skip them entirely.
  const blankRowNums = new Set<number>();
  // Track secondary header row numbers (same dark styling as row 1).
  const secondaryHeaderRowNums = new Set<number>();

  // Write each section: optional secondary-header row, data rows, summary rows,
  // blank gap rows.
  // Track which Excel row numbers have a custom background color (MFC backfill).
  const rowBgColor = new Map<number, string>();

  for (const section of sections) {
    // Secondary header row: dark band identical to row 1, inserted before the
    // section's data to label a second block of data after an overview block.
    if (section.headerRow) {
      const headerObj: Record<string, any> = {};
      for (const c of columns) headerObj[c.field] = c.label;
      const hRow = ws.addRow(headerObj);
      const hRowNum = hRow.number as number;
      hRow.height = 20;
      for (let ci = 1; ci <= columns.length; ci++) {
        const cell = hRow.getCell(ci);
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
      secondaryHeaderRowNums.add(hRowNum);
    }
    for (const r of section.rows) {
      const rowObj: Record<string, any> = {};
      for (const c of columns) {
        const v = r[c.field];
        rowObj[c.field] = c.numeric ? toNum(v) : v == null ? "" : v;
      }
      const excelRow = ws.addRow(rowObj);
      if (r._bgColor) rowBgColor.set(excelRow.number as number, r._bgColor as string);
    }
    for (const s of section.summaryRows ?? []) {
      const obj: Record<string, any> = {};
      columns.forEach((c, i) => {
        if (i === 0) obj[c.field] = s.label;
        else if (c.field in s.values) obj[c.field] = s.values[c.field];
      });
      const row = ws.addRow(obj);
      const level = s.level;
      if (level) summaryRowLevel.set(row.number as number, level);
      const fillColor = level === "total" ? "FFE5E7EB" : "FFF3F4F6";
      for (let ci = 1; ci <= columns.length; ci++) {
        const cell = row.getCell(ci);
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
      }
    }
    for (let i = 0; i < (section.blankRows ?? 0); i++) {
      const gapRow = ws.addRow({});
      blankRowNums.add(gapRow.number as number);
    }
  }

  // Header band.
  const headerRow = ws.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell((cell: any) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  // Header comments (e.g. "export-only columns" note).
  columns.forEach((c, i) => {
    if (c.headerNote) headerRow.getCell(i + 1).note = c.headerNote;
  });

  // Totals row: sums across ALL sections.
  const hasTotals = columns.some((c) => c.total);
  if (hasTotals && allRows.length) {
    const totalObj: Record<string, any> = {};
    columns.forEach((c, i) => {
      if (i === 0) totalObj[c.field] = "TOTAL";
      else if (c.total) totalObj[c.field] = allRows.reduce((s, r) => s + (toNum(r[c.field]) ?? 0), 0);
    });
    const totalRow = ws.addRow(totalObj);
    totalRow.eachCell((cell: any) => { cell.font = { bold: true }; });
  }

  // Grid borders — data rows get light borders; summary rows get level-aware
  // darker borders so major category rows visually stand out.
  const thin      = { style: "thin"   as const, color: { argb: "FFD1D5DB" } };
  const medDark   = { style: "medium" as const, color: { argb: "FF6B7280" } };
  const heavy     = { style: "medium" as const, color: { argb: "FF111827" } };
  const headerBottom = { style: "thin" as const, color: { argb: "FF111827" } };
  const totalsTop    = { style: "thin" as const, color: { argb: "FF9CA3AF" } };
  const totalsRowNum = hasTotals && allRows.length ? ws.rowCount : -1;

  for (let r = 1; r <= ws.rowCount; r++) {
    // Skip blank gap rows entirely — no borders, no fill.
    if (blankRowNums.has(r)) continue;
    const row = ws.getRow(r);
    const level = summaryRowLevel.get(r);
    const isHeader = r === 1 || secondaryHeaderRowNums.has(r);
    const side = level === "total" ? heavy : level === "subtotal" ? medDark : thin;
    const bgArgb = rowBgColor.get(r);
    for (let c = 1; c <= columns.length; c++) {
      const cell = row.getCell(c);
      cell.border = {
        top:    r === totalsRowNum ? totalsTop : (isHeader ? thin : side),
        bottom: isHeader ? headerBottom : side,
        left:   side,
        right:  side,
      };
      // MFC backfill color — skip header (r===1) and summary rows so their
      // own fill (dark header band or light summary fill) takes precedence.
      if (bgArgb && r !== 1 && !summaryRowLevel.has(r)) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
      }
    }
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

// ─── Combined block-grid sheet ─────────────────────────────────────────────
// Layout: all In-House blocks side-by-side, then a gap, then all Out-Vendor
// blocks side-by-side. Each block = one bucket's data for that side.
function writeCombinedBlockSheet(
  wb: any,
  inHouseGroups: XlsxBlockGroup[],
  outVendorGroups: XlsxBlockGroup[],
  usedNames: Set<string>,
) {
  const ws = wb.addWorksheet(uniqueSheetName("Combined", usedNames));

  // Layout: each block occupies its column count, with 1 spacer column between.
  const SPACER = 1;
  const blockLayout = (() => {
    let col = 1;
    return inHouseGroups.map((g) => {
      const start = col;
      const width = g.columns.length;
      col += width + SPACER;
      return { start, width };
    });
  })();
  const totalCols = inHouseGroups.reduce((s, g) => s + g.columns.length, 0) +
    (inHouseGroups.length - 1) * SPACER;

  // Set worksheet column widths from max content across both bands.
  const allGroups = [...inHouseGroups, ...outVendorGroups];
  inHouseGroups.forEach((g, gi) => {
    const { start } = blockLayout[gi];
    const ihRows = inHouseGroups[gi]?.rows ?? [];
    const ovRows = outVendorGroups[gi]?.rows ?? [];
    g.columns.forEach((c, ci) => {
      const decimals = c.decimals ?? (c.numeric ? 2 : 0);
      let maxLen = c.label.length;
      for (const r of [...ihRows, ...ovRows]) {
        const v = r[c.field];
        if (v == null) continue;
        const text = c.numeric
          ? (toNum(v) ?? "").toLocaleString(undefined, {
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
            })
          : String(v);
        if (text.length > maxLen) maxLen = text.length;
      }
      ws.getColumn(start + ci).width = Math.min(24, Math.max(10, maxLen + 2));
    });
    if (gi < inHouseGroups.length - 1) {
      ws.getColumn(start + g.columns.length).width = 2;
    }
  });
  void allGroups; // suppress unused warning

  const thin = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
  const medium = { style: "medium" as const, color: { argb: "FF374151" } };
  const totalsTop = { style: "thin" as const, color: { argb: "FF9CA3AF" } };

  function applyOuterBorder(
    r: number, c: number,
    blockStart: number, blockWidth: number,
    bandStart: number, bandEnd: number,
  ) {
    const cell = ws.getCell(r, c);
    const existing = (cell.border as any) ?? {};
    cell.border = {
      top: r === bandStart ? medium : (existing.top ?? thin),
      bottom: r === bandEnd ? medium : (existing.bottom ?? thin),
      left: c === blockStart ? medium : (existing.left ?? thin),
      right: c === blockStart + blockWidth - 1 ? medium : (existing.right ?? thin),
    };
  }

  // Writes one horizontal band (InHouse or OutVendor) starting at `startRow`.
  // Returns the row number after the last written row.
  function writeBand(groups: XlsxBlockGroup[], bandLabel: string, startRow: number): number {
    let rowNum = startRow;

    const maxDataRows = Math.max(0, ...groups.map((g) => g.rows.length));
    const maxSummaryRows = Math.max(0, ...groups.map((g) => g.summaryRows?.length ?? 0));
    const hasTotals = groups.some((g) => g.columns.some((c) => c.total));
    const bandEnd =
      startRow +
      2 + // band title + block titles + col headers = 3 rows, indices 0..2
      maxDataRows +
      maxSummaryRows +
      (hasTotals ? 1 : 0) - 1;

    // Band title row (full-width).
    {
      const row = ws.getRow(rowNum++);
      row.height = 22;
      if (totalCols > 1) ws.mergeCells(rowNum - 1, 1, rowNum - 1, totalCols);
      const cell = row.getCell(1);
      cell.value = bandLabel;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111827" } };
      cell.alignment = { horizontal: "left", vertical: "middle" };
    }

    // Per-block title row.
    {
      const row = ws.getRow(rowNum++);
      row.height = 20;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const { start, width } = blockLayout[gi];
        if (width > 1) ws.mergeCells(rowNum - 1, start, rowNum - 1, start + width - 1);
        const cell = row.getCell(start);
        cell.value = g.label;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
    }

    // Column header row.
    {
      const row = ws.getRow(rowNum++);
      row.height = 18;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const { start } = blockLayout[gi];
        for (let ci = 0; ci < g.columns.length; ci++) {
          const cell = row.getCell(start + ci);
          cell.value = g.columns[ci].label;
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
          cell.alignment = { horizontal: "center" };
          cell.border = { top: thin, bottom: medium, left: thin, right: thin };
        }
      }
    }

    // Data rows (fixed height = maxDataRows for alignment across blocks).
    for (let i = 0; i < maxDataRows; i++) {
      const row = ws.getRow(rowNum++);
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const { start } = blockLayout[gi];
        const r = g.rows[i];
        if (!r) continue;
        const bgArgb = r._bgColor as string | undefined;
        for (let ci = 0; ci < g.columns.length; ci++) {
          const c = g.columns[ci];
          const cell = row.getCell(start + ci);
          const v = r[c.field];
          if (c.numeric) {
            cell.value = toNum(v);
            cell.numFmt = numFmt(c.decimals ?? 2);
            cell.alignment = { horizontal: "right" };
          } else {
            cell.value = v == null ? "" : v;
          }
          cell.border = { top: thin, bottom: thin, left: thin, right: thin };
          if (bgArgb) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
          }
        }
      }
    }

    // Summary rows (aligned: same slot index across blocks).
    for (let i = 0; i < maxSummaryRows; i++) {
      const row = ws.getRow(rowNum++);
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const { start } = blockLayout[gi];
        const s = (g.summaryRows ?? [])[i];
        if (!s) continue;
        for (let ci = 0; ci < g.columns.length; ci++) {
          const c = g.columns[ci];
          const cell = row.getCell(start + ci);
          if (ci === 0) {
            cell.value = s.label;
          } else if (c.field in s.values) {
            cell.value = s.values[c.field];
            cell.numFmt = numFmt(c.decimals ?? 2);
            cell.alignment = { horizontal: "right" };
          }
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
          cell.border = { top: thin, bottom: thin, left: thin, right: thin };
        }
      }
    }

    // Total row.
    if (hasTotals) {
      const row = ws.getRow(rowNum++);
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const { start } = blockLayout[gi];
        for (let ci = 0; ci < g.columns.length; ci++) {
          const c = g.columns[ci];
          const cell = row.getCell(start + ci);
          if (ci === 0) {
            cell.value = "TOTAL";
          } else if (c.total) {
            cell.value = g.rows.reduce((s, r) => s + (toNum(r[c.field]) ?? 0), 0);
            cell.numFmt = numFmt(c.decimals ?? 2);
            cell.alignment = { horizontal: "right" };
          }
          cell.font = { bold: true };
          cell.border = { top: totalsTop, bottom: thin, left: thin, right: thin };
        }
      }
    }

    // Apply medium outer border around each block.
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const { start, width } = blockLayout[gi];
      for (let r = startRow; r <= bandEnd; r++) {
        for (let c = start; c < start + width; c++) {
          applyOuterBorder(r, c, start, width, startRow, bandEnd);
        }
      }
    }

    return rowNum;
  }

  const afterInHouse = writeBand(inHouseGroups, "IN-HOUSE", 1);
  writeBand(outVendorGroups, "OUT-VENDOR", afterInHouse + 3);
}

export type DownloadableFile = {
  filename: string;
  bytes: Uint8Array;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function workbookBytes(wb: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await wb.xlsx.writeBuffer();
  return Uint8Array.from(buffer as unknown as ArrayLike<number>);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// Stream a finished workbook to the browser as a .xlsx download.
async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
  const bytes = await workbookBytes(wb);
  downloadBlob(new Blob([ownedArrayBuffer(bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), filename);
  trackReportGenerated(filename, "xlsx");
}

/**
 * Produces the exact same styled XLSX used by `exportToXlsx`, but keeps the
 * bytes in memory so callers can place it inside a ZIP instead of triggering a
 * separate browser download.
 */
export async function createXlsxFile(
  filename: string,
  columns: XlsxColumn[],
  rows: any[],
  options: { sheetName?: string; summaryRows?: XlsxSummaryRow[] } = {},
): Promise<DownloadableFile> {
  const { sheetName = "Report", summaryRows = [] } = options;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  writeSheet(wb, { name: sheetName, columns, rows, summaryRows }, new Set<string>());
  return { filename, bytes: await workbookBytes(wb) };
}

/**
 * Produces the same multi-sheet workbook as `exportToXlsxSheets`, without
 * starting a download. This keeps existing report builders reusable by archive
 * exports.
 */
export async function createXlsxSheetsFile(
  filename: string,
  sheets: XlsxSheet[],
  combined?: { inHouse: XlsxBlockGroup[]; outVendor: XlsxBlockGroup[] },
  buildFirst?: (wb: ExcelJS.Workbook) => void,
): Promise<DownloadableFile> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();
  if (buildFirst) {
    buildFirst(wb);
    for (const ws of wb.worksheets) used.add(String(ws.name).toLowerCase());
  }
  if (combined) writeCombinedBlockSheet(wb, combined.inHouse, combined.outVendor, used);
  for (const sheet of sheets) writeSheet(wb, sheet, used);
  return { filename, bytes: await workbookBytes(wb) };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDate(now: Date): { time: number; date: number } {
  const year = Math.max(1980, now.getFullYear());
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

/**
 * Creates a standards-compliant stored ZIP archive. XLSX files are already ZIP
 * compressed internally, so storing them avoids spending extra CPU with no
 * meaningful size reduction during a large report export.
 */
function createStoredZip(files: DownloadableFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = zipDate(new Date());
  const prepared = files.map((file) => {
    const filename = file.filename.replace(/[\\/:*?"<>|]+/g, "-");
    const name = encoder.encode(filename);
    return { ...file, filename, name, crc: crc32(file.bytes) };
  });
  const localSize = prepared.reduce((total, f) => total + 30 + f.name.length + f.bytes.length, 0);
  const centralSize = prepared.reduce((total, f) => total + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  const writeLocal = (f: (typeof prepared)[number]) => {
    view.setUint32(offset, 0x04034b50, true); offset += 4;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 0x0800, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, now.time, true); offset += 2;
    view.setUint16(offset, now.date, true); offset += 2;
    view.setUint32(offset, f.crc, true); offset += 4;
    view.setUint32(offset, f.bytes.length, true); offset += 4;
    view.setUint32(offset, f.bytes.length, true); offset += 4;
    view.setUint16(offset, f.name.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    out.set(f.name, offset); offset += f.name.length;
    out.set(f.bytes, offset); offset += f.bytes.length;
  };
  prepared.forEach(writeLocal);
  const centralOffset = offset;
  let localOffset = 0;
  for (const f of prepared) {
    view.setUint32(offset, 0x02014b50, true); offset += 4;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 20, true); offset += 2;
    view.setUint16(offset, 0x0800, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, now.time, true); offset += 2;
    view.setUint16(offset, now.date, true); offset += 2;
    view.setUint32(offset, f.crc, true); offset += 4;
    view.setUint32(offset, f.bytes.length, true); offset += 4;
    view.setUint32(offset, f.bytes.length, true); offset += 4;
    view.setUint16(offset, f.name.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, localOffset, true); offset += 4;
    out.set(f.name, offset); offset += f.name.length;
    localOffset += 30 + f.name.length + f.bytes.length;
  }
  view.setUint32(offset, 0x06054b50, true); offset += 4;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, prepared.length, true); offset += 2;
  view.setUint16(offset, prepared.length, true); offset += 2;
  view.setUint32(offset, centralSize, true); offset += 4;
  view.setUint32(offset, centralOffset, true); offset += 4;
  view.setUint16(offset, 0, true);
  return out;
}

export function createZipFile(filename: string, files: DownloadableFile[]): DownloadableFile {
  if (files.length === 0) throw new Error("No Excel files are available to export.");
  return { filename, bytes: createStoredZip(files) };
}

export function downloadZip(filename: string, files: DownloadableFile[]) {
  const file = createZipFile(filename, files);
  downloadBlob(new Blob([ownedArrayBuffer(file.bytes)], { type: "application/zip" }), file.filename);
  trackReportGenerated(file.filename, "zip");
}

// Export rows to a clean, professionally formatted single-sheet .xlsx: bold
// header band, frozen header row, auto-filter, auto-sized columns, right-aligned
// number columns, and a bold totals row summing the flagged numeric columns.
export async function exportToXlsx(
  filename: string,
  columns: XlsxColumn[],
  rows: any[],
  options: { sheetName?: string; summaryRows?: XlsxSummaryRow[] } = {},
) {
  const file = await createXlsxFile(filename, columns, rows, options);
  downloadBlob(new Blob([ownedArrayBuffer(file.bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), file.filename);
  trackReportGenerated(file.filename, "xlsx");
}

// Export a workbook with one styled worksheet per supplied sheet definition
// (e.g. one sheet per activity). Every sheet gets the same formatting + borders.
// Pass `combined` to append a block-grid "Combined" sheet with InHouse blocks
// side-by-side on top and OutVendor blocks side-by-side below.
// Pass `buildFirst` to write custom-built sheets (e.g. summary sheets) at the
// FRONT of the workbook, before the styled per-bucket sheets.
export async function exportToXlsxSheets(
  filename: string,
  sheets: XlsxSheet[],
  combined?: { inHouse: XlsxBlockGroup[]; outVendor: XlsxBlockGroup[] },
  buildFirst?: (wb: any) => void,
) {
  const file = await createXlsxSheetsFile(filename, sheets, combined, buildFirst);
  downloadBlob(new Blob([ownedArrayBuffer(file.bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), file.filename);
  trackReportGenerated(file.filename, "xlsx");
}

// A block of side-by-side columns sharing one merged title (e.g. one load
// column rendered as Project | Wt (t) | Priority). `numeric`/`decimals` control
// per-sub-column formatting; `totals` is an optional bold footer row aligned to
// the headers.
export type XlsxGridBlock = {
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
  numeric?: boolean[];
  decimals?: number;
  totals?: (string | number | null)[];
};

// A worksheet built from block-grids. A simple sheet holds one grid (`blocks`);
// a stacked sheet holds several grids vertically (`sections`), each preceded by
// a banner row. An optional `note` renders as an italic line at the very top.
export type XlsxGridSheet = {
  name: string;
  blocks?: XlsxGridBlock[];
  sections?: { banner: string; blocks: XlsxGridBlock[] }[];
  note?: string;
};

// Export a workbook where each grid lays blocks side by side: a merged title
// row, a sub-header row, data rows aligned across blocks, and an optional bold
// totals row. Every block is boxed with a medium outer border and separated by
// a narrow blank column, with compact auto-sized columns. Sheets with
// `sections` stack multiple grids vertically with banner rows between them.
export async function createXlsxBlockGridFile(
  filename: string,
  sheets: XlsxGridSheet[],
): Promise<DownloadableFile> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();

  const thin = { style: "thin" as const, color: { argb: "FFB0B7C3" } };
  const medium = { style: "medium" as const, color: { argb: "FF111827" } };

  // Render one block-grid starting at `baseRow`; returns the last row used.
  const renderGrid = (
    ws: ExcelJS.Worksheet,
    blocks: XlsxGridBlock[],
    baseRow: number,
  ): number => {
    // Lay blocks left to right, leaving one blank spacer column between them.
    let col = 1;
    const layout = blocks.map((b) => {
      const start = col;
      const width = b.headers.length;
      col += width + 1; // +1 spacer
      return { b, start, width };
    });

    const maxLen = blocks.reduce((m, b) => Math.max(m, b.rows.length), 0);
    const TITLE = baseRow;
    const HEADER = baseRow + 1;
    const DATA_START = baseRow + 2;
    const dataEnd = DATA_START + maxLen - 1; // < DATA_START when there are no rows
    const hasTotals = blocks.some((b) => b.totals && b.totals.length);
    const totalRowNum = hasTotals ? Math.max(dataEnd, HEADER) + 1 : -1;

    // Compact per-column widths from header + data text (clamped 8..22); spacer
    // columns stay narrow. Stacked grids share columns — keep the widest need.
    const spacerCols = new Set<number>();
    for (let i = 0; i < layout.length - 1; i++) {
      spacerCols.add(layout[i].start + layout[i].width);
    }
    for (let c = 1; c < col; c++) {
      if (spacerCols.has(c)) {
        ws.getColumn(c).width = 2.5;
      }
    }
    for (const { b, start, width } of layout) {
      const decimals = b.decimals ?? 2;
      for (let j = 0; j < width; j++) {
        const isNum = b.numeric?.[j] ?? false;
        let maxText = b.headers[j].length;
        for (const r of b.rows) {
          const v = r[j];
          if (v == null || v === "") continue;
          const text = isNum
            ? (toNum(v) ?? "").toLocaleString(undefined, {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
              })
            : String(v);
          if (text.length > maxText) maxText = text.length;
        }
        const column = ws.getColumn(start + j);
        column.width = Math.max(
          column.width ?? 0,
          Math.min(22, Math.max(8, maxText + 2)),
        );
      }
    }

    for (const { b, start, width } of layout) {
      const decimals = b.decimals ?? 2;
      const end = start + width - 1;

      // Merged title across the block's columns.
      if (width > 1) ws.mergeCells(TITLE, start, TITLE, end);
      const titleCell = ws.getCell(TITLE, start);
      titleCell.value = b.title;
      titleCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      titleCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F2937" },
      };
      titleCell.alignment = { horizontal: "center", vertical: "middle" };

      // Sub-headers.
      for (let j = 0; j < width; j++) {
        const cell = ws.getCell(HEADER, start + j);
        cell.value = b.headers[j];
        cell.font = { bold: true };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF3F4F6" },
        };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // Data rows.
      for (let i = 0; i < maxLen; i++) {
        const r = b.rows[i] ?? [];
        for (let j = 0; j < width; j++) {
          const cell = ws.getCell(DATA_START + i, start + j);
          const isNum = b.numeric?.[j] ?? false;
          const v = r[j];
          if (isNum) {
            const n = toNum(v);
            cell.value = n;
            cell.numFmt = numFmt(decimals);
            cell.alignment = { horizontal: "right" };
          } else {
            cell.value = v == null ? "" : v;
            cell.alignment = { horizontal: "left" };
          }
        }
      }

      // Totals row.
      if (hasTotals && b.totals) {
        for (let j = 0; j < width; j++) {
          const cell = ws.getCell(totalRowNum, start + j);
          const isNum = b.numeric?.[j] ?? false;
          const v = b.totals[j];
          if (isNum) {
            cell.value = toNum(v);
            cell.numFmt = numFmt(decimals);
            cell.alignment = { horizontal: "right" };
          } else {
            cell.value = v == null ? "" : v;
            cell.alignment = { horizontal: "left" };
          }
          cell.font = { bold: true };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFEFF6FF" },
          };
        }
      }

      // Box the block: thin grid inside, medium border on the outer edge, with a
      // medium rule under the header and above the totals row.
      const rowEnd = hasTotals ? totalRowNum : Math.max(dataEnd, HEADER);
      for (let r = TITLE; r <= rowEnd; r++) {
        for (let c = start; c <= end; c++) {
          const cell = ws.getCell(r, c);
          cell.border = {
            top:
              r === TITLE || r === totalRowNum
                ? medium
                : thin,
            bottom: r === rowEnd || r === HEADER ? medium : thin,
            left: c === start ? medium : thin,
            right: c === end ? medium : thin,
          };
        }
      }
    }

    ws.getRow(TITLE).height = 20;
    ws.getRow(HEADER).height = 18;
    return hasTotals ? totalRowNum : Math.max(dataEnd, HEADER);
  };

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(uniqueSheetName(sheet.name, used));
    let row = 1;

    if (sheet.note) {
      const cell = ws.getCell(row, 1);
      cell.value = sheet.note;
      cell.font = { italic: true, color: { argb: "FF6B7280" } };
      cell.alignment = { horizontal: "left", vertical: "middle" };
      row += 2; // note + blank spacer row
    }

    if (sheet.sections && sheet.sections.length > 0) {
      for (const section of sheet.sections) {
        const banner = ws.getCell(row, 1);
        banner.value = section.banner;
        banner.font = { bold: true, size: 12 };
        banner.alignment = { horizontal: "left", vertical: "middle" };
        ws.getRow(row).height = 18;
        row += 1;
        const last = renderGrid(ws, section.blocks, row);
        row = last + 2; // grid + blank spacer row
      }
    } else {
      renderGrid(ws, sheet.blocks ?? [], row);
    }
  }

  return { filename, bytes: await workbookBytes(wb) };
}

// Browser-download wrapper for the block-grid renderer. Keeping this thin means
// page downloads and archive entries share the identical workbook construction.
export async function exportToXlsxBlockGrid(
  filename: string,
  sheets: XlsxGridSheet[],
) {
  const file = await createXlsxBlockGridFile(filename, sheets);
  downloadBlob(new Blob([ownedArrayBuffer(file.bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), file.filename);
  trackReportGenerated(file.filename, "xlsx");
}

// Render the AI report result into a downloadable PDF. Plain text layout with
// wrapping and automatic page breaks (no styling dependencies).
export async function exportAiReportPdf(filename: string, result: any) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensure = (h: number) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeText = (text: string, size: number, bold: boolean, gap = 4) => {
    if (!text) return;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, maxW) as string[];
    const lineH = size * 1.35;
    for (const line of lines) {
      ensure(lineH);
      doc.text(line, margin, y);
      y += lineH;
    }
    y += gap;
  };

  writeText("AI Report", 20, true, 8);
  const meta: string[] = [];
  if (result.model) meta.push(`Model: ${result.model}`);
  if (result.generatedAt) meta.push(`Generated: ${new Date(result.generatedAt).toLocaleString()}`);
  if (result.filtered) meta.push("Filtered slice (current filters applied)");
  if (meta.length) writeText(meta.join("   |   "), 9, false, 10);

  if (result.summary) {
    writeText(`Summary  (Health: ${String(result.summary.health).toUpperCase()})`, 14, true);
    if (result.summary.headline) writeText(result.summary.headline, 11, false, 8);
    for (const r of result.summary.topRisks ?? []) {
      writeText(`- ${r.title}  [${r.severity}]`, 11, true, 2);
      if (r.metric) writeText(r.metric, 10, false, 1);
      if (r.why) writeText(r.why, 10, false, 6);
    }
  }

  if (result.actionPlan?.length) {
    writeText("Action Plan", 14, true);
    for (const a of result.actionPlan) {
      writeText(`${a.priority}. ${a.action}  (${a.horizon} / effort ${a.effort})`, 11, true, 2);
      if (a.target) writeText(`Target: ${a.target}`, 10, false, 1);
      if (a.rationale) writeText(a.rationale, 10, false, 1);
      if (a.expectedImpact) writeText(`Expected impact: ${a.expectedImpact}`, 10, false, 6);
    }
  }

  if (result.detailed) {
    writeText("Detailed Analysis", 14, true);
    for (const b of result.detailed.bottlenecks ?? []) {
      writeText(`- [${b.area}] ${b.name}  ${b.metric ?? ""}`, 11, true, 1);
      if (b.finding) writeText(b.finding, 10, false, 6);
    }
    const blocks: [string, string | undefined][] = [
      ["Ageing", result.detailed.ageingAnalysis],
      ["Contractor", result.detailed.contractorAnalysis],
      ["Throughput", result.detailed.throughput],
    ];
    for (const [title, body] of blocks) {
      if (body) {
        writeText(title, 12, true, 2);
        writeText(body, 10, false, 6);
      }
    }
    if (result.detailed.dataQuality?.length) {
      writeText("Data quality", 12, true, 2);
      for (const d of result.detailed.dataQuality) writeText(`- ${d}`, 10, false, 1);
      y += 4;
    }
    if (result.detailed.assumptions?.length) {
      writeText("Assumptions", 12, true, 2);
      for (const d of result.detailed.assumptions) writeText(`- ${d}`, 10, false, 1);
    }
  }

  doc.save(filename);
  trackReportGenerated(filename, "pdf");
}

// ─── Generated Order Review xlsx ──────────────────────────────────────────────
// Writes a 2-row banner header matching the OR file's Progress / Balance layout.
// Row 1: fixed-col banners (merged into row 2) + "PROGRESS" + "BALANCE" spans.
// Row 2: stage-level sub-headers.
// Data rows 3+: one row per structure; OR figures in adjacent columns (not
// sub-lines) so every cell is individually addressable in Excel.
//
// Column layout (26 cols, A–Z):
//   Fixed (A-J, rows 1-2 merged): Project | Structure | Sub Type | MFC Batch |
//     Marks | Wt/Set (MT) | Order Qty Sets | Order Qty Wt (MT) |
//     WO Order Qty (MT) | BOM Label
//   PROGRESS (K-R, row-2 sub-header): 4 stages × (Gen | OR) = 8 cols
//   BALANCE  (S-Z, row-2 sub-header): WO (MT) + 3 stages × (Gen | OR) + FG Gen = 8 cols

export type GenOrExportRow = {
  project: string; structure: string; subType: string | null;
  mfcBatch: string; marks: number;
  weightPerSet: number | null; orSets: number | null; orWeightMt: number | null;
  woOrderQtyMt: number | null; bomLabel: string; orBomType: string | null; orBomNote: string;
  // Progress
  genProgRelease: number; orProgRelease: number | null;
  genProgFab:     number; orProgFab:     number | null;
  genProgGalv:    number; orProgGalv:    number | null;
  genProgFg:      number; orProgFg:      number | null;
  // Balance
  // OR file Balance Work Order (col R) — remaining WO qty. No gen-side figure
  // (Despatch was removed from this view), so null renders blank, never zero.
  orBalWo: number | null;
  genBalRelease: number; orBalRelease: number | null;
  genBalFab:     number; orBalFab:     number | null;
  genBalGalv:    number; orBalGalv:    number | null;
  fgWt:          number;
};

export async function exportGenOrXlsx(filename: string, rows: GenOrExportRow[]) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet("Generated OR", { views: [{ state: "frozen", ySplit: 2 }] });

  // ── Column widths (26 cols) ────────────────────────────────────────────────
  const COL_WIDTHS = [
    10, 14, 10, 7, 7,     // A-E: Project, Structure, Sub Type, MFC, Marks
    9,  8,  12, 12, 12,   // F-J: Wt/Set, OR Qty Sets, OR Qty Wt, WO Qty, BOM Label
    // Progress: 4 stages × 2 (Gen, OR)
    11, 11, 11, 11, 11, 11, 11, 11,
    // Balance: WO + 4 stages (3 × 2 + 1)
    12, 11, 11, 11, 11, 11, 11, 11,
  ];
  ws.columns = COL_WIDTHS.map((w, i) => ({ width: w, key: String.fromCharCode(65 + i) }));

  // ── Style helpers ──────────────────────────────────────────────────────────
  const darkBg  = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F2937" } };
  const progBg  = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1E3A5F" } };  // deep blue
  const balBg   = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1A3A2A" } };  // deep green
  const subHdrBg = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF3F4F6" } };
  const white   = { argb: "FFFFFFFF" };
  const thin    = { style: "thin"   as const, color: { argb: "FFD1D5DB" } };
  const medium  = { style: "medium" as const, color: { argb: "FF374151" } };
  const heavy   = { style: "medium" as const, color: { argb: "FF111827" } };

  const styleCell = (cell: any, opts: {
    fill?: any; font?: any; align?: "left" | "right" | "center";
    border?: "thin" | "medium" | "heavy";
  }) => {
    if (opts.fill)  cell.fill  = opts.fill;
    if (opts.font)  cell.font  = opts.font;
    if (opts.align) cell.alignment = { horizontal: opts.align, vertical: "middle", wrapText: false };
    if (opts.border) {
      const b = opts.border === "thin" ? thin : opts.border === "medium" ? medium : heavy;
      cell.border = { top: b, bottom: b, left: b, right: b };
    }
  };

  const n3 = (v: number | null | undefined): number | null =>
    v == null ? null : Math.round(v * 1000) / 1000;

  // ── Row 1: banner headers ─────────────────────────────────────────────────
  const r1 = ws.getRow(1);
  r1.height = 22;

  // Fixed-column labels (will be merged into row 2)
  const fixedLabels = [
    "Project", "Structure", "Sub Type", "MFC Batch", "Marks",
    "Wt/Set (MT)", "Order Qty\nSets", "Order Qty\nWt (MT)", "WO Order Qty\n(MT)", "BOM Label",
  ];
  fixedLabels.forEach((label, i) => {
    const col = i + 1;
    ws.mergeCells(1, col, 2, col);
    const cell = ws.getCell(1, col);
    cell.value = label;
    styleCell(cell, { fill: darkBg, font: { bold: true, color: white, size: 9 }, align: "center", border: "heavy" });
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  // PROGRESS banner K1:R1 (columns 11–18)
  ws.mergeCells(1, 11, 1, 18);
  const progCell = ws.getCell(1, 11);
  progCell.value = "PROGRESS";
  styleCell(progCell, { fill: progBg, font: { bold: true, color: white, size: 11 }, align: "center", border: "heavy" });

  // BALANCE banner S1:Z1 (columns 19–26)
  ws.mergeCells(1, 19, 1, 26);
  const balCell = ws.getCell(1, 19);
  balCell.value = "BALANCE";
  styleCell(balCell, { fill: balBg, font: { bold: true, color: white, size: 11 }, align: "center", border: "heavy" });

  // ── Row 2: stage sub-headers ───────────────────────────────────────────────
  const r2 = ws.getRow(2);
  r2.height = 28;
  const stageSubHdrs: [number, string][] = [
    // Progress (cols 11-18): 4 stages × Gen + OR
    [11, "Release\nGen (MT)"],  [12, "Release\nOR (MT)"],
    [13, "Fabrication\nGen (MT)"], [14, "Fabrication\nOR (MT)"],
    [15, "Galvanising\nGen (MT)"], [16, "Galvanising\nOR (MT)"],
    [17, "Fin. Goods\nGen (MT)"], [18, "Fin. Goods\nOR (MT)"],
    // Balance (cols 19-26): WO + 3 stages × Gen+OR + FG Gen
    [19, "Work Order\n(MT)"],
    [20, "Release\nGen (MT)"], [21, "Release\nOR (MT)"],
    [22, "Fabrication\nGen (MT)"], [23, "Fabrication\nOR (MT)"],
    [24, "Galvanising\nGen (MT)"], [25, "Galvanising\nOR (MT)"],
    [26, "Fin. Goods\nGen (MT)"],
  ];
  stageSubHdrs.forEach(([col, label]) => {
    const cell = ws.getCell(2, col);
    cell.value = label;
    styleCell(cell, { fill: subHdrBg, font: { bold: true, size: 8 }, align: "center" });
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { top: medium, bottom: medium, left: thin, right: thin };
  });

  // ── Data rows (starting at row 3) ─────────────────────────────────────────
  const numFmt3 = "#,##0.000";
  const numFmt0 = "#,##0";

  for (const r of rows) {
    const exRow = ws.addRow([]);
    const rn = exRow.number;

    const setCell = (col: number, val: any, fmt?: string, align: "left"|"right" = "right") => {
      const cell = ws.getCell(rn, col);
      cell.value = val;
      if (fmt) cell.numFmt = fmt;
      cell.alignment = { horizontal: align, vertical: "middle" };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
    };

    // Fixed cols
    setCell(1,  r.project,                    undefined, "left");
    setCell(2,  r.structure,                  undefined, "left");
    setCell(3,  r.subType ?? "",              undefined, "left");
    setCell(4,  r.mfcBatch,                  undefined, "left");
    setCell(5,  r.marks,                      numFmt0);
    setCell(6,  n3(r.weightPerSet),           numFmt3);
    setCell(7,  r.orSets,                     numFmt0);
    setCell(8,  n3(r.orWeightMt),             numFmt3);
    setCell(9,  n3(r.woOrderQtyMt),           numFmt3);
    setCell(10, r.bomLabel + (r.orBomNote ? `\n${r.orBomNote}` : ""), undefined, "left");

    // Progress cols (11-18)
    setCell(11, n3(r.genProgRelease),  numFmt3);
    setCell(12, n3(r.orProgRelease),   numFmt3);
    setCell(13, n3(r.genProgFab),      numFmt3);
    setCell(14, n3(r.orProgFab),       numFmt3);
    setCell(15, n3(r.genProgGalv),     numFmt3);
    setCell(16, n3(r.orProgGalv),      numFmt3);
    setCell(17, n3(r.genProgFg),       numFmt3);
    setCell(18, n3(r.orProgFg),        numFmt3);

    // Balance cols (19-26)
    // Balance Work Order = OR file col R (remaining WO qty), NOT WO Order Qty.
    // Null (no OR row / pre-upgrade ingest) renders blank, never zero.
    setCell(19, n3(r.orBalWo),         numFmt3);
    setCell(20, n3(r.genBalRelease),   numFmt3);
    setCell(21, n3(r.orBalRelease),    numFmt3);
    setCell(22, n3(r.genBalFab),       numFmt3);
    setCell(23, n3(r.orBalFab),        numFmt3);
    setCell(24, n3(r.genBalGalv),      numFmt3);
    setCell(25, n3(r.orBalGalv),       numFmt3);
    setCell(26, n3(r.fgWt),            numFmt3);
  }

  // ── TOTAL row ──────────────────────────────────────────────────────────────
  if (rows.length > 0) {
    const tot = ws.addRow([]);
    const tn = tot.number;
    const tCell = (col: number, val: any, fmt?: string) => {
      const cell = ws.getCell(tn, col);
      cell.value = val;
      if (fmt) cell.numFmt = fmt;
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
      cell.border = { top: medium, bottom: medium, left: thin, right: thin };
      cell.alignment = { horizontal: col <= 5 ? "left" as const : "right" as const, vertical: "middle" };
    };
    const sum = (f: keyof GenOrExportRow) =>
      rows.reduce((s, r) => s + ((r[f] as number) ?? 0), 0);
    const sumNull = (f: keyof GenOrExportRow) => {
      const vals = rows.filter((r) => r[f] != null);
      return vals.length ? vals.reduce((s, r) => s + ((r[f] as number) ?? 0), 0) : null;
    };

    tCell(1, "TOTAL");
    [2,3,4,5,6,7,8,9,10].forEach((c) => ws.getCell(tn, c).border = { top: medium, bottom: medium, left: thin, right: thin });
    tCell(11, n3(sum("genProgRelease")), numFmt3);
    tCell(12, n3(sumNull("orProgRelease")), numFmt3);
    tCell(13, n3(sum("genProgFab")), numFmt3);
    tCell(14, n3(sumNull("orProgFab")), numFmt3);
    tCell(15, n3(sum("genProgGalv")), numFmt3);
    tCell(16, n3(sumNull("orProgGalv")), numFmt3);
    tCell(17, n3(sum("genProgFg")), numFmt3);
    tCell(18, n3(sumNull("orProgFg")), numFmt3);
    tCell(19, n3(sumNull("orBalWo")), numFmt3);
    tCell(20, n3(sum("genBalRelease")), numFmt3);
    tCell(21, n3(sumNull("orBalRelease")), numFmt3);
    tCell(22, n3(sum("genBalFab")), numFmt3);
    tCell(23, n3(sumNull("orBalFab")), numFmt3);
    tCell(24, n3(sum("genBalGalv")), numFmt3);
    tCell(25, n3(sumNull("orBalGalv")), numFmt3);
    tCell(26, n3(sum("fgWt")), numFmt3);
  }

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 26 } };
  await downloadWorkbook(wb, filename);
}

export function exportToJson(filename: string, data: any) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  trackReportGenerated(filename, "json");
}
