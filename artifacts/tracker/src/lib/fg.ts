import { useMemo } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useGetAccumulatedWip,
  getGetAccumulatedWipQueryKey,
} from "@workspace/api-client-react";

export interface FgComputedRow {
  project: string;
  structure: string;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  // Finished Good Overview Computed = Order Review file Galvanising (col N)
  // minus file Dispatch (col Q). Purely file-sourced.
  computedFgMt: number | null;
  // Finished Good WIP Computed = Galvanizing WIP Accumulated minus file
  // Dispatch (col Q), computed STRUCTURE-wise (the underlying Accumulated
  // WIP engine is mark-wise, rolled up structure-wise then project-wise;
  // file Dispatch is available structure-wise too, so this figure is a true
  // per-structure computation, not a repeated project total). Null only when
  // the structure has no Accumulated WIP entry at all.
  computedFgWipMt: number | null;
}

// Shared, additive Finished Good computation used by both the Order Status
// page and the Data page's Computed FG tab, so the two "Finished Good"
// figures are always defined and computed identically wherever they appear.
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

  const { data: accWip, isLoading: accWipLoading } = useGetAccumulatedWip({
    query: { queryKey: getGetAccumulatedWipQueryKey() },
  });

  // Galvanizing WIP Accumulated, structure-wise (the mark-wise engine rolled
  // up to project -> structure). Keyed by project+structure so the
  // per-structure figure below is a true structure-level computation, not a
  // project total repeated on every row.
  const galvAccByStructure = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of accWip?.byStructure ?? []) {
      m.set(`${s.project}\u0001${s.structure}`, s.galvanizingMt);
    }
    return m;
  }, [accWip]);

  const rows = useMemo<FgComputedRow[]>(() => {
    const all = order?.rows ?? [];
    const filtered = filters.job ? all.filter((r) => r.project === filters.job) : all;
    return filtered.map((r) => {
      const galvAccMt = galvAccByStructure.get(`${r.project}\u0001${r.structure}`);
      return {
        project: r.project,
        structure: r.structure,
        releaseMt: r.releaseMt,
        fileDespatchMt: r.fileDespatchMt,
        computedFgMt:
          r.fileGalvMt == null ? null : r.fileGalvMt - (r.fileDespatchMt ?? 0),
        computedFgWipMt:
          galvAccMt === undefined ? null : galvAccMt - (r.fileDespatchMt ?? 0),
      };
    });
  }, [order, filters.job, galvAccByStructure]);

  return {
    available: order?.available ?? false,
    asOnDate: order?.asOnDate ?? null,
    rows,
    isLoading: orderLoading || accWipLoading,
  };
}
