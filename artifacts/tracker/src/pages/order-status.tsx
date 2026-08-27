import { useMemo, useState } from "react";
import { formatDate } from "@/lib/utils";
import { useTracker, useActiveJobSet } from "@/lib/store";
import { useProjectCompare } from "@/lib/projectSort";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type Record as WipRecord,
} from "@workspace/api-client-react";
import { buildOrderStatusRows, type OrderStatusDisplayRow } from "@/lib/order-status-rows";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportToXlsx, exportTimestamp, type XlsxColumn } from "@/lib/export";
import {
  FileSpreadsheet,
  PackageCheck,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

function dispMt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toFixed(3);
}

export default function OrderStatusView() {
  const { filters, selectedImportId } = useTracker();
  const compareProjects = useProjectCompare();
  const isNtlt = filters.category === "NTLT";

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

  const activeJobSet = useActiveJobSet();
  const rows = useMemo(
    () => buildOrderStatusRows({
      records: records as WipRecord[],
      orderRows: order?.rows ?? [],
      filters,
      activeJobSet,
      compareProjects,
    }),
    [records, order?.rows, filters, activeJobSet, compareProjects],
  );

  // Per-project subtotals for the grouped table.
  const groups = useMemo(() => {
    const byProject = new Map<string, OrderStatusDisplayRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project) ?? [];
      list.push(r);
      byProject.set(r.project, list);
    }
    return Array.from(byProject.entries()).map(([project, list]) => {
      const subtotal = list.reduce(
        (acc, r) => {
          acc.sets += r.sets ?? 0;
          acc.weightMt += r.weightMt ?? 0;
          acc.woOrderQtyMt += r.woOrderQtyMt ?? 0;
          acc.releaseMt += r.releaseMt ?? 0;
          acc.releaseBalanceMt += r.releaseBalanceMt ?? 0;
          acc.fabMt += r.fabMt ?? 0;
          acc.galvMt += r.galvMt ?? 0;
          acc.fileDespatchMt += r.fileDespatchMt ?? 0;
          acc.dispatchBalanceMt += r.dispatchBalanceMt ?? 0;
          return acc;
        },
        {
          sets: 0,
          weightMt: 0,
          woOrderQtyMt: 0,
          releaseMt: 0,
          releaseBalanceMt: 0,
          fabMt: 0,
          galvMt: 0,
          fileDespatchMt: 0,
          dispatchBalanceMt: 0,
        },
      );
      return { project, list, subtotal };
    });
  }, [rows]);

  const totals = useMemo(() => {
    const base = rows.reduce(
      (acc, r) => {
        acc.sets += r.sets ?? 0;
        acc.weightMt += r.weightMt ?? 0;
        acc.woOrderQtyMt += r.woOrderQtyMt ?? 0;
        acc.releaseMt += r.releaseMt ?? 0;
        acc.releaseBalanceMt += r.releaseBalanceMt ?? 0;
        acc.fabMt += r.fabMt ?? 0;
        acc.galvMt += r.galvMt ?? 0;
        acc.fileDespatchMt += r.fileDespatchMt ?? 0;
        acc.dispatchBalanceMt += r.dispatchBalanceMt ?? 0;
        return acc;
      },
      {
        sets: 0,
        weightMt: 0,
        woOrderQtyMt: 0,
        releaseMt: 0,
        releaseBalanceMt: 0,
        fabMt: 0,
        galvMt: 0,
        fileDespatchMt: 0,
        dispatchBalanceMt: 0,
      },
    );
    return base;
  }, [rows]);

  function onExport() {
    const cols: XlsxColumn[] = [
      { label: "Project Code", field: "project" },
      { label: "Structure Type", field: "structure" },
      { label: "Sub Type", field: "subType" },
      { label: "Sets", field: "sets", numeric: true, decimals: 0 },
      { label: "Weight (MT)", field: "weightMt", numeric: true, decimals: 3, total: true },
      { label: "WO Order Qty (MT)", field: "woOrderQtyMt", numeric: true, decimals: 3, total: true },
      { label: "BOM Type", field: "bomType" },
      { label: "Release (MT)", field: "releaseMt", numeric: true, decimals: 3 },
      { label: "Release Balance (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
      { label: "Scope", field: "scope" },
      { label: "Fabrication (MT)", field: "fabMt", numeric: true, decimals: 3, total: true },
      { label: "Galvanizing (MT)", field: "galvMt", numeric: true, decimals: 3, total: true },
      { label: "Dispatch (MT)", field: "fileDespatchMt", numeric: true, decimals: 3, total: true },
      { label: "Dispatch Balance (MT)", field: "dispatchBalanceMt", numeric: true, decimals: 3, total: true },
    ];
    const out = rows.map((r) => ({
      project: r.project,
      structure: r.structure,
      subType: r.subType ?? "",
      sets: r.sets ?? "",
      weightMt: r.weightMt ?? "",
      woOrderQtyMt: r.woOrderQtyMt ?? "",
      bomType: r.bomType ?? "",
      releaseMt: r.releaseMt ?? "",
      releaseBalanceMt: r.releaseBalanceMt ?? "",
      scope: r.outOfScope ? "NTLT (out of scope)" : "TLT",
      fabMt: r.fabMt ?? "",
      galvMt: r.galvMt ?? "",
      fileDespatchMt: r.fileDespatchMt ?? "",
      dispatchBalanceMt: r.dispatchBalanceMt ?? "",
    }));
    void exportToXlsx(
      `order_status_${exportTimestamp()}.xlsx`,
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
            file, joined to live Fabrication / Galvanizing tonnage computed from the
            selected WIP report, and Dispatch (MT) from the file.
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
              populate this view. Fabrication / Galvanizing tonnage will still
              appear from WIP marks below.
            </p>
          </CardContent>
        </Card>
      )}

      {isNtlt && (
        <Card className="border-amber-500/40">
          <CardContent className="py-3 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              Order Status is a TLT view. NTLT marks are out of scope: their
              Fabrication / Galvanizing tonnage is not computed and shows as
              "n/a". Switch the Order Type to TLT or All for bundle math.
            </span>
          </CardContent>
        </Card>
      )}

      {available && order?.fileImport && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile label="Order Wt (MT)" value={mt(totals.weightMt)} />
          <KpiTile label="In Fabrication (MT)" value={mt(totals.fabMt)} />
          <KpiTile label="In Galvanizing (MT)" value={mt(totals.galvMt)} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Structures{order?.asOnDate ? ` — file as on ${formatDate(order.asOnDate)}` : ""}
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
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted sticky top-0 z-10">
                  <tr className="text-left">
                    <th className="px-2 py-1.5 font-semibold">Structure Type</th>
                    <th className="px-2 py-1.5 font-semibold">Sub Type</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Sets</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Weight</th>
                    <th className="px-2 py-1.5 font-semibold text-right">WO Order Qty</th>
                    <th className="px-2 py-1.5 font-semibold">BOM Type</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Release</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Release Bal.</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Fabrication</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Galvanizing</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Dispatch</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Dispatch Bal.</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <ProjectGroup key={g.project} group={g} />
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted font-semibold sticky bottom-0 z-10">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={2}>Total ({rows.length})</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{totals.sets.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.weightMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.woOrderQtyMt)}</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.releaseMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.releaseBalanceMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.fabMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.galvMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{dispMt(totals.fileDespatchMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{dispMt(totals.dispatchBalanceMt)}</td>
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
    list: OrderStatusDisplayRow[];
    subtotal: {
      sets: number;
      weightMt: number;
      woOrderQtyMt: number;
      releaseMt: number;
      releaseBalanceMt: number;
      fabMt: number;
      galvMt: number;
      fileDespatchMt: number;
      dispatchBalanceMt: number;
    };
  };
}) {
  const { project, list, subtotal } = group;
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="border-b border-primary/20 bg-primary/10 hover:bg-primary/15 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <td colSpan={2} className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-4 w-4 text-primary shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-primary shrink-0" />
            )}
            <span className="font-bold text-foreground tracking-wide">
              {project}
            </span>
            <span className="text-[10px] uppercase text-muted-foreground">
              {list.length} structure{list.length === 1 ? "" : "s"}
            </span>
          </div>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{subtotal.sets.toLocaleString()}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.weightMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.woOrderQtyMt)}</td>
        <td className="px-2 py-1.5" />
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.releaseMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.releaseBalanceMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.fabMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.galvMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{dispMt(subtotal.fileDespatchMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{dispMt(subtotal.dispatchBalanceMt)}</td>
      </tr>
      {open &&
        list.map((r) => (
          <tr key={`${r.project}-${r.structure}`} className="border-b last:border-0 hover:bg-muted/30">
            <td className="px-2 py-1.5 pl-9">
              <span>{r.structure}</span>
              {!r.inFile && (
                <span className="ml-2 text-[10px] uppercase text-muted-foreground">WIP only</span>
              )}
              {!r.inWip && (
                <span className="ml-2 text-[10px] uppercase text-muted-foreground">file only</span>
              )}
              {r.outOfScope && (
                <span className="ml-2 text-[10px] uppercase text-amber-600 dark:text-amber-400">NTLT - out of scope</span>
              )}
              {r.notInLatest && (
                <span className="ml-2 text-[10px] uppercase text-rose-600 dark:text-rose-400">not in latest file</span>
              )}
              {r.noWipData && (
                <span className="ml-2 text-[10px] uppercase text-muted-foreground">not in WIP - fab/galv n/a</span>
              )}
            </td>
            <td className="px-2 py-1.5">{r.subType ?? "-"}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{r.sets ?? "-"}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.weightMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.woOrderQtyMt)}</td>
            <td className="px-2 py-1.5">{r.bomType ?? "-"}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.releaseMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.releaseBalanceMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{r.outOfScope ? "n/a" : mt(r.fabMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{r.outOfScope ? "n/a" : mt(r.galvMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{dispMt(r.fileDespatchMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{dispMt(r.dispatchBalanceMt)}</td>
          </tr>
        ))}
      {open && (
        <tr className="border-b bg-muted/10 text-xs">
          <td className="px-2 py-1 pl-9 font-medium text-muted-foreground">Subtotal</td>
          <td className="px-2 py-1" />
          <td className="px-2 py-1" />
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.weightMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.woOrderQtyMt)}</td>
          <td className="px-2 py-1" />
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.releaseMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.releaseBalanceMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.fabMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.galvMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{dispMt(subtotal.fileDespatchMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{dispMt(subtotal.dispatchBalanceMt)}</td>
        </tr>
      )}
    </>
  );
}
