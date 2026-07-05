import { useMemo } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type Record as WipRecord,
} from "@workspace/api-client-react";
import { bundleActivitySet } from "@workspace/domain";

// Same GALVANIZING bundle (G,GB,Y) used by the Order Status page's live
// Galvanizing column.
const GALV_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();
const KEY_SEP = "\u0001";

export interface FgComputedRow {
  project: string;
  structure: string;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  // Finished Good Overview Computed = Order Review file Galvanising (col N)
  // minus file Dispatch (col Q). Purely file-sourced.
  computedFgMt: number | null;
  // Finished Good WIP Computed = live WIP Galvanizing (activities G,GB,Y)
  // minus file Dispatch (col Q). WIP-sourced; null when the structure has no
  // TLT WIP presence at all (out of scope / not in WIP), matching the Order
  // Status page's Galvanizing column n/a cases.
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
  const { filters, selectedImportId } = useTracker();

  const { data: order, isLoading: orderLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });

  const { data: records = [], isLoading: recordsLoading } = useGetImportRecords(
    selectedImportId as number,
    {
      query: {
        enabled: !!selectedImportId,
        queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
      },
    },
  );

  // Per (project, structure): sum of live WIP Galvanizing tonnage (TLT-only,
  // G/GB/Y bundle) plus a presence flag so "0 in the bundle" can be told apart
  // from "not in WIP at all" (the latter stays null / n/a).
  const { galvByKey, presentKeys } = useMemo(() => {
    const galv = new Map<string, number>();
    const present = new Set<string>();
    for (const r of records as WipRecord[]) {
      if (r.active === false) continue;
      const cat = (r.category || "TLT").toUpperCase();
      if (cat === "NTLT") continue;
      const key = `${r.job}${KEY_SEP}${r.structure}`;
      present.add(key);
      const act = (r.activity || "").toUpperCase();
      if (GALV_SET.has(act)) {
        galv.set(key, (galv.get(key) ?? 0) + (r.balanceWt || 0) / 1000);
      }
    }
    return { galvByKey: galv, presentKeys: present };
  }, [records]);

  const rows = useMemo<FgComputedRow[]>(() => {
    const all = order?.rows ?? [];
    const filtered = filters.job ? all.filter((r) => r.project === filters.job) : all;
    return filtered.map((r) => {
      const key = `${r.project}${KEY_SEP}${r.structure}`;
      const wipGalvMt = presentKeys.has(key) ? galvByKey.get(key) ?? 0 : null;
      return {
        project: r.project,
        structure: r.structure,
        releaseMt: r.releaseMt,
        fileDespatchMt: r.fileDespatchMt,
        computedFgMt:
          r.fileGalvMt == null ? null : r.fileGalvMt - (r.fileDespatchMt ?? 0),
        computedFgWipMt:
          wipGalvMt == null ? null : wipGalvMt - (r.fileDespatchMt ?? 0),
      };
    });
  }, [order, filters.job, galvByKey, presentKeys]);

  return {
    available: order?.available ?? false,
    asOnDate: order?.asOnDate ?? null,
    rows,
    isLoading: orderLoading || recordsLoading,
  };
}
