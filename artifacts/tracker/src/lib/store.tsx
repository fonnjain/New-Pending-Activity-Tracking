import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import { useListImports, type Record } from "@workspace/api-client-react";

export interface Filters {
  job: string | null;
  structure: string | null;
  mark: string | null;
  contractor: string | null;
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
  job: null,
  structure: null,
  mark: null,
  contractor: null,
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
      if (key === "job") {
        next.structure = null;
        next.mark = null;
      } else if (key === "structure") {
        next.mark = null;
      }
      return next;
    });
  };

  const clearFilters = () => setFilters(defaultFilters);

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

export function useFilteredRecords(records: Record[] | undefined) {
  const { filters } = useTracker();

  return useMemo(() => {
    if (!records) return [];

    const win = dateRangeWindow(filters.dateRange);

    return records.filter((r) => {
      if (win) {
        const d = parseAssignDate(r.assignDate);
        if (!d || d < win.start || d >= win.end) return false;
      }
      if (filters.job && r.job !== filters.job) return false;
      if (filters.structure && r.structure !== filters.structure) return false;
      if (filters.mark && r.markId !== filters.mark && r.markTail !== filters.mark) return false;
      if (filters.contractor && r.contractor !== filters.contractor) return false;
      if (filters.activity && r.activity !== filters.activity) return false;

      if (filters.search) {
        const q = filters.search.toLowerCase();
        const matchSearch =
          r.markId?.toLowerCase().includes(q) ||
          r.markTail?.toLowerCase().includes(q) ||
          r.section?.toLowerCase().includes(q) ||
          r.contractor?.toLowerCase().includes(q);
        if (!matchSearch) return false;
      }

      return true;
    });
  }, [records, filters]);
}
