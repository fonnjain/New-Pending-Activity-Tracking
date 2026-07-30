// Static import so Vite bundles ExcelJS into the main chunk rather than a lazy
// chunk.  Dynamic `await import("exceljs")` was previously used here, which
// caused a "Failed to fetch dynamically imported module" error in production
// when the chunk hash changed between builds and the old deployment still served
// the old hash.
import ExcelJS from "exceljs";

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

// Stream a finished workbook to the browser as a .xlsx download.
async function downloadWorkbook(wb: any, filename: string) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
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

// Export rows to a clean, professionally formatted single-sheet .xlsx: bold
// header band, frozen header row, auto-filter, auto-sized columns, right-aligned
// number columns, and a bold totals row summing the flagged numeric columns.
export async function exportToXlsx(
  filename: string,
  columns: XlsxColumn[],
  rows: any[],
  options: { sheetName?: string; summaryRows?: XlsxSummaryRow[] } = {},
) {
  const { sheetName = "Report", summaryRows = [] } = options;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  writeSheet(wb, { name: sheetName, columns, rows, summaryRows }, new Set<string>());
  await downloadWorkbook(wb, filename);
}

// Export a workbook with one styled worksheet per supplied sheet definition
// (e.g. one sheet per activity). Every sheet gets the same formatting + borders.
// Pass `combined` to append a block-grid "Combined" sheet with InHouse blocks
// side-by-side on top and OutVendor blocks side-by-side below.
export async function exportToXlsxSheets(
  filename: string,
  sheets: XlsxSheet[],
  combined?: { inHouse: XlsxBlockGroup[]; outVendor: XlsxBlockGroup[] },
) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();
  if (combined) writeCombinedBlockSheet(wb, combined.inHouse, combined.outVendor, used);
  for (const sheet of sheets) writeSheet(wb, sheet, used);
  await downloadWorkbook(wb, filename);
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

// A worksheet built from block-grids: each block is a bordered set of columns,
// separated from the next by one blank spacer column.
export type XlsxGridSheet = {
  name: string;
  blocks: XlsxGridBlock[];
};

// Export a workbook where each sheet lays blocks side by side: a merged title
// row, a sub-header row, data rows aligned across blocks, and an optional bold
// totals row. Every block is boxed with a medium outer border and separated by
// a narrow blank column, with compact auto-sized columns.
export async function exportToXlsxBlockGrid(
  filename: string,
  sheets: XlsxGridSheet[],
) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();

  const thin = { style: "thin" as const, color: { argb: "FFB0B7C3" } };
  const medium = { style: "medium" as const, color: { argb: "FF111827" } };

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(uniqueSheetName(sheet.name, used));

    // Lay blocks left to right, leaving one blank spacer column between them.
    let col = 1;
    const layout = sheet.blocks.map((b) => {
      const start = col;
      const width = b.headers.length;
      col += width + 1; // +1 spacer
      return { b, start, width };
    });

    const maxLen = sheet.blocks.reduce((m, b) => Math.max(m, b.rows.length), 0);
    const TITLE = 1;
    const HEADER = 2;
    const DATA_START = 3;
    const dataEnd = DATA_START + maxLen - 1; // < DATA_START when there are no rows
    const hasTotals = sheet.blocks.some((b) => b.totals && b.totals.length);
    const totalRowNum = hasTotals ? Math.max(dataEnd, HEADER) + 1 : -1;

    // Compact per-column widths from header + data text (clamped 8..22); spacer
    // columns stay narrow.
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
        ws.getColumn(start + j).width = Math.min(22, Math.max(8, maxText + 2));
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
  }

  await downloadWorkbook(wb, filename);
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
}
