// Export a raw 2-D grid (array of rows of cells) to CSV. Use this when the
// layout is a matrix (repeated/side-by-side column blocks) that can't be
// expressed as uniform objects with unique keys.
export function exportToCsvRaw(filename: string, aoa: (string | number)[][]) {
  const csvContent = aoa
    .map((row) =>
      row
        .map((val) => {
          if (val === null || val === undefined) return "";
          if (typeof val === "string") return `"${val.replace(/"/g, '""')}"`;
          return val;
        })
        .join(","),
    )
    .join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
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

export function exportToCsv(filename: string, rows: any[]) {
  if (!rows || !rows.length) return;

  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(","),
    ...rows.map(row => 
      headers.map(header => {
        const val = row[header];
        if (val === null || val === undefined) return "";
        if (typeof val === "string") return `"${val.replace(/"/g, '""')}"`;
        if (Array.isArray(val)) return `"${val.join(";")}"`;
        return val;
      }).join(",")
    )
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
};

function numFmt(decimals: number): string {
  return decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
}

// A single worksheet definition for a multi-sheet export.
export type XlsxSheet = {
  name: string;
  columns: XlsxColumn[];
  rows: any[];
  summaryRows?: XlsxSummaryRow[];
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

// Write one fully-styled worksheet (header band, auto-sized columns, optional
// summary rows, totals row, and grid borders around every cell).
function writeSheet(wb: any, sheet: XlsxSheet, usedNames: Set<string>) {
  const { columns, rows, summaryRows = [] } = sheet;
  const ws = wb.addWorksheet(uniqueSheetName(sheet.name, usedNames), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Columns: header label, number format + right alignment for numeric columns,
  // and an auto-computed width from the widest value (clamped 10..48).
  ws.columns = columns.map((c) => {
    const decimals = c.decimals ?? (c.numeric ? 2 : 0);
    let maxLen = c.label.length;
    for (const r of rows) {
      const v = r[c.field];
      if (v == null) continue;
      let text: string;
      if (c.numeric) {
        const n = toNum(v);
        text =
          n == null
            ? ""
            : n.toLocaleString(undefined, {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
              });
      } else {
        text = String(v);
      }
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

  // Data rows. Numeric cells are written as real (finite) numbers or left blank
  // so Excel treats them as numbers; text cells fall back to "".
  for (const r of rows) {
    const rowObj: Record<string, any> = {};
    for (const c of columns) {
      const v = r[c.field];
      rowObj[c.field] = c.numeric ? toNum(v) : v == null ? "" : v;
    }
    ws.addRow(rowObj);
  }

  // Optional summary rows (e.g. per-activity subtotals) inserted between the data
  // and the grand-total row. Bold with a light fill to set them apart; a row
  // with no values renders as a section heading.
  for (const s of summaryRows) {
    const obj: Record<string, any> = {};
    columns.forEach((c, i) => {
      if (i === 0) obj[c.field] = s.label;
      else if (c.field in s.values) obj[c.field] = s.values[c.field];
    });
    const row = ws.addRow(obj);
    for (let c = 1; c <= columns.length; c++) {
      const cell = row.getCell(c);
      cell.font = { bold: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
      };
    }
  }

  // Header band: bold white text on a dark fill, centered, with a thin border.
  const headerRow = ws.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell((cell: any) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F2937" },
    };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  // Totals row: label in the first column, SUM for each flagged numeric column.
  const hasTotals = columns.some((c) => c.total);
  if (hasTotals && rows.length) {
    const totalObj: Record<string, any> = {};
    columns.forEach((c, i) => {
      if (i === 0) {
        totalObj[c.field] = "TOTAL";
      } else if (c.total) {
        totalObj[c.field] = rows.reduce((s, r) => s + (toNum(r[c.field]) ?? 0), 0);
      }
    });
    const totalRow = ws.addRow(totalObj);
    totalRow.eachCell((cell: any) => {
      cell.font = { bold: true };
    });
  }

  // Grid borders: a thin line around every cell so the report reads as a table,
  // with a darker bottom under the header and a darker top above the totals row.
  const thin = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
  const headerBottom = { style: "thin" as const, color: { argb: "FF111827" } };
  const totalsTop = { style: "thin" as const, color: { argb: "FF9CA3AF" } };
  const totalsRowNum = hasTotals && rows.length ? ws.rowCount : -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= columns.length; c++) {
      row.getCell(c).border = {
        top: r === totalsRowNum ? totalsTop : thin,
        bottom: r === 1 ? headerBottom : thin,
        left: thin,
        right: thin,
      };
    }
  }

  // Auto-filter over the header row (Excel extends the dropdowns down the data).
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  return ws;
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
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  writeSheet(wb, { name: sheetName, columns, rows, summaryRows }, new Set<string>());
  await downloadWorkbook(wb, filename);
}

// Export a workbook with one styled worksheet per supplied sheet definition
// (e.g. one sheet per activity). Every sheet gets the same formatting + borders.
export async function exportToXlsxSheets(filename: string, sheets: XlsxSheet[]) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();
  for (const sheet of sheets) writeSheet(wb, sheet, used);
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
