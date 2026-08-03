// Shared record filtering + aggregation. This module is the SINGLE source of
// truth for how records are filtered and rolled up, imported by BOTH the
// frontend (so the client keeps working exactly as before) AND the api-server
// (so server-computed summaries are byte-for-byte identical to what the client
// would have computed locally). It is purely additive and read-only: it never
// touches parsing, Activity values, qty, dedup/hash identity, or ageing math.

import {
  bundleActivitySet,
  matchesContractorCategoryFilter,
  normalizeContractorName,
  lifecycleStatus,
  scopeFor,
  sequenceFor,
  type TurnaroundSettings,
} from "./index";

// ---------------------------------------------------------------------------
// Input shape — the subset of a serialized record the filter/aggregators read.
// Both the generated client `Record` type and the server's serializeRecord
// output structurally satisfy this, so callers pass their rows unchanged.
// ---------------------------------------------------------------------------
export interface AggRecord {
  markId: string | null;
  markTail: string | null;
  jobCardNo: string | null;
  job: string | null;
  structure: string | null;
  section: string | null;
  contractor: string | null;
  activity: string | null;
  assignDate: string | null;
  ageingDays: number | null;
  balanceQty: number;
  balanceWt: number;
  category: string | null;
  ntltSubtype: string | null;
  groupKey: string | null;
  // MFC batch (WO Batch No.). Optional here because some legacy callers/rows may
  // omit it; treat a missing value as "Z" (blanks group/sort after real batches).
  mfcBatch?: string | null;
  // Optional: the generated client Record marks this optional (legacy rows
  // resolve it live), so AggRecord must too or `Record extends AggRecord` fails.
  holeOperation?: string | null;
  active: boolean | null;
}

// Contractor sub-category overlay entry (normalized name -> category + tags).
export interface ContractorCatInfo {
  category: string;
  outVendorType: string[];
}

// Mirrors the frontend `Filters` slots that affect which records are included.
// (UI-only slots like the active page/tab are not part of this.)
export interface RecordFilters {
  category: string; // "ALL" | "TLT" | "NTLT"
  ntltSubtype: string | null;
  job: string | null;
  // Set-membership job filter ("Current Jobs" mode). Additive and optional --
  // when present it is checked INSTEAD of the single-value `job` equality
  // above (the two are mutually exclusive in practice: callers resolve the
  // "Current Jobs" sentinel into `jobIn` and clear `job`, or vice versa).
  // undefined/null behaves exactly as before everywhere.
  jobIn?: ReadonlySet<string> | null;
  section: string | null;
  // MFC batch (WO Batch No.) filter. Compared against (r.mfcBatch || "Z").
  mfcBatch: string | null;
  structure: string | null;
  mark: string | null;
  contractor: string | null;
  contractorCategory: string | null;
  outVendorType: string | null;
  activity: string | null;
  holeOperation: string | null;
  search: string;
}

const BUNDLE_PREFIX = "bundle:";

// A resolved date window expressed as CALENDAR DAY KEYS (YYYYMMDD integers),
// inclusive `start` / exclusive `end`. Day keys are timezone-INDEPENDENT: the
// CLIENT derives them from its local "today" (see dateRangeWindow + dateToDayKey)
// and the server compares each row's assign date by the same calendar-day
// arithmetic, so the included row set is byte-for-byte identical regardless of
// the server's timezone. (NOT epoch ms — mixing client-local ms bounds with
// server-local date parsing could shift rows by a day at the window edges.)
export interface DateWindow {
  start: number;
  end: number;
}

// Parse an "YYYY-MM-DD" assign/production date string into local epoch ms,
// rejecting values JS would silently normalize (e.g. 2025-02-30). Mirrors the
// frontend parser exactly. Returns null for blank/invalid input. Used only by
// the client's local date helpers; date-window FILTERING uses assignDayKey so
// it stays timezone-independent across client/server.
export function parseAssignDateMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mo - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mo - 1 || d.getDate() !== dd) {
    return null;
  }
  return d.getTime();
}

// Convert an "YYYY-MM-DD" date string into a comparable calendar-day key
// (YYYYMMDD integer), rejecting values JS would silently normalize (e.g.
// 2025-02-30) exactly like parseAssignDateMs. Pure string arithmetic — no
// timezone involved — so it yields the same key on client and server. Returns
// null for blank/invalid input.
export function assignDayKey(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mo - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mo - 1 || d.getDate() !== dd) {
    return null;
  }
  return yy * 10000 + mo * 100 + dd;
}

// Calendar-day key (YYYYMMDD) for a Date using its LOCAL components. The client
// uses this to turn its locally-resolved window boundaries (always local
// midnight, day-aligned) into day keys for the server.
export function dateToDayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export interface FilterOptions {
  // Resolved date window as calendar day keys (caller computes from local
  // today); null = no date filter.
  dateWindow?: DateWindow | null;
  // Contractor sub-category overlay (normalized name -> info). Required only
  // when contractorCategory / outVendorType filters are active. ReadonlyMap so
  // callers can pass a richer map (extra fields) without value-type invariance
  // errors.
  categoryMap?: ReadonlyMap<string, ContractorCatInfo>;
}

// Apply the full filter set to a record list, preserving input order. This is a
// 1:1 port of the frontend useFilteredRecords predicate so the client and the
// server include EXACTLY the same rows.
export function filterRecords<T extends AggRecord>(
  records: readonly T[],
  filters: RecordFilters,
  opts: FilterOptions = {},
): T[] {
  const win = opts.dateWindow ?? null;
  const categoryMap = opts.categoryMap;
  const q = filters.search.trim().toLowerCase();

  const activityFilter = filters.activity;
  const bundleSet =
    activityFilter && activityFilter.startsWith(BUNDLE_PREFIX)
      ? bundleActivitySet(activityFilter.slice(BUNDLE_PREFIX.length))
      : null;

  // Smart search: a query that is exactly a job code filters to that job;
  // otherwise it is a free-text mark/section/contractor search.
  const jobCodes = q
    ? new Set(records.map((r) => r.job?.toLowerCase()).filter(Boolean))
    : null;
  const searchIsJob = !!q && !!jobCodes && jobCodes.has(q);

  const catInfoFor = (contractor: string | null): ContractorCatInfo => {
    const hit = categoryMap?.get(normalizeContractorName(contractor));
    return hit ?? { category: "UNCLASSIFIED", outVendorType: [] };
  };

  return records.filter((r) => {
    if (win) {
      const k = assignDayKey(r.assignDate);
      if (k !== null && (k < win.start || k >= win.end)) return false;
    }
    if (filters.category !== "ALL" && (r.category || "TLT") !== filters.category)
      return false;
    if (r.active === false) return false;
    if (filters.ntltSubtype && r.ntltSubtype !== filters.ntltSubtype) return false;
    if (filters.job && r.job !== filters.job) return false;
    if (filters.jobIn) {
      if (!r.job) return false;
      // Check both the plain job code (used by "Current Jobs" and legacy templates)
      // and the "job - mfcBatch" combo key (used by MFC-aware job templates).
      // "Z" is the sentinel for no-batch records — treat it the same as null so
      // those records match a plain job-code entry in the set.
      const realBatch = r.mfcBatch && r.mfcBatch !== "Z" ? r.mfcBatch : null;
      const comboKey = realBatch ? `${r.job} - ${realBatch}` : null;
      if (!filters.jobIn.has(r.job) && !(comboKey && filters.jobIn.has(comboKey))) return false;
    }
    if (filters.section && r.groupKey !== filters.section) return false;
    if (filters.mfcBatch && (r.mfcBatch || "Z") !== filters.mfcBatch) return false;
    if (filters.structure && r.structure !== filters.structure) return false;
    if (filters.mark && r.markId !== filters.mark && r.markTail !== filters.mark)
      return false;
    if (filters.contractor && r.contractor !== filters.contractor) return false;
    if (filters.contractorCategory || filters.outVendorType) {
      const info = catInfoFor(r.contractor);
      if (
        filters.contractorCategory &&
        !matchesContractorCategoryFilter(info.category, filters.contractorCategory)
      )
        return false;
      if (filters.outVendorType && !info.outVendorType.includes(filters.outVendorType))
        return false;
    }
    if (activityFilter) {
      if (bundleSet) {
        if (!bundleSet.has((r.activity ?? "").toUpperCase())) return false;
      } else if (r.activity !== activityFilter) {
        return false;
      }
    }
    if (filters.holeOperation && (r.holeOperation || "NOT_SET") !== filters.holeOperation) {
      return false;
    }
    if (q) {
      if (searchIsJob) {
        if (r.job?.toLowerCase() !== q) return false;
      } else {
        const matchSearch =
          r.markId?.toLowerCase().includes(q) ||
          r.markTail?.toLowerCase().includes(q) ||
          r.section?.toLowerCase().includes(q) ||
          r.contractor?.toLowerCase().includes(q);
        if (!matchSearch) return false;
      }
    }
    return true;
  });
}

// Activity "C" (Cutting) means production has genuinely not begun. Mirrors the
// frontend isCutting helper.
function isCuttingActivity(activity: string | null | undefined): boolean {
  return (activity ?? "").trim().toUpperCase() === "C";
}

// ---------------------------------------------------------------------------
// Overview summary — every headline metric the Overview page renders, computed
// from the already-filtered record set. Mirrors the page's useMemo exactly.
// ---------------------------------------------------------------------------
export interface TopAgedMark {
  markId: string | null;
  contractor: string | null;
  ageingDays: number | null;
}

export interface BusiestContractor {
  contractor: string;
  weight: number;
  count: number;
}

export interface OverviewSummary {
  totalMarks: number;
  totalQty: number;
  totalWt: number;
  avgAgeing: number;
  contractorsCount: number;
  structuresCount: number;
  age0to30: number;
  age31to60: number;
  age60Plus: number;
  notStarted: number;
  noProductionDate: number;
  noAgeing: number;
  topAgedMarks: TopAgedMark[];
  busiestContractors: BusiestContractor[];
}

export function summarizeOverview(records: readonly AggRecord[]): OverviewSummary {
  const totalMarks = records.length;
  const totalQty = records.reduce((sum, r) => sum + r.balanceQty, 0);
  const totalWt = records.reduce((sum, r) => sum + r.balanceWt, 0);

  const recordsWithAgeing = records.filter((r) => r.ageingDays !== null);
  const avgAgeing = recordsWithAgeing.length
    ? Math.round(
        recordsWithAgeing.reduce((sum, r) => sum + (r.ageingDays || 0), 0) /
          recordsWithAgeing.length,
      )
    : 0;

  const contractorsCount = new Set(records.map((r) => r.contractor).filter(Boolean)).size;
  const structuresCount = new Set(records.map((r) => r.structure).filter(Boolean)).size;

  const topAgedMarks = [...recordsWithAgeing]
    .sort((a, b) => (b.ageingDays || 0) - (a.ageingDays || 0))
    .slice(0, 8)
    .map((m) => ({ markId: m.markId, contractor: m.contractor, ageingDays: m.ageingDays }));

  const contractorMap = new Map<string, { weight: number; count: number }>();
  records.forEach((r) => {
    const c = r.contractor || "Unassigned";
    if (!contractorMap.has(c)) contractorMap.set(c, { weight: 0, count: 0 });
    const stat = contractorMap.get(c)!;
    stat.weight += r.balanceWt;
    stat.count += 1;
  });
  const busiestContractors = Array.from(contractorMap.entries())
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 5)
    .map(([contractor, stats]) => ({ contractor, weight: stats.weight, count: stats.count }));

  const age0to30 = recordsWithAgeing.filter(
    (r) => r.ageingDays !== null && r.ageingDays <= 30,
  ).length;
  const age31to60 = recordsWithAgeing.filter(
    (r) => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60,
  ).length;
  const age60Plus = recordsWithAgeing.filter(
    (r) => r.ageingDays !== null && r.ageingDays > 60,
  ).length;

  const noDate = records.filter((r) => r.ageingDays === null);
  const notStarted = noDate.filter((r) => isCuttingActivity(r.activity)).length;
  const noProductionDate = noDate.length - notStarted;
  const noAgeing = noDate.length;

  return {
    totalMarks,
    totalQty,
    totalWt,
    avgAgeing,
    contractorsCount,
    structuresCount,
    age0to30,
    age31to60,
    age60Plus,
    notStarted,
    noProductionDate,
    noAgeing,
    topAgedMarks,
    busiestContractors,
  };
}

// Turnaround lifecycle tallies the Overview snapshot card shows (green / pre-warn
// / breach / na). Mirrors the page's SnapshotCards reducer exactly.
export interface LifecycleCounts {
  green: number;
  prewarn: number;
  breach: number;
  na: number;
}

export function lifecycleCounts(
  records: readonly AggRecord[],
  settings: TurnaroundSettings,
): LifecycleCounts {
  let green = 0;
  let prewarn = 0;
  let breach = 0;
  let na = 0;
  for (const r of records) {
    const res = lifecycleStatus(
      {
        activity: r.activity,
        ageingDays: r.ageingDays,
        scope: scopeFor(r),
        sequence: sequenceFor(r),
      },
      settings,
    );
    if (res.status === "na") na++;
    else if (res.status === "green") green++;
    else if (res.status.startsWith("breach")) breach++;
    else prewarn++;
  }
  return { green, prewarn, breach, na };
}

// Identity key matching the velocity/movement engines (markId + jobCardNo).
export function identityKey(
  markId: string | null | undefined,
  jobCardNo: string | null | undefined,
): string {
  return `${markId ?? ""}\u0001${jobCardNo ?? ""}`;
}
