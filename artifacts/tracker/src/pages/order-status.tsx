import { useMemo } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type OrderStatusRow,
  type Record as WipRecord,
} from "@workspace/api-client-react";
import { bundleActivitySet } from "@workspace/domain";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import { FileSpreadsheet, PackageCheck, AlertTriangle } from "lucide-react";

// Activity buckets used to roll WIP marks into Fabrication / Galvanizing / Yard.
// Galvanizing = G,GB; Yard = Y (terminal). Everything else still in the route is
// Fabrication (this naturally captures the NTLT pre-galv fab codes too).
const GALV_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();
const YARD_SET = bundleActivitySet("YARD") ?? new Set<string>();

const KEY_SEP = "\u0001";
function keyOf(project: string, structure: string): string {
  return `${project}${KEY_SEP}${structure}`;
}

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

interface ComputedBuckets {
  fabMt: number;
  galvMt: number;
  yardMt: number;
}

interface DisplayRow extends ComputedBuckets {
  project: string;
  structure: string;
  subType: string | null;
  sets: number | null;
  weightMt: number | null;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  computedDispatchMt: number;
  inFile: boolean;
  inWip: boolean;
}

export default function OrderStatusView() {
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

  const isNtlt = filters.category === "NTLT";
  const isAll = filters.category === "ALL";

  // WIP records narrowed to the active dimension selections (project / structure
  // / order-type mode). Activity and contractor filters are intentionally NOT
  // applied here — the Fabrication / Galvanizing / Yard columns ARE activity
  // partitions, so filtering by a single activity would make them meaningless.
  const scopedRecords = useMemo(() => {
    return records.filter((r: WipRecord) => {
      if (r.active === false) return false;
      if (!isAll && (r.category || "TLT") !== filters.category) return false;
      if (filters.job && r.job !== filters.job) return false;
      if (filters.structure && r.structure !== filters.structure) return false;
      return true;
    });
  }, [records, isAll, filters.category, filters.job, filters.structure]);

  // Roll WIP marks into per (project, structure) Fab / Galv / Yard tonnages
  // (balanceWt is kilograms; /1000 -> metric tonnes).
  const computedByKey = useMemo(() => {
    const m = new Map<string, ComputedBuckets>();
    for (const r of scopedRecords) {
      const k = keyOf(r.job, r.structure);
      let agg = m.get(k);
      if (!agg) {
        agg = { fabMt: 0, galvMt: 0, yardMt: 0 };
        m.set(k, agg);
      }
      const tonnes = (r.balanceWt || 0) / 1000;
      const act = (r.activity || "").toUpperCase();
      if (YARD_SET.has(act)) agg.yardMt += tonnes;
      else if (GALV_SET.has(act)) agg.galvMt += tonnes;
      else agg.fabMt += tonnes;
    }
    return m;
  }, [scopedRecords]);

  const dispatchByKey = useMemo(() => {
    const m = new Map<string, OrderStatusRow>();
    for (const r of order?.rows ?? []) m.set(keyOf(r.project, r.structure), r);
    return m;
  }, [order]);

  // Union of file rows and WIP-derived keys, filtered by the active project /
  // structure selections so the table tracks the global filter bar.
  const rows = useMemo<DisplayRow[]>(() => {
    const keys = new Set<string>([
      ...dispatchByKey.keys(),
      ...computedByKey.keys(),
    ]);
    const out: DisplayRow[] = [];
    for (const k of keys) {
      const file = dispatchByKey.get(k);
      const comp = computedByKey.get(k);
      const [project, structure] = k.split(KEY_SEP);
      if (filters.job && project !== filters.job) continue;
      if (filters.structure && structure !== filters.structure) continue;
      out.push({
        project,
        structure,
        subType: file?.subType ?? null,
        sets: file?.sets ?? null,
        weightMt: file?.weightMt ?? null,
        releaseMt: file?.releaseMt ?? null,
        fileDespatchMt: file?.fileDespatchMt ?? null,
        computedDispatchMt: file?.computedDispatchMt ?? 0,
        fabMt: comp?.fabMt ?? 0,
        galvMt: comp?.galvMt ?? 0,
        yardMt: comp?.yardMt ?? 0,
        inFile: !!file,
        inWip: !!comp,
      });
    }
    out.sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.structure.localeCompare(b.structure),
    );
    return out;
  }, [dispatchByKey, computedByKey, filters.job, filters.structure]);

  // Per-project subtotals for the grouped table.
  const groups = useMemo(() => {
    const byProject = new Map<string, DisplayRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project) ?? [];
      list.push(r);
      byProject.set(r.project, list);
    }
    return Array.from(byProject.entries()).map(([project, list]) => {
      const subtotal = list.reduce(
        (acc, r) => {
          acc.weightMt += r.weightMt ?? 0;
          acc.fabMt += r.fabMt;
          acc.galvMt += r.galvMt;
          acc.yardMt += r.yardMt;
          acc.fileDespatchMt += r.fileDespatchMt ?? 0;
          acc.computedDispatchMt += r.computedDispatchMt;
          return acc;
        },
        {
          weightMt: 0,
          fabMt: 0,
          galvMt: 0,
          yardMt: 0,
          fileDespatchMt: 0,
          computedDispatchMt: 0,
        },
      );
      return { project, list, subtotal };
    });
  }, [rows]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.weightMt += r.weightMt ?? 0;
        acc.fabMt += r.fabMt;
        acc.galvMt += r.galvMt;
        acc.yardMt += r.yardMt;
        acc.fileDespatchMt += r.fileDespatchMt ?? 0;
        acc.computedDispatchMt += r.computedDispatchMt;
        return acc;
      },
      {
        weightMt: 0,
        fabMt: 0,
        galvMt: 0,
        yardMt: 0,
        fileDespatchMt: 0,
        computedDispatchMt: 0,
      },
    );
  }, [rows]);

  function onExport() {
    const cols: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Structure", field: "structure" },
      { label: "Sub-type", field: "subType" },
      { label: "Sets", field: "sets", numeric: true, decimals: 0 },
      { label: "Order Wt (MT)", field: "weightMt", numeric: true, decimals: 3, total: true },
      { label: "Release (MT)", field: "releaseMt", numeric: true, decimals: 3 },
      { label: "Fabrication (MT)", field: "fabMt", numeric: true, decimals: 3, total: true },
      { label: "Galvanizing (MT)", field: "galvMt", numeric: true, decimals: 3, total: true },
      { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
      { label: "File Dispatch (MT)", field: "fileDespatchMt", numeric: true, decimals: 3, total: true },
      { label: "Computed Dispatch (MT)", field: "computedDispatchMt", numeric: true, decimals: 3, total: true },
    ];
    const out = rows.map((r) => ({
      project: r.project,
      structure: r.structure,
      subType: r.subType ?? "",
      sets: r.sets ?? "",
      weightMt: r.weightMt ?? "",
      releaseMt: r.releaseMt ?? "",
      fabMt: r.fabMt,
      galvMt: r.galvMt,
      yardMt: r.yardMt,
      fileDespatchMt: r.fileDespatchMt ?? "",
      computedDispatchMt: r.computedDispatchMt,
    }));
    void exportToXlsx(
      `order_status_${new Date().toISOString().slice(0, 10)}.xlsx`,
      cols,
      out,
      { sheetName: "Order Status" },
    );
  }

  const available = order?.available ?? false;
  const loading = orderLoading || recordsLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Order Status</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Per project and structure: order quantities from the latest Order Review
            file, joined to live Fabrication / Galvanizing / Yard tonnage computed
            from the selected WIP report, and running Dispatch.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          disabled={rows.length === 0}
          className="gap-2 shrink-0"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Export
        </Button>
      </div>

      {!available && !loading && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <PackageCheck className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No Order Review file ingested yet</p>
            <p className="text-sm mt-1">
              Upload an Order Review export on the Data page to seed dispatch and
              populate this view. Fabrication / Galvanizing / Yard tonnage will
              still appear from WIP marks below.
            </p>
          </CardContent>
        </Card>
      )}

      {available && order?.fileImport && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile label="Order Wt (MT)" value={mt(totals.weightMt)} />
          <KpiTile label="In Fabrication (MT)" value={mt(totals.fabMt)} />
          <KpiTile label="In Galvanizing (MT)" value={mt(totals.galvMt)} />
          <KpiTile label="In Yard (MT)" value={mt(totals.yardMt)} />
        </div>
      )}

      {available && order && order.reconciliation.mismatched > 0 && (
        <Card className="border-amber-500/40">
          <CardContent className="py-3 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              {order.reconciliation.mismatched} structure
              {order.reconciliation.mismatched === 1 ? "" : "s"} differ between the
              file dispatch and the computed dispatch beyond the
              {" "}
              {order.reconciliation.tolerancePct}% tolerance. See the
              reconciliation tab on the Data page.
            </span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Structures{order?.asOnDate ? ` — file as on ${order.asOnDate}` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground text-sm">
              Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground text-sm">
              No data for the selected filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold">Structure</th>
                    <th className="px-3 py-2 font-semibold text-right">Sets</th>
                    <th className="px-3 py-2 font-semibold text-right">Order Wt</th>
                    <th className="px-3 py-2 font-semibold text-right">Release</th>
                    <th className="px-3 py-2 font-semibold text-right">Fabrication</th>
                    <th className="px-3 py-2 font-semibold text-right">Galvanizing</th>
                    <th className="px-3 py-2 font-semibold text-right">Yard</th>
                    <th className="px-3 py-2 font-semibold text-right">File Dispatch</th>
                    <th className="px-3 py-2 font-semibold text-right">Computed Dispatch</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <ProjectGroup key={g.project} group={g} />
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/60 font-semibold">
                  <tr>
                    <td className="px-3 py-2">Total ({rows.length})</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.weightMt)}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.fabMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.galvMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.yardMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.fileDespatchMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt(totals.computedDispatchMt)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
        <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function ProjectGroup({
  group,
}: {
  group: {
    project: string;
    list: DisplayRow[];
    subtotal: {
      weightMt: number;
      fabMt: number;
      galvMt: number;
      yardMt: number;
      fileDespatchMt: number;
      computedDispatchMt: number;
    };
  };
}) {
  const { project, list, subtotal } = group;
  return (
    <>
      <tr className="bg-muted/20 border-b">
        <td colSpan={9} className="px-3 py-1.5 font-semibold text-xs uppercase tracking-wide text-muted-foreground">
          {project}
        </td>
      </tr>
      {list.map((r) => (
        <tr key={`${r.project}-${r.structure}`} className="border-b last:border-0 hover:bg-muted/30">
          <td className="px-3 py-2">
            <span>{r.structure}</span>
            {!r.inFile && (
              <span className="ml-2 text-[10px] uppercase text-muted-foreground">WIP only</span>
            )}
            {!r.inWip && (
              <span className="ml-2 text-[10px] uppercase text-muted-foreground">file only</span>
            )}
            {r.subType && (
              <span className="ml-2 text-[10px] uppercase text-sky-600 dark:text-sky-400">{r.subType}</span>
            )}
          </td>
          <td className="px-3 py-2 text-right tabular-nums">{r.sets ?? "-"}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.weightMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.releaseMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.fabMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.galvMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.yardMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.fileDespatchMt)}</td>
          <td className="px-3 py-2 text-right tabular-nums">{mt(r.computedDispatchMt)}</td>
        </tr>
      ))}
      <tr className="border-b bg-muted/10 text-xs">
        <td className="px-3 py-1.5 font-medium text-muted-foreground">Subtotal</td>
        <td className="px-3 py-1.5" />
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.weightMt)}</td>
        <td className="px-3 py-1.5" />
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.fabMt)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.galvMt)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.yardMt)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.fileDespatchMt)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{mt(subtotal.computedDispatchMt)}</td>
      </tr>
    </>
  );
}
