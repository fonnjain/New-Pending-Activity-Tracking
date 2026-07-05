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
  // Finished Good WIP Computed = Galvanizing WIP Accumulated (lifetime,
  // per-project) minus total file Dispatch (col Q) for that project, summed
  // across all its structures. Accumulated WIP is only tracked per project
  // (no structure breakdown), so this is a project-level figure repeated on
  // every structure row of that project — not a per-structure computation.
  // Null only when the project has no Accumulated WIP entry at all.
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

  // Galvanizing WIP Accumulated, per project (lifetime throughput; no
  // structure breakdown exists for this figure).
  const galvAccByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of accWip?.byProject ?? []) {
      m.set(p.project, p.galvanizingMt);
    }
    return m;
  }, [accWip]);

  // Total file Dispatch (col Q), summed across all structures per project —
  // needed because Accumulated WIP has no per-structure figure to subtract
  // a per-structure dispatch from.
  const despatchByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of order?.rows ?? []) {
      m.set(r.project, (m.get(r.project) ?? 0) + (r.fileDespatchMt ?? 0));
    }
    return m;
  }, [order]);

  const rows = useMemo<FgComputedRow[]>(() => {
    const all = order?.rows ?? [];
    const filtered = filters.job ? all.filter((r) => r.project === filters.job) : all;
    return filtered.map((r) => {
      const galvAccMt = galvAccByProject.get(r.project);
      const projectDespatchMt = despatchByProject.get(r.project) ?? 0;
      return {
        project: r.project,
        structure: r.structure,
        releaseMt: r.releaseMt,
        fileDespatchMt: r.fileDespatchMt,
        computedFgMt:
          r.fileGalvMt == null ? null : r.fileGalvMt - (r.fileDespatchMt ?? 0),
        computedFgWipMt:
          galvAccMt === undefined ? null : galvAccMt - projectDespatchMt,
      };
    });
  }, [order, filters.job, galvAccByProject, despatchByProject]);

  return {
    available: order?.available ?? false,
    asOnDate: order?.asOnDate ?? null,
    rows,
    isLoading: orderLoading || accWipLoading,
  };
}
