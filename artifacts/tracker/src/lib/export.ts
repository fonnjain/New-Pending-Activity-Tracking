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
