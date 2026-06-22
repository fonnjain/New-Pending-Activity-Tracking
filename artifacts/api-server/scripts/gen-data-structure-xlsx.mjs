import * as XLSX from "xlsx";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const wb = XLSX.utils.book_new();

function sheet(name, aoa, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (colWidths) ws["!cols"] = colWidths.map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// 1. Upload template — matches the exact parse layout (header on the 3rd row)
const headers = [
  "Project Code", "Order Nature", "Contractor", "Job Card No.", "Tower Type",
  "Tower Sub Type", "Alias", "Mark No.", "Section", "Length", "Width", "Wt/Pcs",
  "Balance Qty.", "Balance Wt.", "Assign Date", "Activity", "Operation",
  "Ref. Job Card No.",
];
sheet(
  "Upload Template",
  [
    ["Balance & Activity Report (sample template)"],
    ["Header is on row 3. Fill data from row 4 onward. Keep these column names exactly."],
    headers,
    ["794", "Supply", "ABC Fabricators", "JC-1001", "TypeA", "SubA", "T01", "794 T01-M1", "ISA 75x75x6", 1500, 75, 12.5, 10, 125.0, "2026-06-01", "Cutting", "Cutting,Fit-up,Welding,Painting", ""],
    ["", "Supply", "ABC Fabricators", "JC-1001", "TypeA", "SubA", "T01", "794 T01-M2", "ISA 75x75x6", 1500, 75, 12.5, 4, 50.0, "2026-06-01", "Fit-up", "Cutting,Fit-up,Welding,Painting", ""],
    ["920", "Rework", "XYZ Steel", "JC-2002", "TypeB", "SubB", "T05", "920 T05-M1", "ISMB 200", 2000, 100, 30.2, 6, 181.2, "2026-05-10", "Welding", "Cutting,Fit-up,Welding,Painting", "JC-1900"],
  ],
  [12, 12, 18, 14, 12, 14, 8, 16, 16, 8, 8, 8, 12, 12, 14, 12, 32, 16],
);

// 2. Input columns reference
sheet(
  "Input Columns",
  [
    ["Header text", "Meaning", "Type", "Required", "Notes"],
    ["Project Code", "Job / project number", "text/number", "see notes", "Forward-filled when blank; '920.0'->'920', '794.'->'794'"],
    ["Order Nature", "Order classification", "text", "optional", ""],
    ["Contractor", "Assigned contractor", "text", "optional", ""],
    ["Job Card No.", "Job card number", "text", "optional", ""],
    ["Tower Type", "Tower type", "text", "optional", ""],
    ["Tower Sub Type", "Tower sub type", "text", "optional", ""],
    ["Alias", "Structure alias", "text", "optional", "Used to derive structure and mark tail"],
    ["Mark No.", "Mark number", "text", "YES", "Rows without a Mark No. are skipped"],
    ["Section", "Section / profile", "text", "optional", ""],
    ["Length", "Length", "number", "optional", ""],
    ["Width", "Width", "number", "optional", ""],
    ["Wt/Pcs", "Weight per piece", "number", "optional", ""],
    ["Balance Qty.", "Pending quantity", "number", "defaults 0", ""],
    ["Balance Wt.", "Pending weight", "number", "defaults 0", ""],
    ["Assign Date", "Date work was assigned", "date", "optional", "Excel serial / date / text; normalized to YYYY-MM-DD; blank -> no date"],
    ["Activity", "Current activity / process step", "text", "optional", "Matched against Operation route for progress"],
    ["Operation", "Full comma-separated process route", "text", "optional", "Split on commas into route steps"],
    ["Ref. Job Card No.", "Reference job card number", "text", "optional", ""],
  ],
  [18, 34, 12, 12, 60],
);

// 3. Upload parameters
sheet(
  "Upload Parameters",
  [
    ["Field", "Type", "Required", "Description"],
    ["file", "binary (.xlsx)", "YES", "The report file"],
    ["label", "text", "optional", "A friendly name for this import"],
    ["reportDate", "text (date)", "optional", "The 'as of' date of the report"],
  ],
  [14, 16, 10, 50],
);

// 4. DB: imports table
sheet(
  "Table - imports",
  [
    ["One row per uploaded report (append-only; imports never overwrite each other)"],
    ["Column", "Type", "Description"],
    ["id", "serial PK", "Import id"],
    ["label", "text/null", "Friendly name (from upload)"],
    ["source_filename", "text", "Original file name"],
    ["report_date", "date/null", "'As of' date (from upload)"],
    ["summary", "jsonb", "Parse summary (see ParseSummary sheet)"],
    ["change_summary", "jsonb/null", "Field-level diff vs previous import (see ChangeSummary sheet)"],
    ["ai_report", "jsonb/null", "Cached advisory AI report (never authoritative)"],
    ["created_at", "timestamp", "Upload time"],
  ],
  [18, 14, 56],
);

// 5. DB: record_pool table
sheet(
  "Table - record_pool",
  [
    ["Permanent, append-only store of distinct full rows (deduped across uploads by hash)"],
    ["Column", "Type", "Description"],
    ["id", "serial PK", "Pool row id"],
    ["hash", "text unique", "SHA-256 of all 18 normalized fields; identical rows share it"],
    ["job", "text", "Forward-filled, normalized Project Code"],
    ["structure", "text", "Derived from Alias"],
    ["mark_tail", "text", "Mark No. with '<job> <alias>-' prefix stripped"],
    ["mark_id", "text", "job\\structure\\markTail (human-facing identity)"],
    ["order_nature", "text/null", "Order Nature"],
    ["contractor", "text/null", "Contractor"],
    ["job_card_no", "text/null", "Job Card No."],
    ["tower_type", "text/null", "Tower Type"],
    ["tower_sub_type", "text/null", "Tower Sub Type"],
    ["alias", "text/null", "Alias"],
    ["mark_no", "text", "Mark No. (raw)"],
    ["section", "text/null", "Section"],
    ["length", "number/null", "Length"],
    ["width", "number/null", "Width"],
    ["wt_pcs", "number/null", "Wt/Pcs"],
    ["balance_qty", "number", "Balance Qty. (defaults 0)"],
    ["balance_wt", "number", "Balance Wt. (defaults 0)"],
    ["assign_date", "date/null", "Assign Date, normalized YYYY-MM-DD"],
    ["activity", "text/null", "Activity"],
    ["operation", "text/null", "Operation"],
    ["ref_job_card_no", "text/null", "Ref. Job Card No."],
  ],
  [18, 14, 56],
);

// 6. DB: import_rows table
sheet(
  "Table - import_rows",
  [
    ["Which pool rows belong to which import. PK = (import_id, pool_id)"],
    ["Column", "Type", "Description"],
    ["import_id", "integer FK", "-> imports.id (cascade delete)"],
    ["pool_id", "integer FK", "-> record_pool.id (pool rows are permanent)"],
    ["copies", "integer", "How many copies of this pool row this import contains (preserves in-sheet duplicates)"],
  ],
  [16, 14, 60],
);

// 7. ParseSummary
sheet(
  "ParseSummary",
  [
    ["Stored in imports.summary (jsonb)"],
    ["Field", "Type", "Meaning"],
    ["rowsRead", "integer", "Rows read from the sheet"],
    ["rowsKept", "integer", "Rows kept (had a Mark No.)"],
    ["distinctRows", "integer", "Distinct full-row hashes"],
    ["duplicateRowCopies", "integer", "Kept rows minus distinct rows"],
    ["projectsFound", "integer", "Distinct project codes"],
    ["missingContractor", "integer", "Kept rows with no contractor"],
    ["missingDate", "integer", "Kept rows with no assign date"],
  ],
  [22, 12, 44],
);

// 8. ChangeSummary
sheet(
  "ChangeSummary",
  [
    ["Stored in imports.change_summary (jsonb) — diff vs the previous import"],
    ["Field", "Type", "Meaning"],
    ["prevImportId", "integer/null", "The import compared against"],
    ["addedRows", "integer", "Newly added rows"],
    ["unchangedRows", "integer", "Rows unchanged"],
    ["movedActivity", "integer", "Marks whose activity changed"],
    ["qtyChanged", "integer", "Marks whose qty/wt changed"],
    ["newMarks", "integer", "New mark identities"],
    ["completed", "integer", "Mark identities that disappeared (flagged complete)"],
    ["netPendingQtyChange", "number", "Net change in pending qty"],
    ["netPendingWtChange", "number", "Net change in pending wt"],
    ["flags", "string[]", "Self-check / advisory flags"],
  ],
  [22, 14, 50],
);

// 9. Computed-live fields
sheet(
  "Computed Fields",
  [
    ["Recomputed on every read (not stored)"],
    ["Field", "Type", "How it is computed"],
    ["ageingDays", "integer/null", "today - assignDate in whole UTC days; null if no date"],
    ["ageing color", "n/a", "green <=30, amber 31-60, red >60, neutral when no date"],
    ["routeSteps", "string[]", "Operation string split on commas (trimmed)"],
    ["currentStepIndex", "integer/null", "Index of activity within routeSteps, else null"],
  ],
  [18, 14, 56],
);

// 10. API endpoints
sheet(
  "API Endpoints",
  [
    ["Method & path", "Input / parameters", "Returns"],
    ["GET /healthz", "none", "{ status }"],
    ["GET /imports", "none", "All imports, newest first"],
    ["POST /imports", "multipart: file (req), label, reportDate", "Created import + change set"],
    ["DELETE /imports", "none", "{ importsDeleted, poolRowsDeleted } — full reset"],
    ["GET /imports/{id}", "path id", "One import with summaries"],
    ["DELETE /imports/{id}", "path id", "204; deletes the import only (pool stays)"],
    ["GET /imports/{id}/records", "path id", "Records, copy-expanded, with live ageing/route"],
    ["GET /imports/{id}/changes", "path id", "Change set vs previous import"],
    ["GET /imports/compare", "query from (req), to (req)", "Change set between any two imports"],
    ["GET /ai/status", "none", "{ available }"],
    ["POST /ai/sanitize", "json { importId }", "Suggested descriptive-field cleanups (advisory)"],
    ["POST /ai/review", "json { importId, compareTo?, deep? }", "Consistency audit (advisory, read-only)"],
    ["POST /ai/report", "json { importId, compareTo?, filters? }", "Turnaround analytical report (advisory)"],
  ],
  [26, 44, 48],
);

const outDir = resolve("../../docs");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "DATA_STRUCTURE.xlsx");
XLSX.writeFile(wb, outPath);
console.log("Wrote", outPath);
