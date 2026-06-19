import * as XLSX from "xlsx";
import type { InsertRecord } from "@workspace/db";

export interface ParseSummary {
  rowsRead: number;
  marksAfterDedupe: number;
  projectsFound: number;
  missingContractor: number;
  missingDate: number;
  duplicateMarksCollapsed: number;
}

export interface ParseResult {
  records: Omit<InsertRecord, "snapshotId">[];
  summary: ParseSummary;
}

type Cell = string | number | boolean | Date | null | undefined;
type RawRow = Record<string, Cell>;

function cellToString(value: Cell): string {
  if (value == null) return "";
  if (value instanceof Date) return formatDate(value) ?? "";
  return String(value).trim();
}

function normalizeProject(value: Cell): string {
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
} as const;

function deriveMark(
  markNo: string,
  job: string,
  alias: string,
): { structure: string; markTail: string } {
  const structure = alias || "";
  const fullPrefix = `${job} ${alias}-`;
  const aliasPrefix = `${alias}-`;
  let markTail = markNo;
  if (alias && job && markNo.startsWith(fullPrefix)) {
    markTail = markNo.slice(fullPrefix.length);
  } else if (alias && markNo.startsWith(aliasPrefix)) {
    markTail = markNo.slice(aliasPrefix.length);
  } else {
    // Fallback: strip a leading "<job> " token if present, then take after first hyphen group
    let rest = markNo;
    if (job && rest.startsWith(`${job} `)) rest = rest.slice(job.length + 1);
    if (alias && rest.startsWith(`${alias}-`)) {
      rest = rest.slice(alias.length + 1);
    }
    markTail = rest;
  }
  return { structure, markTail: markTail.trim() };
}

export function parseWorkbook(buffer: Buffer): ParseResult {
  const wb = XLSX.read(buffer, { cellDates: true });
  const sheetName = wb.SheetNames.includes("Sheet1")
    ? "Sheet1"
    : wb.SheetNames[0];
  if (!sheetName) {
    throw new Error("Workbook has no sheets");
  }
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error("Could not read sheet");
  }

  // header on the third row => header index 2 (0-based)
  const rows = XLSX.utils.sheet_to_json<RawRow>(ws, {
    range: 2,
    defval: null,
    raw: true,
  });

  let rowsRead = 0;
  let lastProject = "";
  const projects = new Set<string>();

  interface Parsed extends Omit<InsertRecord, "snapshotId"> {
    _sortDate: string | null;
  }

  const parsedRows: Parsed[] = [];

  for (const row of rows) {
    rowsRead++;

    // forward-fill project code
    const rawProject = normalizeProject(row[COL.projectCode]);
    if (rawProject) lastProject = rawProject;
    const job = lastProject;

    // keep only rows with a Mark No.
    const markNo = cellToString(row[COL.markNo]);
    if (!markNo) continue;

    const alias = cellToString(row[COL.alias]);
    const { structure, markTail } = deriveMark(markNo, job, alias);
    const markId = `${job}\\${structure}\\${markTail}`;

    if (job) projects.add(job);

    const assignDate = formatDate(row[COL.assignDate]);

    parsedRows.push({
      markId,
      job,
      structure,
      markTail,
      section: emptyToNull(row[COL.section]),
      grade: null,
      wtPcs: toNumber(row[COL.wtPcs]),
      balanceQty: toNumber(row[COL.balanceQty]) ?? 0,
      balanceWt: toNumber(row[COL.balanceWt]) ?? 0,
      activity: emptyToNull(row[COL.activity]),
      operation: emptyToNull(row[COL.operation]),
      assignDate,
      contractor: emptyToNull(row[COL.contractor]),
      orderNature: emptyToNull(row[COL.orderNature]),
      towerType: emptyToNull(row[COL.towerType]),
      _sortDate: assignDate,
    });
  }

  // de-dupe by markId: keep latest Assign Date; tie -> largest Balance Qty
  const byMark = new Map<string, Parsed>();
  let collapsed = 0;
  for (const r of parsedRows) {
    const existing = byMark.get(r.markId);
    if (!existing) {
      byMark.set(r.markId, r);
      continue;
    }
    collapsed++;
    const a = r._sortDate ?? "";
    const b = existing._sortDate ?? "";
    let replace = false;
    if (a > b) replace = true;
    else if (a === b && r.balanceQty > existing.balanceQty) replace = true;
    if (replace) byMark.set(r.markId, r);
  }

  const deduped = Array.from(byMark.values());
  const records = deduped.map(({ _sortDate, ...rest }) => {
    void _sortDate;
    return rest;
  });

  const missingContractor = records.filter((r) => r.contractor == null).length;
  const missingDate = records.filter((r) => r.assignDate == null).length;

  return {
    records,
    summary: {
      rowsRead,
      marksAfterDedupe: records.length,
      projectsFound: projects.size,
      missingContractor,
      missingDate,
      duplicateMarksCollapsed: collapsed,
    },
  };
}

export function computeAgeing(assignDate: string | null): number | null {
  if (!assignDate) return null;
  const d = new Date(`${assignDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const diff = todayUtc - d.getTime();
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
