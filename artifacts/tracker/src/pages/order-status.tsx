import { useMemo, useState } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  useGetFg,
  getGetFgQueryKey,
  type OrderStatusRow,
  type Record as WipRecord,
} from "@workspace/api-client-react";
import { bundleActivitySet } from "@workspace/domain";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import {
  FileSpreadsheet,
  PackageCheck,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

// Activity buckets used to roll WIP marks into Fabrication / Galvanizing.
// Galvanizing spans the FULL GALVANIZING bundle (G,GB,Y) — Y (Yard/terminal) is
// folded in here rather than kept in a separate column. Everything else still in
// the route is Fabrication (this naturally captures the NTLT pre-galv fab codes).
const GALV_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();

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
}

interface DisplayRow {
  project: string;
  structure: string;
  subType: string | null;
  bomType: string | null;
  sets: number | null;
  weightMt: number | null;
  woOrderQtyMt: number | null;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  // Balances from WO Order Qty (col J): J - Release (L) and J - File Despatch (Q).
  // Null when WO Order Qty is blank (no ordered base to net against).
  releaseBalanceMt: number | null;
  dispatchBalanceMt: number | null;
  // Bundle tonnage is TLT-only. For an out-of-scope (NTLT) structure these are
  // null and rendered "n/a" — NTLT marks never contribute Fab/Galv math.
  fabMt: number | null;
  galvMt: number | null;
  // Finished Good (computed): the stored Computed FG for this (project,
  // structure) = Release - all-activity WIP balance - Dispatch. Order-book
  // sourced and category-independent, so shown even for out-of-scope rows; null
  // when the structure has no computed FG (absent from the order book).
  computedFgMt: number | null;
  inFile: boolean;
  inWip: boolean;
  // The structure has NTLT marks whose bundle math is intentionally suppressed.
  outOfScope: boolean;
  // Fab/Galv shown for this row come from the Order Review file's Progress block
  // (the structure is absent from WIP), not from live WIP marks. Tagged in the UI
  // because file figures are cumulative-done, not current-at-stage like WIP.
  bundleFromFile: boolean;
  // The order row exists in the order book but was absent from the latest Order
  // Review upload (kept, never deleted — flagged for review).
  notInLatest: boolean;
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

  const { data: fg } = useGetFg({ query: { queryKey: getGetFgQueryKey() } });

  const isNtlt = filters.category === "NTLT";
  const isAll = filters.category === "ALL";

  // WIP records narrowed to the active dimension selections (project / structure
  // / order-type mode). Activity and contractor filters are intentionally NOT
  // applied here — the Fabrication / Galvanizing columns ARE activity
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

  // Roll WIP marks into per (project, structure) Fab / Galv tonnages (balanceWt
  // is kilograms; /1000 -> metric tonnes). Galvanizing spans G,GB,Y. Bundle math
  // is TLT-only: NTLT marks are OUT OF SCOPE for Order Status — they never
  // contribute to the Fab/Galv buckets. We still record their key so the
  // structure can be flagged "out of scope" in the table.
  const { computedByKey, ntltKeys } = useMemo(() => {
    const m = new Map<string, ComputedBuckets>();
    const ntlt = new Set<string>();
    for (const r of scopedRecords) {
      const k = keyOf(r.job, r.structure);
      const cat = (r.category || "TLT").toUpperCase();
      if (cat === "NTLT") {
        // Out of scope: suppress all bundle tonnage for NTLT marks.
        ntlt.add(k);
        continue;
      }
      let agg = m.get(k);
      if (!agg) {
        agg = { fabMt: 0, galvMt: 0 };
        m.set(k, agg);
      }
      const tonnes = (r.balanceWt || 0) / 1000;
      const act = (r.activity || "").toUpperCase();
      if (GALV_SET.has(act)) agg.galvMt += tonnes;
      else agg.fabMt += tonnes;
    }
    return { computedByKey: m, ntltKeys: ntlt };
  }, [scopedRecords]);

  // Category-INDEPENDENT WIP presence: a structure counts as "in the WIP report"
  // if it has ANY active WIP mark (any order-type), respecting only the job /
  // structure display filters. computedByKey is order-type-mode scoped, so it
  // cannot decide true WIP absence (a present structure hidden by the current
  // mode would look absent). The file Fab/Galv fallback is gated on THIS set so
  // toggling the order-type mode never mistakes a present structure for absent.
  const wipKeys = useMemo(() => {
    const s = new Set<string>();
    for (const r of records as WipRecord[]) {
      if (r.active === false) continue;
      if (filters.job && r.job !== filters.job) continue;
      if (filters.structure && r.structure !== filters.structure) continue;
      s.add(keyOf(r.job, r.structure));
    }
    return s;
  }, [records, filters.job, filters.structure]);

  const dispatchByKey = useMemo(() => {
    const m = new Map<string, OrderStatusRow>();
    for (const r of order?.rows ?? []) m.set(keyOf(r.project, r.structure), r);
    return m;
  }, [order]);

  // Computed FG per (project, structure), joined from the /fg endpoint. Stored,
  // order-book sourced, and category-independent.
  const fgByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of fg?.rows ?? []) {
      m.set(keyOf(r.project, r.structure), r.computedFgMt);
    }
    return m;
  }, [fg]);

  // Union of file rows and WIP-derived keys, filtered by the active project /
  // structure selections so the table tracks the global filter bar.
  const rows = useMemo<DisplayRow[]>(() => {
    const keys = new Set<string>([
      ...dispatchByKey.keys(),
      ...computedByKey.keys(),
      ...ntltKeys,
    ]);
    const out: DisplayRow[] = [];
    for (const k of keys) {
      const file = dispatchByKey.get(k);
      const comp = computedByKey.get(k);
      const [project, structure] = k.split(KEY_SEP);
      if (filters.job && project !== filters.job) continue;
      if (filters.structure && structure !== filters.structure) continue;
      // A structure is out of scope when it has NTLT marks but no TLT bundle
      // tonnage (NTLT-only). Its Fab/Galv are not computed -> null (n/a).
      const outOfScope = ntltKeys.has(k) && !comp;
      // TRUE WIP absence (any order-type), not just "absent from the current
      // mode's computed buckets". A structure present in WIP must never use the
      // file fallback even when the active mode hides its marks.
      const inWipReport = wipKeys.has(k);
      // When a structure is genuinely absent from WIP, fall back to the order
      // file's Progress Fabrication / Galvanising so it no longer reads 0. Tagged
      // so the file-sourced (cumulative-done) figures aren't read as live WIP
      // balances.
      const bundleFromFile =
        !outOfScope &&
        !inWipReport &&
        !!file &&
        (file.fileFabMt != null || file.fileGalvMt != null);
      out.push({
        project,
        structure,
        subType: file?.subType ?? null,
        bomType: file?.bomType ?? null,
        sets: file?.sets ?? null,
        weightMt: file?.weightMt ?? null,
        woOrderQtyMt: file?.woOrderQtyMt ?? null,
        releaseMt: file?.releaseMt ?? null,
        fileDespatchMt: file?.fileDespatchMt ?? null,
        releaseBalanceMt: file?.releaseBalanceMt ?? null,
        dispatchBalanceMt: file?.dispatchBalanceMt ?? null,
        // comp -> live WIP buckets; else in-WIP-but-mode-hidden -> 0; else truly
        // absent -> file Progress.
        fabMt: outOfScope
          ? null
          : comp
            ? comp.fabMt
            : inWipReport
              ? 0
              : file?.fileFabMt ?? null,
        galvMt: outOfScope
          ? null
          : comp
            ? comp.galvMt
            : inWipReport
              ? 0
              : file?.fileGalvMt ?? null,
        computedFgMt: fgByKey.get(k) ?? null,
        inFile: !!file,
        inWip: !!comp,
        outOfScope,
        bundleFromFile,
        notInLatest: file?.notInLatest ?? false,
      });
    }
    out.sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.structure.localeCompare(b.structure),
    );
    return out;
  }, [
    dispatchByKey,
    computedByKey,
    fgByKey,
    ntltKeys,
    wipKeys,
    filters.job,
    filters.structure,
  ]);

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
          acc.sets += r.sets ?? 0;
          acc.weightMt += r.weightMt ?? 0;
          acc.woOrderQtyMt += r.woOrderQtyMt ?? 0;
          acc.releaseMt += r.releaseMt ?? 0;
          acc.releaseBalanceMt += r.releaseBalanceMt ?? 0;
          acc.fabMt += r.fabMt ?? 0;
          acc.galvMt += r.galvMt ?? 0;
          acc.computedFgMt += r.computedFgMt ?? 0;
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
          computedFgMt: 0,
          fileDespatchMt: 0,
          dispatchBalanceMt: 0,
        },
      );
      return { project, list, subtotal };
    });
  }, [rows]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.sets += r.sets ?? 0;
        acc.weightMt += r.weightMt ?? 0;
        acc.woOrderQtyMt += r.woOrderQtyMt ?? 0;
        acc.releaseMt += r.releaseMt ?? 0;
        acc.releaseBalanceMt += r.releaseBalanceMt ?? 0;
        acc.fabMt += r.fabMt ?? 0;
        acc.galvMt += r.galvMt ?? 0;
        acc.computedFgMt += r.computedFgMt ?? 0;
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
        computedFgMt: 0,
        fileDespatchMt: 0,
        dispatchBalanceMt: 0,
      },
    );
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
      { label: "Finished Good (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
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
      computedFgMt: r.computedFgMt ?? "",
      fileDespatchMt: r.fileDespatchMt ?? "",
      dispatchBalanceMt: r.dispatchBalanceMt ?? "",
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
            file, joined to live Fabrication / Galvanizing tonnage computed from the
            selected WIP report, Dispatch (MT) from the file, and Finished Good
            (computed).
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
          <KpiTile label="Finished Good (MT)" value={mt(totals.computedFgMt)} />
        </div>
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
                    <th className="px-2 py-1.5 font-semibold text-right">Finished Good</th>
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
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.computedFgMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.fileDespatchMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{mt(totals.dispatchBalanceMt)}</td>
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
      sets: number;
      weightMt: number;
      woOrderQtyMt: number;
      releaseMt: number;
      releaseBalanceMt: number;
      fabMt: number;
      galvMt: number;
      computedFgMt: number;
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
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.computedFgMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.fileDespatchMt)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-bold">{mt(subtotal.dispatchBalanceMt)}</td>
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
              {r.bundleFromFile && (
                <span className="ml-2 text-[10px] uppercase text-sky-600 dark:text-sky-400">fab/galv from order sheet</span>
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
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.computedFgMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.fileDespatchMt)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{mt(r.dispatchBalanceMt)}</td>
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
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.computedFgMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.fileDespatchMt)}</td>
          <td className="px-2 py-1 text-right tabular-nums font-medium">{mt(subtotal.dispatchBalanceMt)}</td>
        </tr>
      )}
    </>
  );
}
