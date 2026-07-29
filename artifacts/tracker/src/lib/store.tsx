import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListImports, useListContractorCategories, useGetCurrentJobs, type Record } from "@workspace/api-client-react";
import { getActivityBundle, normalizeContractorName, filterRecords, parseAssignDateMs, dateToDayKey, type RecordFilters } from "@workspace/domain";

// Sentinel prefix that marks an activity-bundle selection inside the single
// `filters.activity` slot. A plain activity code (e.g. "Y") is matched exactly;
// a "bundle:<id>" value is resolved to the bundle's member set and OR-matched.
const BUNDLE_PREFIX = "bundle:";

// Sentinel stored in `filters.job` for the "Current Jobs" set-membership mode
// (an uploaded list of project codes, not a real job value). Resolved into
// `RecordFilters.jobIn` by resolveActiveFilters; never itself matched against
// a record's `job` field.
export const CURRENT_JOBS_FILTER_VALUE = "__CURRENT_JOBS__";

// Sentinel stored in `filters.job` when the user picks "Select Multiple Jobs".
// The actual selected codes live in `filters.selectedJobs` (string[]). Resolved
// into `RecordFilters.jobIn` by resolveActiveFilters.
export const MULTI_JOBS_FILTER_VALUE = "__MULTI_JOBS__";

// Job Templates — named project sets managed via the Job Templates admin page.
// Each template filter value embeds the template DB id so resolution is O(1).
export const TEMPLATE_FILTER_PREFIX = "__TEMPLATE_";
export function isTemplateFilter(v: string | null | undefined): v is string {
  return !!v?.startsWith(TEMPLATE_FILTER_PREFIX);
}
export function templateFilterValue(id: number): string {
  return `${TEMPLATE_FILTER_PREFIX}${id}__`;
}
export function extractTemplateId(v: string): number {
  return parseInt(v.slice(TEMPLATE_FILTER_PREFIX.length).replace(/__$/, ""), 10);
}
/** True when the filter is any kind of named project set (old current-jobs or new template). */
export function isNamedJobSetFilter(v: string | null | undefined): boolean {
  return v === CURRENT_JOBS_FILTER_VALUE || isTemplateFilter(v);
}

/** Global view mode controlling how MFC Batch relates to Project in all grouping tables.
 *  - "project-with-mfc"  (default): Project is primary, MFC Batch is a sub-level under it.
 *  - "view-by-mfc":                 MFC Batch is primary within BOM/SubType; Projects nested below.
 *  - "project-then-mfc":            Flat combined key "{project}-{mfcBatch}" (no separate columns).
 */
export type MfcViewMode = "project-with-mfc" | "view-by-mfc" | "project-then-mfc";

export interface JobTemplate {
  id: number;
  name: string;
  category: string;
  sortOrder: number;
  members: string[];
}

export interface Filters {
  category: string; // "TLT" | "NTLT" (Order type) — a MODE, never null
  ntltSubtype: string | null; // "RSJ" | "EARTHING" | "GENERAL" (only within NTLT)
  job: string | null; // primary dimension in TLT mode
  section: string | null; // primary dimension in NTLT mode (matches groupKey)
  mfcBatch: string | null; // TLT sub-level: MFC batch (WO Batch No.), between Project and Structure
  structure: string | null;
  mark: string | null;
  contractor: string | null;
  contractorCategory: string | null; // CNC | SUB_CONTRACTOR | OUT_VENDOR | UNCLASSIFIED
  outVendorType: string | null; // FAB | GALVA (only meaningful with OUT_VENDOR)
  activity: string | null;
  holeOperation: string | null; // "PUNCHING" | "DRILLING" | "NOT_SET" (derived)
  dateRange: string | null;
  search: string;
  // Active only when job === MULTI_JOBS_FILTER_VALUE. Stores the user's checked
  // project codes. Cleared whenever job is changed to anything else.
  selectedJobs: string[];
}

interface TrackerContextType {
  selectedImportId: number | null;
  setSelectedImportId: (id: number | null) => void;
  filters: Filters;
  setFilter: (key: keyof Filters, value: string | null) => void;
  setSelectedJobs: (jobs: string[]) => void;
  clearFilters: () => void;
  mfcViewMode: MfcViewMode;
  setMfcViewMode: (mode: MfcViewMode) => void;
}

const defaultFilters: Filters = {
  category: "TLT",
  ntltSubtype: null,
  job: null,
  section: null,
  mfcBatch: null,
  structure: null,
  mark: null,
  contractor: null,
  contractorCategory: null,
  outVendorType: null,
  activity: null,
  holeOperation: null,
  dateRange: null,
  search: "",
  selectedJobs: [],
};

const TrackerContext = createContext<TrackerContextType | undefined>(undefined);

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [selectedImportId, setSelectedImportId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [mfcViewMode, setMfcViewMode] = useState<MfcViewMode>("project-with-mfc");
  const { data: imports } = useListImports();

  // Default to the newest import, and recover if the selected one is removed.
  useEffect(() => {
    if (!imports) return;
    if (imports.length === 0) {
      if (selectedImportId !== null) setSelectedImportId(null);
      return;
    }
    const exists = imports.some((s) => s.id === selectedImportId);
    if (!exists) {
      setSelectedImportId(imports[0].id);
    }
  }, [imports, selectedImportId]);

  const setSelectedJobs = (jobs: string[]) => {
    setFilters((prev) => ({
      ...prev,
      selectedJobs: jobs,
      // Enter MULTI_JOBS mode when any job is checked; exit to "All Jobs" when
      // every checkbox is cleared so the label reverts to "All Jobs".
      job: jobs.length > 0 ? MULTI_JOBS_FILTER_VALUE : null,
    }));
  };

  const setFilter = (key: keyof Filters, value: string | null) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // Cascading logic
      if (key === "category") {
        // The toggle drives BOTH filter dimension and grouping. Switching mode
        // resets every dimension filter to its "All" default so no stale
        // cross-mode selection (e.g. a TLT project carried into NTLT) persists.
        next.ntltSubtype = null;
        next.job = null;
        next.section = null;
        next.mfcBatch = null;
        next.structure = null;
        next.mark = null;
        // A TLT-scoped activity bundle is not offered outside TLT mode; drop it
        // so the activity filter can't silently empty an NTLT view. Plain codes
        // and ALL-scope bundles (Galvanizing/Yard) are valid everywhere and kept.
        if (next.activity?.startsWith(BUNDLE_PREFIX)) {
          const b = getActivityBundle(next.activity.slice(BUNDLE_PREFIX.length));
          if (b && b.scope === "TLT" && value !== "TLT") next.activity = null;
        }
      } else if (key === "job") {
        // TLT primary cascade: Project -> MFC -> Structure -> Mark
        next.mfcBatch = null;
        next.structure = null;
        next.mark = null;
        // Clear the multi-select checked list whenever leaving multi-jobs mode.
        if (value !== MULTI_JOBS_FILTER_VALUE) next.selectedJobs = [];
      } else if (key === "mfcBatch") {
        // MFC sits between Project and Structure in TLT; narrowing it drops any
        // stale structure/mark selection from a different batch.
        next.structure = null;
        next.mark = null;
      } else if (key === "section") {
        // NTLT primary cascade: Section -> Sub-category -> Mark
        next.ntltSubtype = null;
        next.mark = null;
      } else if (key === "ntltSubtype") {
        // Sub-category narrows the Section list, so a section picked under a
        // different sub-category must not linger (it would yield empty data).
        next.section = null;
        next.mark = null;
      } else if (key === "structure") {
        next.mark = null;
      } else if (key === "contractorCategory") {
        // The FAB/GALVA tag only narrows Out-vendors; drop it whenever the
        // category is anything other than OUT_VENDOR so it can't silently empty
        // the view.
        if (value !== "OUT_VENDOR") next.outVendorType = null;
      }
      return next;
    });
  };

  // Clearing preserves the current Order Type mode (it is a mode, not a filter)
  // and resets every other dimension/secondary filter.
  const clearFilters = () =>
    setFilters((prev) => ({ ...defaultFilters, category: prev.category }));

  return (
    <TrackerContext.Provider value={{ selectedImportId, setSelectedImportId, filters, setFilter, setSelectedJobs, clearFilters, mfcViewMode, setMfcViewMode }}>
      {children}
    </TrackerContext.Provider>
  );
}

export function useTracker() {
  const ctx = useContext(TrackerContext);
  if (!ctx) throw new Error("useTracker must be used within TrackerProvider");
  return ctx;
}

// Build a date safely: an out-of-range monthIndex is normalized, and the day is
// clamped to the last valid day of the target month so rolling windows don't
// drift at month-end (e.g. "3 months before May 31" -> Feb 28/29, not Mar 2/3).
function clampedDate(year: number, monthIndex: number, day: number): Date {
  const firstOfMonth = new Date(year, monthIndex, 1);
  const Y = firstOfMonth.getFullYear();
  const M = firstOfMonth.getMonth();
  const lastDay = new Date(Y, M + 1, 0).getDate();
  return new Date(Y, M, Math.min(day, lastDay));
}

export function dateRangeWindow(code: string | null): { start: Date; end: Date } | null {
  if (!code) return null;
  // Custom range encoded as "custom:YYYY-MM-DD:YYYY-MM-DD" (either side may be
  // blank while the user is still picking). End date is inclusive.
  if (code.startsWith("custom:")) {
    const [, s, e] = code.split(":");
    const startD = parseAssignDate(s);
    const endD = parseAssignDate(e);
    if (!startD || !endD) return null;
    const [lo, hi] = startD <= endD ? [startD, endD] : [endD, startD];
    const end = new Date(hi.getFullYear(), hi.getMonth(), hi.getDate() + 1); // exclusive
    return { start: lo, end };
  }
  // A single calendar month, encoded as "month:YYYY-MM" (e.g. "month:2026-06"
  // for June 2026). Whole-month window, end exclusive.
  if (code.startsWith("month:")) {
    const [, ym] = code.split(":");
    const [yStr, mStr] = (ym ?? "").split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (!y || !m || m < 1 || m > 12) return null;
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  }
  // A single calendar quarter, encoded as "quarter:YYYY-Q" (e.g.
  // "quarter:2026-2" for Q2 2026 = Apr-Jun 2026). Whole-quarter window, end
  // exclusive.
  if (code.startsWith("quarter:")) {
    const [, yq] = code.split(":");
    const [yStr, qStr] = (yq ?? "").split("-");
    const y = Number(yStr);
    const q = Number(qStr);
    if (!y || !q || q < 1 || q > 4) return null;
    const startMonth = (q - 1) * 3;
    return { start: new Date(y, startMonth, 1), end: new Date(y, startMonth + 3, 1) };
  }
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const day = now.getDate();
  const endExclusive = new Date(y, mo, day + 1); // start of tomorrow (local)
  switch (code) {
    case "1d": return { start: new Date(y, mo, day), end: endExclusive };
    case "7d": return { start: new Date(y, mo, day - 6), end: endExclusive };
    case "15d": return { start: new Date(y, mo, day - 14), end: endExclusive };
    case "3m": return { start: clampedDate(y, mo - 3, day), end: endExclusive };
    case "6m": return { start: clampedDate(y, mo - 6, day), end: endExclusive };
    case "9m": return { start: clampedDate(y, mo - 9, day), end: endExclusive };
    case "1y": return { start: clampedDate(y - 1, mo, day), end: endExclusive };
    default: return null;
  }
}

// Thin wrapper over the shared domain parser (single source of truth) returning
// a Date for the local date-window helpers above.
function parseAssignDate(s: string | null | undefined): Date | null {
  const ms = parseAssignDateMs(s);
  return ms === null ? null : new Date(ms);
}

export function isWithinDateRange(assignDate: string | null | undefined, code: string | null): boolean {
  const win = dateRangeWindow(code);
  if (!win) return true;
  const d = parseAssignDate(assignDate);
  if (!d) return false;
  return d >= win.start && d < win.end;
}

// Live contractor sub-category overlay: normalized contractor name -> entry.
// Joined to records at read time; an unmapped contractor is treated as
// UNCLASSIFIED. This NEVER alters parsing/ageing/dedup/qty or the contractor
// string — it only powers descriptive filters/labels.
export interface ContractorCategoryInfo {
  category: string; // CONTRACTOR_CATEGORIES value
  outVendorType: string[]; // FAB/GALVA tags
  displayName: string;
}

export function useContractorCategoryMap(): Map<string, ContractorCategoryInfo> {
  const { data } = useListContractorCategories();
  return useMemo(() => {
    const m = new Map<string, ContractorCategoryInfo>();
    for (const row of data ?? []) {
      m.set(row.nameKey, {
        category: row.category,
        outVendorType: row.outVendorType ?? [],
        displayName: row.displayName,
      });
    }
    return m;
  }, [data]);
}

// Resolve a contractor's category info from the overlay map, defaulting to
// UNCLASSIFIED with no tags when the contractor is not mapped.
export function contractorCategoryFor(
  contractor: string | null | undefined,
  map: Map<string, ContractorCategoryInfo>,
): ContractorCategoryInfo {
  const hit = map.get(normalizeContractorName(contractor));
  return hit ?? { category: "UNCLASSIFIED", outVendorType: [], displayName: contractor ?? "" };
}

// Live "Current Jobs" list (uploaded project codes) as a Set, plus its raw
// meta. Powers the "Current Jobs" Job filter option; empty when nothing has
// been uploaded (or after a clear) -- selecting it then legitimately yields
// zero records rather than falling back to "All".
export function useCurrentJobsSet() {
  const { data } = useGetCurrentJobs();
  const set = useMemo(() => new Set(data?.codes ?? []), [data]);
  return { set, meta: data?.meta ?? null };
}

// All job templates from the server, used by the filter dropdown and the
// active-job-set resolver.
export function useJobTemplates(): JobTemplate[] {
  const { data } = useQuery<JobTemplate[]>({
    queryKey: ["job-templates"],
    queryFn: () =>
      fetch("/api/job-templates", { credentials: "include" }).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
  });
  return data ?? [];
}

// Returns the project-code Set for the currently active filter, handling both
// the legacy "Current Jobs" sentinel and the new named-template sentinels.
// Use this everywhere pages need to resolve the active named set.
export function useActiveJobSet(): ReadonlySet<string> {
  const { filters } = useTracker();
  const { set: currentJobsSet } = useCurrentJobsSet();
  const templates = useJobTemplates();

  return useMemo(() => {
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) return currentJobsSet;
    if (isTemplateFilter(filters.job)) {
      const id = extractTemplateId(filters.job);
      const tpl = templates.find((t) => t.id === id);
      return new Set<string>(tpl?.members ?? []);
    }
    return new Set<string>();
  }, [filters.job, currentJobsSet, templates]);
}

// Resolve the active filters into the shared RecordFilters shape plus the
// concrete date window (epoch ms, computed from LOCAL today). `namedJobSet`
// resolves both the legacy CURRENT_JOBS_FILTER_VALUE sentinel and the new
// template sentinels into a set-membership filter; pass the result of
// useActiveJobSet() when calling from a component, or null when the caller
// knows named-set filters can't be active.
export function resolveActiveFilters(
  filters: Filters,
  namedJobSet?: ReadonlySet<string> | null,
): {
  filters: RecordFilters;
  dateWindow: { start: number; end: number } | null;
} {
  const win = dateRangeWindow(filters.dateRange);
  const isNamedSet = isNamedJobSetFilter(filters.job);
  const isMultiJobs = filters.job === MULTI_JOBS_FILTER_VALUE;
  return {
    filters: {
      category: filters.category,
      ntltSubtype: filters.ntltSubtype,
      job: (isNamedSet || isMultiJobs) ? null : filters.job,
      jobIn: isNamedSet
        ? (namedJobSet ?? new Set<string>())
        : isMultiJobs
          ? new Set(filters.selectedJobs)
          : null,
      section: filters.section,
      mfcBatch: filters.mfcBatch,
      structure: filters.structure,
      mark: filters.mark,
      contractor: filters.contractor,
      contractorCategory: filters.contractorCategory,
      outVendorType: filters.outVendorType,
      activity: filters.activity,
      holeOperation: filters.holeOperation,
      search: filters.search,
    },
    dateWindow: win ? { start: dateToDayKey(win.start), end: dateToDayKey(win.end) } : null,
  };
}

export function useFilteredRecords(records: Record[] | undefined) {
  const { filters } = useTracker();
  const categoryMap = useContractorCategoryMap();
  const activeJobSet = useActiveJobSet();

  return useMemo(() => {
    if (!records) return [];
    const { filters: rf, dateWindow } = resolveActiveFilters(filters, activeJobSet);
    return filterRecords(records, rf, { dateWindow, categoryMap });
  }, [records, filters, categoryMap, activeJobSet]);
}
