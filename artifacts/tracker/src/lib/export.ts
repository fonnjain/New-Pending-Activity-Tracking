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

// Export a set of rows to a real .xlsx file. `columns` is a list of
// [header label, record field] tuples controlling order and what is written.
export async function exportToXlsx(
  filename: string,
  columns: [string, string][],
  rows: any[],
  sheetName = "Report",
) {
  const XLSX = await import("xlsx");
  const header = columns.map(([label]) => label);
  const aoa: any[][] = [header];
  for (const r of rows) {
    aoa.push(
      columns.map(([, field]) => {
        const v = r[field];
        return v == null ? "" : v;
      }),
    );
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
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
