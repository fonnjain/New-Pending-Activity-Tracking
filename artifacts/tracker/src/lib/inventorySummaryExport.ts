// Builds the two summary sheets ("Summary", "Summary - 2") that open the
// Inventory Bucket List "Export All" workbook. Both sheets are derived from
// the SAME six XlsxSheet definitions used for the bucket worksheets, so their
// figures match the bucket sheets by construction. Pre-B is excluded from
// both summaries by design; the six bucket sheets themselves are untouched.
import type { XlsxColumn, XlsxSheet, XlsxSummaryRow } from "./export";

type BucketLetter = "A" | "B" | "C" | "D" | "E";

const BUCKET_ORDER: BucketLetter[] = ["A", "B", "C", "D", "E"];

const BUCKET_MEANING: Record<BucketLetter, string> = {
  A: "Project to start",
  B: "Raw material incomplete",
  C: "RM complete, under production",
  D: "Dispatch clearance received",
  E: "Ready, not dispatched",
};

// Shared palette keyed by bucket — title bands and membership shading.
const BUCKET_STYLE: Record<BucketLetter, { fill: string; text: string }> = {
  A: { fill: "FFD9E2F3", text: "FF2F5597" },
  B: { fill: "FFFCE4D6", text: "FFC55A11" },
  C: { fill: "FFE2EFDA", text: "FF548235" },
  D: { fill: "FFDDEBF7", text: "FF2E75B6" },
  E: { fill: "FFE4DFEC", text: "FF7030A0" },
};

const HEADING = "FF1F3864";
const MUTED = "FF595959";
const HEADER_FILL = "FFF2F2F2";
const THIN = { style: "thin" as const, color: { argb: "FFBFBFBF" } };
const MEDIUM = { style: "medium" as const, color: { argb: "FF1F3864" } };

const FMT_WT = "#,##0.000";
const FMT_CNT = "#,##0";

function toNum(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface BucketData {
  letter: BucketLetter;
  sheetName: string;
  columns: XlsxColumn[];
  rows: any[];
  summaryRows: XlsxSummaryRow[];
}

// Pull the five A–E bucket definitions out of the export's sheet list.
// Matching is by name prefix; "Pre-B - …" never matches "B - ".
function extractBuckets(sheets: XlsxSheet[]): Record<BucketLetter, BucketData> {
  const out = {} as Record<BucketLetter, BucketData>;
  for (const letter of BUCKET_ORDER) {
    const sheet = sheets.find((s) => s.name.startsWith(`${letter} - `));
    if (!sheet) throw new Error(`Summary export: bucket sheet "${letter} - …" not found`);
    const rows = sheet.sections
      ? sheet.sections.flatMap((s) => s.rows)
      : (sheet.rows ?? []);
    const summaryRows = sheet.sections
      ? sheet.sections.flatMap((s) => s.summaryRows ?? [])
      : (sheet.summaryRows ?? []);
    out[letter] = { letter, sheetName: sheet.name, columns: sheet.columns, rows, summaryRows };
  }
  return out;
}

// Pending-weight breakdown of one project-batch row, per bucket shape.
// Bucket A is measured as Order Qty (goes in `total` only); E stores a
// combined Fab+Galva figure which we surface under Fab.
function rowWeights(letter: BucketLetter, r: any): {
  rel: number | null; fab: number | null; galva: number | null; yard: number | null; total: number;
} {
  if (letter === "A") {
    return { rel: null, fab: null, galva: null, yard: null, total: toNum(r.orderQtyMt) ?? 0 };
  }
  if (letter === "E") {
    const rel = toNum(r.releaseBalanceMt) ?? 0;
    const fab = toNum(r.fabGalvaMt) ?? 0;
    const yard = toNum(r.yardMt) ?? 0;
    return { rel, fab, galva: 0, yard, total: rel + fab + yard };
  }
  const rel = toNum(r.release) ?? 0;
  const fab = toNum(r.fab) ?? 0;
  const galva = toNum(r.galva) ?? 0;
  const yard = toNum(r.yard) ?? 0;
  return { rel, fab, galva, yard, total: rel + fab + galva + yard };
}

function rowStructures(r: any): number {
  return toNum(r.structureCount ?? r.structures) ?? 0;
}

function rowKey(r: any): string {
  return `${r.project ?? ""}\u0001${r.mfcBatch ?? ""}`;
}

// Numeric project codes sort numerically first; VS-/VR-/RAILWAY etc. after.
function compareProjects(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.localeCompare(b);
}

function compareBatches(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "Z") return 1;
  if (b === "Z") return -1;
  return a.localeCompare(b);
}

function setFill(cell: any, argb: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(cell: any) {
  cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
}

// Draw a medium 1F3864 outline around a rectangular block, preserving the
// inner thin borders already applied to the cells.
function outlineBlock(ws: any, r1: number, c1: number, r2: number, c2: number) {
  for (let c = c1; c <= c2; c++) {
    const top = ws.getRow(r1).getCell(c);
    top.border = { ...(top.border ?? {}), top: MEDIUM };
    const bottom = ws.getRow(r2).getCell(c);
    bottom.border = { ...(bottom.border ?? {}), bottom: MEDIUM };
  }
  for (let r = r1; r <= r2; r++) {
    const left = ws.getRow(r).getCell(c1);
    left.border = { ...(left.border ?? {}), left: MEDIUM };
    const right = ws.getRow(r).getCell(c2);
    right.border = { ...(right.border ?? {}), right: MEDIUM };
  }
}

function titleRows(ws: any, title: string, subtitle: string) {
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 16, color: { argb: HEADING } };
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { size: 9, color: { argb: MUTED } };
}

// ─── Sheet 1 — "Summary" ───────────────────────────────────────────────────

function writeSummarySheet(
  wb: any,
  buckets: Record<BucketLetter, BucketData>,
  sourceFileName: string,
  asAtLabel: string,
) {
  const ws = wb.addWorksheet("Summary", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 16, showGridLines: false }],
  });
  const widths = [12, 11, 13.5, 7, 13.5, 7, 13.5, 7, 13.5, 7, 13.5, 7];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  titleRows(
    ws,
    "Bucket List — Summary",
    `All buckets side by side · source: ${sourceFileName} · as at ${asAtLabel}`,
  );

  // ── Block 1 — bucket overview ──
  const h4 = ws.getCell(4, 1);
  h4.value = "BUCKET OVERVIEW";
  h4.font = { bold: true, size: 11, color: { argb: HEADING } };

  const headerLabels = [
    "Bucket", "Meaning", null, "Rows", "Projects", "Structures",
    "Release Bal. (MT)", "Fab (MT)", "Galva (MT)", "Yard (MT)", "Total (MT)",
  ];
  headerLabels.forEach((label, i) => {
    const cell = ws.getCell(5, i + 1);
    if (label != null) cell.value = label;
    cell.font = { bold: true, size: 9, color: { argb: HEADING } };
    setFill(cell, HEADER_FILL);
    thinBorder(cell);
    if (i >= 3) cell.alignment = { horizontal: "right" };
  });
  ws.mergeCells(5, 2, 5, 3);

  // Membership sets for the overlap note.
  const keySets = {} as Record<BucketLetter, Set<string>>;
  for (const letter of BUCKET_ORDER) {
    keySets[letter] = new Set(buckets[letter].rows.map(rowKey));
  }

  let rowNum = 6;
  const bucketTotals: Record<BucketLetter, { mt: number; str: number }> = {
    A: { mt: 0, str: 0 }, B: { mt: 0, str: 0 }, C: { mt: 0, str: 0 },
    D: { mt: 0, str: 0 }, E: { mt: 0, str: 0 },
  };
  for (const letter of BUCKET_ORDER) {
    const b = buckets[letter];
    const projects = new Set(b.rows.map((r) => String(r.project ?? "")));
    let structures = 0;
    let rel = 0, fab = 0, galva = 0, yard = 0, total = 0;
    for (const r of b.rows) {
      structures += rowStructures(r);
      const w = rowWeights(letter, r);
      rel += w.rel ?? 0; fab += w.fab ?? 0; galva += w.galva ?? 0; yard += w.yard ?? 0;
      total += w.total;
    }
    bucketTotals[letter] = { mt: total, str: structures };

    const row = ws.getRow(rowNum);
    const style = BUCKET_STYLE[letter];
    const letterCell = row.getCell(1);
    letterCell.value = letter;
    letterCell.font = { bold: true, size: 9, color: { argb: style.text } };
    setFill(letterCell, style.fill);
    const meaning = row.getCell(2);
    meaning.value = BUCKET_MEANING[letter];
    meaning.font = { size: 9 };
    ws.mergeCells(rowNum, 2, rowNum, 3);
    const nums: (number | null)[] = [
      b.rows.length, projects.size, structures,
      letter === "A" ? null : rel,
      letter === "A" ? null : fab,
      letter === "A" ? null : galva,
      letter === "A" ? null : yard,
      total,
    ];
    nums.forEach((v, i) => {
      const cell = row.getCell(4 + i);
      if (v != null) cell.value = v;
      cell.numFmt = i < 3 ? FMT_CNT : FMT_WT;
      cell.alignment = { horizontal: "right" };
      cell.font = { size: 9, bold: i === 7 };
    });
    for (let c = 1; c <= 11; c++) thinBorder(row.getCell(c));
    rowNum++;
  }
  outlineBlock(ws, 5, 1, rowNum - 1, 11);

  // Overlap note — computed from actual membership, never hardcoded.
  const dInC = [...keySets.D].filter((k) => keySets.C.has(k)).length;
  const bAndC = [...keySets.B].filter((k) => keySets.C.has(k)).length;
  const dRows = buckets.D.rows.length;
  const dPhrase = dRows > 0 && dInC === dRows
    ? `all ${dRows} D rows also appear in C`
    : `${dInC} of ${dRows} D rows also appear in C`;
  const noteRow = rowNum + 1; // one blank row after the table
  ws.mergeCells(noteRow, 1, noteRow, 11);
  const note = ws.getCell(noteRow, 1);
  note.value =
    "Bucket A is measured as Order Qty; B, C, D and E as pending weight — the two are " +
    `different measures. Buckets overlap and must not be added together: ${dPhrase}, ` +
    `and ${bAndC} rows appear in both B and C.`;
  note.font = { italic: true, size: 9, color: { argb: MUTED } };
  note.alignment = { wrapText: true, vertical: "top" };
  ws.getRow(noteRow).height = 26;

  // ── Block 2 — by project and MFC batch ──
  const b2Title = noteRow + 2;
  const b2t = ws.getCell(b2Title, 1);
  b2t.value = "BY PROJECT AND MFC BATCH";
  b2t.font = { bold: true, size: 11, color: { argb: HEADING } };

  const hdr1 = b2Title + 1; // merged bucket group headers
  const hdr2 = b2Title + 2; // MT / Str. sub-headers

  ws.mergeCells(hdr1, 1, hdr2, 1);
  ws.mergeCells(hdr1, 2, hdr2, 2);
  const pj = ws.getCell(hdr1, 1);
  pj.value = "Project";
  const mb = ws.getCell(hdr1, 2);
  mb.value = "MFC Batch";
  for (const cell of [pj, mb]) {
    cell.font = { bold: true, size: 9, color: { argb: HEADING } };
    setFill(cell, HEADER_FILL);
    cell.alignment = { vertical: "middle" };
  }
  BUCKET_ORDER.forEach((letter, bi) => {
    const c1 = 3 + bi * 2;
    ws.mergeCells(hdr1, c1, hdr1, c1 + 1);
    const g = ws.getCell(hdr1, c1);
    g.value = `${letter} — ${BUCKET_MEANING[letter]}`;
    const style = BUCKET_STYLE[letter];
    g.font = { bold: true, size: 9, color: { argb: style.text } };
    setFill(g, style.fill);
    g.alignment = { horizontal: "center" };
    const mt = ws.getCell(hdr2, c1);
    mt.value = "MT";
    const str = ws.getCell(hdr2, c1 + 1);
    str.value = "Str.";
    for (const cell of [mt, str]) {
      cell.font = { bold: true, size: 8, color: { argb: HEADING } };
      setFill(cell, HEADER_FILL);
      cell.alignment = { horizontal: "right" };
    }
  });
  for (let r = hdr1; r <= hdr2; r++) {
    for (let c = 1; c <= 12; c++) thinBorder(ws.getRow(r).getCell(c));
  }

  // Union of (project, batch) keys with per-bucket aggregates. A row can
  // appear in several buckets — that overlap is intentional and shown as-is.
  const combos = new Map<
    string,
    { project: string; mfcBatch: string; per: Partial<Record<BucketLetter, { mt: number; str: number }>> }
  >();
  for (const letter of BUCKET_ORDER) {
    for (const r of buckets[letter].rows) {
      const key = rowKey(r);
      let entry = combos.get(key);
      if (!entry) {
        entry = { project: String(r.project ?? ""), mfcBatch: String(r.mfcBatch ?? ""), per: {} };
        combos.set(key, entry);
      }
      const agg = entry.per[letter] ?? { mt: 0, str: 0 };
      agg.mt += rowWeights(letter, r).total;
      agg.str += rowStructures(r);
      entry.per[letter] = agg;
    }
  }
  const comboRows = [...combos.values()].sort(
    (a, b) => compareProjects(a.project, b.project) || compareBatches(a.mfcBatch, b.mfcBatch),
  );

  let r = hdr2 + 1;
  for (const combo of comboRows) {
    const row = ws.getRow(r);
    row.getCell(1).value = combo.project;
    row.getCell(1).font = { size: 9 };
    row.getCell(2).value = combo.mfcBatch;
    row.getCell(2).font = { size: 9 };
    BUCKET_ORDER.forEach((letter, bi) => {
      const agg = combo.per[letter];
      const mtCell = row.getCell(3 + bi * 2);
      const strCell = row.getCell(4 + bi * 2);
      mtCell.numFmt = FMT_WT;
      strCell.numFmt = FMT_CNT;
      mtCell.alignment = { horizontal: "right" };
      strCell.alignment = { horizontal: "right" };
      mtCell.font = { size: 9 };
      strCell.font = { size: 9 };
      // Absent-in-bucket stays EMPTY (an absent row and a zero row differ);
      // filled cells get the bucket's shade so membership reads at a glance.
      if (agg) {
        mtCell.value = agg.mt;
        strCell.value = agg.str;
        setFill(mtCell, BUCKET_STYLE[letter].fill);
        setFill(strCell, BUCKET_STYLE[letter].fill);
      }
    });
    for (let c = 1; c <= 12; c++) thinBorder(row.getCell(c));
    r++;
  }

  // TOTAL row — per-bucket totals equal Block 1's Total (MT) by construction.
  const totalRow = ws.getRow(r);
  totalRow.getCell(1).value = "TOTAL";
  totalRow.getCell(1).font = { bold: true, size: 9, color: { argb: HEADING } };
  BUCKET_ORDER.forEach((letter, bi) => {
    const style = BUCKET_STYLE[letter];
    const mtCell = totalRow.getCell(3 + bi * 2);
    const strCell = totalRow.getCell(4 + bi * 2);
    mtCell.value = bucketTotals[letter].mt;
    mtCell.numFmt = FMT_WT;
    strCell.value = bucketTotals[letter].str;
    strCell.numFmt = FMT_CNT;
    for (const cell of [mtCell, strCell]) {
      cell.font = { bold: true, size: 9, color: { argb: style.text } };
      cell.alignment = { horizontal: "right" };
      setFill(cell, style.fill);
    }
  });
  for (let c = 1; c <= 12; c++) thinBorder(totalRow.getCell(c));
  outlineBlock(ws, hdr1, 1, r, 12);
}

// ─── Sheet 2 — "Summary - 2" ───────────────────────────────────────────────
// All five bucket sheets reproduced verbatim, laid out left to right with a
// narrow spacer column between blocks. Blocks are independent — their rows do
// NOT align across buckets; the aligned view is Sheet 1.

const SPACER_WIDTH = 2.5;

function columnWidth(label: string): number {
  const l = label.toLowerCase();
  if (l.includes("date")) return 15;
  if (l.startsWith("structure")) return 9.5;
  if (l.includes("(mt)") || ["rel. bal.", "fab", "galva", "yard"].includes(l)) return 12.5;
  return 11;
}

function writeSummary2Sheet(
  wb: any,
  buckets: Record<BucketLetter, BucketData>,
  sourceFileName: string,
  asAtLabel: string,
) {
  const ws = wb.addWorksheet("Summary - 2", {
    views: [{ state: "frozen", ySplit: 5, showGridLines: false }],
  });
  titleRows(
    ws,
    "Bucket List — All Sheets Side by Side",
    `Each bucket reproduced from its worksheet · blocks are independent and rows do not align across buckets · source: ${sourceFileName} · as at ${asAtLabel}`,
  );

  let startCol = 1;
  for (const letter of BUCKET_ORDER) {
    const b = buckets[letter];
    const nCols = b.columns.length;
    const style = BUCKET_STYLE[letter];

    b.columns.forEach((col, i) => {
      ws.getColumn(startCol + i).width = columnWidth(col.label);
    });

    // Title band.
    ws.mergeCells(4, startCol, 4, startCol + nCols - 1);
    const band = ws.getCell(4, startCol);
    band.value = `${letter} — ${BUCKET_MEANING[letter]}`;
    band.font = { bold: true, size: 10, color: { argb: style.text } };
    setFill(band, style.fill);

    // Source sheet's own header row, unchanged.
    b.columns.forEach((col, i) => {
      const cell = ws.getCell(5, startCol + i);
      cell.value = col.label;
      cell.font = { bold: true, size: 8, color: { argb: HEADING } };
      setFill(cell, HEADER_FILL);
      if (col.numeric) cell.alignment = { horizontal: "right" };
    });

    // Data rows in original order (bucket E may legitimately have none —
    // it still renders as a band + header row).
    let r = 6;
    for (const dataRow of b.rows) {
      b.columns.forEach((col, i) => {
        const cell = ws.getCell(r, startCol + i);
        const v = dataRow[col.field];
        if (col.numeric) {
          const n = toNum(v);
          if (n != null) cell.value = n;
          cell.numFmt = numFmtFor(col);
          cell.alignment = { horizontal: "right" };
        } else if (v != null && v !== "") {
          cell.value = v;
        }
        cell.font = { size: 9 };
        if (dataRow._bgColor) setFill(cell, String(dataRow._bgColor));
      });
      r++;
    }

    // Footer block: the sheet's own summary rows, then the generic TOTAL row —
    // shaded and bolded so it reads as a summary rather than as data.
    for (const s of b.summaryRows) {
      b.columns.forEach((col, i) => {
        const cell = ws.getCell(r, startCol + i);
        if (i === 0) cell.value = s.label;
        else if (col.field in s.values) {
          cell.value = s.values[col.field];
          cell.numFmt = numFmtFor(col);
          cell.alignment = { horizontal: "right" };
        }
        cell.font = { bold: true, size: 8, color: { argb: HEADING } };
        setFill(cell, HEADER_FILL);
      });
      r++;
    }
    if (b.columns.some((c) => c.total) && b.rows.length) {
      b.columns.forEach((col, i) => {
        const cell = ws.getCell(r, startCol + i);
        if (i === 0) cell.value = "TOTAL";
        else if (col.total) {
          cell.value = b.rows.reduce((sum, dr) => sum + (toNum(dr[col.field]) ?? 0), 0);
          cell.numFmt = numFmtFor(col);
          cell.alignment = { horizontal: "right" };
        }
        cell.font = { bold: true, size: 8, color: { argb: HEADING } };
        setFill(cell, HEADER_FILL);
      });
      r++;
    }

    // Borders: thin grid inside, medium outline on block edges.
    const lastRow = r - 1;
    for (let rr = 4; rr <= lastRow; rr++) {
      for (let cc = startCol; cc < startCol + nCols; cc++) {
        const cell = ws.getRow(rr).getCell(cc);
        const existing = cell.border ?? {};
        cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN, ...existing };
      }
    }
    outlineBlock(ws, 4, startCol, lastRow, startCol + nCols - 1);

    // Narrow spacer column before the next block.
    ws.getColumn(startCol + nCols).width = SPACER_WIDTH;
    startCol += nCols + 1;
  }
}

function numFmtFor(col: XlsxColumn): string {
  const decimals = col.decimals ?? (col.numeric ? 2 : 0);
  return decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : FMT_CNT;
}

// Entry point: called by exportToXlsxSheets' buildFirst hook so the two
// summary sheets land AHEAD of the six bucket sheets in the workbook.
export function writeInventorySummarySheets(
  wb: any,
  sheets: XlsxSheet[],
  sourceFileName: string,
  asAtLabel: string,
) {
  const buckets = extractBuckets(sheets);
  writeSummarySheet(wb, buckets, sourceFileName, asAtLabel);
  writeSummary2Sheet(wb, buckets, sourceFileName, asAtLabel);
}
