import { useMemo } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
} from "@workspace/api-client-react";

export interface FgComputedRow {
  project: string;
  structure: string;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  // Finished Good Overview Computed = Order Review file Galvanising (col N)
  // minus file Dispatch (col Q). Purely file-sourced.
  computedFgMt: number | null;
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
  const { filters } = useTracker();

  const { data: order, isLoading: orderLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });

  const rows = useMemo<FgComputedRow[]>(() => {
    const all = order?.rows ?? [];
    const filtered = filters.job ? all.filter((r) => r.project === filters.job) : all;
    return filtered.map((r) => ({
      project: r.project,
      structure: r.structure,
      releaseMt: r.releaseMt,
      fileDespatchMt: r.fileDespatchMt,
      computedFgMt:
        r.fileGalvMt == null ? null : r.fileGalvMt - (r.fileDespatchMt ?? 0),
    }));
  }, [order, filters.job]);

  return {
    available: order?.available ?? false,
    asOnDate: order?.asOnDate ?? null,
    rows,
    isLoading: orderLoading,
  };
}
