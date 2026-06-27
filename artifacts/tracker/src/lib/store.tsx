import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import { useListImports, useListContractorCategories, type Record } from "@workspace/api-client-react";
import { getActivityBundle, normalizeContractorName, filterRecords, parseAssignDateMs, dateToDayKey, type RecordFilters } from "@workspace/domain";

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
  holeOperation: string | null; // "PUNCHING" | "DRILLING" | "NOT_SET" (derived)
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
  holeOperation: null,
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

// Resolve the active filters into the shared RecordFilters shape plus the
// concrete date window (epoch ms, computed from LOCAL today). The server
// summary endpoint receives this resolved window so both sides classify dates
// identically regardless of server timezone.
export function resolveActiveFilters(filters: Filters): {
  filters: RecordFilters;
  dateWindow: { start: number; end: number } | null;
} {
  const win = dateRangeWindow(filters.dateRange);
  return {
    filters: {
      category: filters.category,
      ntltSubtype: filters.ntltSubtype,
      job: filters.job,
      section: filters.section,
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

  return useMemo(() => {
    if (!records) return [];
    const { filters: rf, dateWindow } = resolveActiveFilters(filters);
    return filterRecords(records, rf, { dateWindow, categoryMap });
  }, [records, filters, categoryMap]);
}
