import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useListSnapshots, type Record } from "@workspace/api-client-react";

export interface Filters {
  job: string | null;
  structure: string | null;
  mark: string | null;
  contractor: string | null;
  activity: string | null;
  search: string;
}

interface TrackerContextType {
  selectedSnapshotId: number | null;
  setSelectedSnapshotId: (id: number | null) => void;
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
  search: "",
};

const TrackerContext = createContext<TrackerContextType | undefined>(undefined);

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const { data: snapshots } = useListSnapshots();

  // Default to the newest snapshot, and recover if the selected one is removed.
  useEffect(() => {
    if (!snapshots) return;
    if (snapshots.length === 0) {
      if (selectedSnapshotId !== null) setSelectedSnapshotId(null);
      return;
    }
    const exists = snapshots.some((s) => s.id === selectedSnapshotId);
    if (!exists) {
      setSelectedSnapshotId(snapshots[0].id);
    }
  }, [snapshots, selectedSnapshotId]);

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
    <TrackerContext.Provider value={{ selectedSnapshotId, setSelectedSnapshotId, filters, setFilter, clearFilters }}>
      {children}
    </TrackerContext.Provider>
  );
}

export function useTracker() {
  const ctx = useContext(TrackerContext);
  if (!ctx) throw new Error("useTracker must be used within TrackerProvider");
  return ctx;
}

export function useFilteredRecords(records: Record[] | undefined) {
  const { filters } = useTracker();
  
  if (!records) return [];

  return records.filter((r) => {
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
}
