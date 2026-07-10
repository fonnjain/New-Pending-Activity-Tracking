import { useMemo } from "react";
import {
  useTracker,
  useCurrentJobsSet,
  CURRENT_JOBS_FILTER_VALUE,
  MULTI_JOBS_FILTER_VALUE,
} from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useListImports,
} from "@workspace/api-client-react";

export interface FgComputedRow {
  project: string;
  structure: string;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  // Finished Good Overview Computed = Order Review file Galvanising (col N)
  // minus file Dispatch (col Q). Purely file-sourced.
  computedFgMt: number | null;
  // Finished Good WIP = WIP file "FG Pending For Dispatch" balance weight for
  // this (project, structure), converted from kg to MT. Null when the WIP
  // file has no "Type" column (old format) or no matching FG row.
  fgWipMt: number | null;
}

// Shared, additive Finished Good computation used by both the Order Status
// page and the Data page's Computed FG tab, so the "Finished Good" figure is
// always defined and computed identically wherever it appears.
// Respects only the global Job filter (mirrors the prior Computed FG tab's
// scope) — never touches WIP parsing/activity/dedup/ageing/dispatch state.
export function useFgRows(): {
  available: boolean;
  asOnDate: string | null;
  rows: FgComputedRow[];
  isLoading: boolean;
} {
  const { filters, selectedImportId } = useTracker();

  const { data: order, isLoading: orderLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });

  const { data: imports, isLoading: importsLoading } = useListImports();

  const fgWipByStructure = useMemo(() => {
    const imp = imports?.find((i) => i.id === selectedImportId);
    return imp?.summary?.fgWipByStructure ?? {};
  }, [imports, selectedImportId]);

  const { set: currentJobsSet } = useCurrentJobsSet();

  const rows = useMemo<FgComputedRow[]>(() => {
    const all = order?.rows ?? [];
    let filtered: typeof all;
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) {
      filtered = all.filter((r) => currentJobsSet.has(r.project));
    } else if (filters.job === MULTI_JOBS_FILTER_VALUE) {
      const s = new Set(filters.selectedJobs);
      filtered = s.size > 0 ? all.filter((r) => s.has(r.project)) : all;
    } else if (filters.job) {
      filtered = all.filter((r) => r.project === filters.job);
    } else {
      filtered = all;
    }
    return filtered.map((r) => {
      const structKey = (r.structure ?? "").trim().toUpperCase();
      const fgWipKg = fgWipByStructure[r.project]?.[structKey];
      return {
        project: r.project,
        structure: r.structure,
        releaseMt: r.releaseMt,
        fileDespatchMt: r.fileDespatchMt,
        computedFgMt:
          r.fileGalvMt == null ? null : r.fileGalvMt - (r.fileDespatchMt ?? 0),
        fgWipMt: typeof fgWipKg === "number" ? fgWipKg / 1000 : null,
      };
    });
  }, [order, filters.job, filters.selectedJobs, currentJobsSet, fgWipByStructure]);

  return {
    available: order?.available ?? false,
    asOnDate: order?.asOnDate ?? null,
    rows,
    isLoading: orderLoading || importsLoading,
  };
}
