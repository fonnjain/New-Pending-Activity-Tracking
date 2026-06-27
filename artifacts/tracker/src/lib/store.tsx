import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import { useListImports, useListContractorCategories, type Record } from "@workspace/api-client-react";
import { bundleActivitySet, getActivityBundle, normalizeContractorName } from "@workspace/domain";

// Sentinel prefix that marks an activity-bundle selection inside the single
// `filters.activity` slot. A plain activity code (e.g. "Y") is matched exactly;
// a "bundle:<id>" value is resolved to the bundle's member set and OR-matched.
const BUNDLE_PREFIX = "bundle:";

export interface Filters {
  category: string; // "TLT" | "NTLT" (Order type) — a MODE, never null
  ntltSubtype: string | null; // "RSJ" | "EARTHING" | "GENERAL" (only within NTLT)
  job: string | null; // primary dimension in TLT mode
  section: string | null; // primary dimension in NTLT mode (matches groupKey)
  structure: string | null;
  mark: string | null;
  contractor: string | null;
  contractorCategory: string | null; // IN_HOUSE | SUB_CONTRACTOR | OUT_VENDOR | UNCLASSIFIED
  outVendorType: string | null; // FAB | GALVA (only meaningful with OUT_VENDOR)
  activity: string | null;
  dateRange: string | null;
  search: string;
}

interface TrackerContextType {
  selectedImportId: number | null;
  setSelectedImportId: (id: number | null) => void;
  filters: Filters;
  setFilter: (key: keyof Filters, value: string | null) => void;
  clearFilters: () => void;
}

const defaultFilters: Filters = {
  category: "TLT",
  ntltSubtype: null,
  job: null,
  section: null,
  structure: null,
  mark: null,
  contractor: null,
  contractorCategory: null,
  outVendorType: null,
  activity: null,
  dateRange: null,
  search: "",
};

const TrackerContext = createContext<TrackerContextType | undefined>(undefined);

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [selectedImportId, setSelectedImportId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
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
        // TLT primary cascade: Project -> Structure -> Mark
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
    <TrackerContext.Provider value={{ selectedImportId, setSelectedImportId, filters, setFilter, clearFilters }}>
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
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const day = now.getDate();
  const endExclusive = new Date(y, mo, day + 1); // start of tomorrow (local)
  switch (code) {
    case "3m": return { start: clampedDate(y, mo - 3, day), end: endExclusive };
    case "6m": return { start: clampedDate(y, mo - 6, day), end: endExclusive };
    case "9m": return { start: clampedDate(y, mo - 9, day), end: endExclusive };
    case "1y": return { start: clampedDate(y - 1, mo, day), end: endExclusive };
    case "q1": return { start: new Date(y, 0, 1), end: new Date(y, 3, 1) };
    case "q2": return { start: new Date(y, 3, 1), end: new Date(y, 6, 1) };
    case "q3": return { start: new Date(y, 6, 1), end: new Date(y, 9, 1) };
    case "q4": return { start: new Date(y, 9, 1), end: new Date(y + 1, 0, 1) };
    default: return null;
  }
}

function parseAssignDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mo - 1, dd);
  // Reject values that JS would silently normalize (e.g. 2025-02-30).
  if (d.getFullYear() !== yy || d.getMonth() !== mo - 1 || d.getDate() !== dd) return null;
  return d;
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

export function useFilteredRecords(records: Record[] | undefined) {
  const { filters } = useTracker();
  const categoryMap = useContractorCategoryMap();

  return useMemo(() => {
    if (!records) return [];

    const win = dateRangeWindow(filters.dateRange);
    const q = filters.search.trim().toLowerCase();

    // Resolve an activity-bundle selection once per pass. A "bundle:<id>" value
    // OR-matches the bundle's member codes; a plain code matches exactly.
    const activityFilter = filters.activity;
    const bundleSet =
      activityFilter && activityFilter.startsWith(BUNDLE_PREFIX)
        ? bundleActivitySet(activityFilter.slice(BUNDLE_PREFIX.length))
        : null;

    // Smart search: if the query is exactly a job code, treat it as a job
    // filter (show only that job). Otherwise it's a free-text mark search.
    // This resolves the common confusion where a mark is literally named after
    // another job's number (e.g. job 900 has a mark named "902"), which would
    // otherwise make a "902" search surface job-900 rows.
    const jobCodes = q ? new Set(records.map((r) => r.job?.toLowerCase()).filter(Boolean)) : null;
    const searchIsJob = !!q && !!jobCodes && jobCodes.has(q);

    return records.filter((r) => {
      if (win) {
        const d = parseAssignDate(r.assignDate);
        if (!d || d < win.start || d >= win.end) return false;
      }
      // "All" Order Type includes both TLT and NTLT (no category gate).
      if (filters.category !== "ALL" && (r.category || "TLT") !== filters.category) return false;
      // Inactive marks (e.g. FOUNDATION BOLT) are captured but excluded from
      // every workflow metric/view. TLT rows are always active, so this never
      // changes TLT behaviour.
      if (r.active === false) return false;
      if (filters.ntltSubtype && r.ntltSubtype !== filters.ntltSubtype) return false;
      if (filters.job && r.job !== filters.job) return false;
      if (filters.section && r.groupKey !== filters.section) return false;
      if (filters.structure && r.structure !== filters.structure) return false;
      if (filters.mark && r.markId !== filters.mark && r.markTail !== filters.mark) return false;
      if (filters.contractor && r.contractor !== filters.contractor) return false;
      if (filters.contractorCategory || filters.outVendorType) {
        const info = contractorCategoryFor(r.contractor, categoryMap);
        if (filters.contractorCategory && info.category !== filters.contractorCategory) return false;
        if (filters.outVendorType && !info.outVendorType.includes(filters.outVendorType)) return false;
      }
      if (activityFilter) {
        if (bundleSet) {
          if (!bundleSet.has((r.activity ?? "").toUpperCase())) return false;
        } else if (r.activity !== activityFilter) {
          return false;
        }
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
  }, [records, filters, categoryMap]);
}
