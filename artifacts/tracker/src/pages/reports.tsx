import { useMemo, useState } from "react";
import {
  activityRank,
  compareActivity,
  FAB_LOAD_COLUMNS,
  FAB_LOAD_SECTIONS,
  FAB_PRIORITIES,
  lifecycleStatus,
  migrateTurnaroundSettings,
  normalizeActivity,
  scopeFor,
  sequenceFor,
  type FabLoadColumn,
  type FabLoadSection,
} from "@workspace/domain";
import { useSettings } from "@/lib/settings";
import { LIFECYCLE_LABELS, lifecycleTextColor } from "@/lib/turnaround";
import { useStalledInfo } from "@/lib/movement";
import {
  useVelocityInfo,
  VELOCITY_LABELS,
  velocityStatusColor,
  TREND_LABELS,
  trendArrow,
  fmtDays,
} from "@/lib/velocity";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  useListFabricationPriorities,
  useUpsertFabricationPriority,
  useDeleteFabricationPriority,
  getListFabricationPrioritiesQueryKey,
  type Record as ApiRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  exportToXlsxSheets,
  exportToCsv,
  type XlsxColumn,
  type XlsxSummaryRow,
} from "@/lib/export";
import { formatWeight } from "@/lib/utils";
import { ageingCell } from "@/lib/ageing";
import { getAgeingColor } from "./overview";
import { AiTurnaroundReport } from "@/components/ai-turnaround-report";
import PlantOperationView from "./plant-operation";
import { FileSpreadsheet, Check, Eye, EyeOff } from "lucide-react";

type SortKey = "activity" | "ageing" | "contractor";

type ReportType = "jobwise" | "fabload" | "plantop" | "ai";

const REPORT_TYPES: { id: ReportType; name: string; description: string }[] = [
  {
    id: "jobwise",
    name: "Job Wise Report",
    description:
      "Pending work filtered by the header filters, with turnaround and velocity columns, exportable to Excel.",
  },
  {
    id: "fabload",
    name: "Fabrication Load for TLT",
    description:
      "TLT fabrication load by project and weight (tonnes), split into Operational Load (at the operation) and In Hand (before it), with a per-row Priority.",
  },
  {
    id: "plantop",
    name: "Plant Operation Wise",
    description:
      "Fabrication and galvanization grouped by project and contractor, with hole-operation breakdown and weights, exportable to Excel.",
  },
  {
    id: "ai",
    name: "AI Report",
    description:
      "AI turnaround analysis with red flags, bottlenecks and an action plan, exportable to PDF/JSON.",
  },
];

const SORT_OPTIONS: { id: SortKey; name: string }[] = [
  { id: "activity", name: "Activity" },
  { id: "ageing", name: "Ageing" },
  { id: "contractor", name: "Contractor" },
];

// Controls the exported .xlsx. Numeric columns are right-aligned and number
// formatted; Balance Qty/Wt carry a totals-row SUM. Wt stays in raw kg numbers.
const REPORT_COLUMNS: XlsxColumn[] = [
  { label: "Activity", field: "activity" },
  { label: "Section", field: "section" },
  { label: "Mark No.", field: "markId" },
  { label: "Length", field: "length", numeric: true, decimals: 2 },
  { label: "Width", field: "width", numeric: true, decimals: 2 },
  { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
  { label: "Balance Wt (kg)", field: "balanceWt", numeric: true, decimals: 2, total: true },
  { label: "Contractor", field: "contractor" },
  { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
  { label: "Cumulative Target (days)", field: "cumulativeTarget", numeric: true, decimals: 0 },
  { label: "Overrun (days)", field: "overrun", numeric: true, decimals: 0 },
  { label: "Consumed %", field: "consumedPct", numeric: true, decimals: 0 },
  { label: "Days to Target", field: "daysToTarget", numeric: true, decimals: 0 },
  { label: "Lifecycle Status", field: "lifecycleStatus" },
  { label: "Stalled", field: "stalledLabel" },
  { label: "Velocity Status", field: "velocityStatusLabel" },
  { label: "Days / Stage", field: "daysPerStage", numeric: true, decimals: 1 },
  { label: "ETA (days)", field: "etaDays", numeric: true, decimals: 1 },
  { label: "ETA Gap (days)", field: "etaGap", numeric: true, decimals: 1 },
  { label: "Trend", field: "trendLabel" },
  { label: "Section Type", field: "sectionType" },
  { label: "Hole Operation", field: "holeOperationLabel" },
];

// Derived hole-operation display labels (no emojis).
const HOLE_OP_LABELS: Record<string, string> = {
  PUNCHING: "Punching",
  DRILLING: "Drilling",
  NOT_SET: "Not set",
};
const HOLE_OP_ORDER = ["PUNCHING", "DRILLING", "NOT_SET"] as const;

const COL_COUNT = REPORT_COLUMNS.length;
const TABLE_CAP = 500;

function num(v: number | null | undefined): string {
  if (v == null) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ReportBuilder() {
  const { selectedImportId, filters } = useTracker();
  const { settings: rawSettings } = useSettings();
  // Defensive: classify/export on normalized (validated, band-ordered) settings.
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: selectedImportId != null,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });

  // Driven entirely by the universal header filters (job, activity,
  // contractor, structure, mark, search, date) — no report-local filters.
  const unsorted = useFilteredRecords(allRecords);

  const [sortBy, setSortBy] = useState<SortKey>("activity");
  const [showItemwise, setShowItemwise] = useState(true);

  // Sort the report rows by the selected key. Activity uses the canonical
  // process sequence (@workspace/domain); ageing is oldest-first; contractor
  // is alphabetical. The same order drives both this table and the export.
  const rows = useMemo(() => {
    const arr = [...unsorted];
    if (sortBy === "activity") {
      arr.sort(
        (a, b) =>
          compareActivity(a.activity, b.activity) ||
          String(a.markId ?? "").localeCompare(String(b.markId ?? "")),
      );
    } else if (sortBy === "ageing") {
      arr.sort((a, b) => (b.ageingDays ?? -1) - (a.ageingDays ?? -1));
    } else {
      arr.sort(
        (a, b) =>
          String(a.contractor ?? "").localeCompare(String(b.contractor ?? "")) ||
          String(a.markId ?? "").localeCompare(String(b.markId ?? "")),
      );
    }
    return arr;
  }, [unsorted, sortBy]);

  // Enrich each row with the turnaround classification (cumulative target,
  // overrun, alert status) for the table + export. Advisory/display only — does
  // not touch ageing, activity, or any computed engine field.
  const stalled = useStalledInfo(selectedImportId ?? null);
  const velocity = useVelocityInfo(selectedImportId ?? null);

  const enrichedRows = useMemo(
    () =>
      rows.map((r) => {
        const res = lifecycleStatus(
          { activity: r.activity, ageingDays: r.ageingDays, scope: scopeFor(r), sequence: sequenceFor(r) },
          settings,
        );
        const isStalled = stalled.isStalled(r.markId, r.jobCardNo);
        const v = velocity.velocityFor(r.markId, r.jobCardNo);
        return {
          ...r,
          cumulativeTarget: res.target,
          overrun: res.overrun,
          consumedPct: res.consumedPct,
          daysToTarget: res.daysToTarget,
          lifecycleStatus: LIFECYCLE_LABELS[res.status],
          lifecycleStatusRaw: res.status,
          stalled: isStalled,
          stalledLabel: isStalled ? "Yes" : "",
          velocityStatusRaw: v?.status ?? null,
          velocityStatusLabel: v ? VELOCITY_LABELS[v.status] : "",
          daysPerStage: v?.daysPerStage ?? null,
          etaDays: v?.etaDays ?? null,
          etaGap: v?.etaGap ?? null,
          trendLabel: v ? TREND_LABELS[v.trend] : "",
          trendRaw: v?.trend ?? null,
          holeOperationLabel: HOLE_OP_LABELS[r.holeOperation ?? "NOT_SET"] ?? "Not set",
        };
      }),
    [rows, settings, stalled, velocity],
  );

  const totalQty = rows.reduce((s, r) => s + (r.balanceQty ?? 0), 0);
  const totalWt = rows.reduce((s, r) => s + (r.balanceWt ?? 0), 0);

  // Per-activity subtotals (Qty + Wt) appended to the Excel export, ordered by
  // the canonical process sequence, under an "Activity-wise subtotal" heading.
  const activitySubtotals = useMemo<XlsxSummaryRow[]>(() => {
    const groups = new Map<
      string,
      { balanceQty: number; balanceWt: number; ageSum: number; ageCount: number }
    >();
    for (const r of rows) {
      const key = r.activity || "Unknown";
      const g = groups.get(key) ?? { balanceQty: 0, balanceWt: 0, ageSum: 0, ageCount: 0 };
      g.balanceQty += r.balanceQty ?? 0;
      g.balanceWt += r.balanceWt ?? 0;
      if (r.ageingDays != null) {
        g.ageSum += r.ageingDays;
        g.ageCount += 1;
      }
      groups.set(key, g);
    }
    const ordered = [...groups.keys()].sort(compareActivity);
    if (!ordered.length) return [];
    return [
      { label: "ACTIVITY-WISE SUBTOTAL", values: {} },
      ...ordered.map((act) => {
        const g = groups.get(act)!;
        const values: Record<string, number> = {
          balanceQty: g.balanceQty,
          balanceWt: g.balanceWt,
        };
        if (g.ageCount) values.ageingDays = Math.round(g.ageSum / g.ageCount);
        return { label: act, values };
      }),
    ];
  }, [rows]);

  // Hole-operation breakdown (marks + Qty + Wt) for both the Excel Summary sheet
  // and the on-screen chips. Derived/display only — coalesce null -> NOT_SET.
  const holeOpBreakdown = useMemo(() => {
    const groups = new Map<string, { marks: number; qty: number; wt: number }>();
    for (const r of rows) {
      const key = (r.holeOperation as string) || "NOT_SET";
      const g = groups.get(key) ?? { marks: 0, qty: 0, wt: 0 };
      g.marks += 1;
      g.qty += r.balanceQty ?? 0;
      g.wt += r.balanceWt ?? 0;
      groups.set(key, g);
    }
    return HOLE_OP_ORDER.filter((k) => groups.has(k)).map((k) => ({
      key: k,
      label: HOLE_OP_LABELS[k],
      ...groups.get(k)!,
    }));
  }, [rows]);

  const holeOpSubtotals = useMemo<XlsxSummaryRow[]>(() => {
    if (!holeOpBreakdown.length) return [];
    return [
      { label: "HOLE-OPERATION SUBTOTAL", values: {} },
      ...holeOpBreakdown.map((h) => ({
        label: h.label,
        values: { balanceQty: h.qty, balanceWt: h.wt } as Record<string, number>,
      })),
    ];
  }, [holeOpBreakdown]);

  // On-screen activity-wise subtotals (marks + Qty + Wt), process-ordered,
  // shown at the top of the table above the itemwise rows.
  const subtotalRows = useMemo(() => {
    const groups = new Map<
      string,
      { marks: number; qty: number; wt: number; ageSum: number; ageCount: number }
    >();
    for (const r of rows) {
      const key = r.activity || "Unknown";
      const g = groups.get(key) ?? { marks: 0, qty: 0, wt: 0, ageSum: 0, ageCount: 0 };
      g.marks += 1;
      g.qty += r.balanceQty ?? 0;
      g.wt += r.balanceWt ?? 0;
      if (r.ageingDays != null) {
        g.ageSum += r.ageingDays;
        g.ageCount += 1;
      }
      groups.set(key, g);
    }
    return [...groups.keys()].sort(compareActivity).map((activity) => {
      const g = groups.get(activity)!;
      return {
        activity,
        marks: g.marks,
        qty: g.qty,
        wt: g.wt,
        avgAge: g.ageCount ? Math.round(g.ageSum / g.ageCount) : null,
      };
    });
  }, [rows]);

  const handleExcel = () => {
    if (!rows.length) return;
    const tag = `${filters.job ?? "all"}_${filters.activity ?? "all"}_by-${sortBy}`.replace(
      /[^\w-]+/g,
      "-",
    );
    // First sheet: the full report with activity-wise subtotals + grand total.
    // Then one worksheet per activity (process-ordered) with its own TOTAL row.
    const byActivity = new Map<string, typeof enrichedRows>();
    for (const r of enrichedRows) {
      const key = r.activity || "Unknown";
      if (!byActivity.has(key)) byActivity.set(key, []);
      byActivity.get(key)!.push(r);
    }
    const activitySheets = [...byActivity.keys()]
      .sort(compareActivity)
      .map((act) => ({ name: act, columns: REPORT_COLUMNS, rows: byActivity.get(act)! }));
    const date = new Date().toISOString().slice(0, 10);
    exportToXlsxSheets(`report_${tag}_${date}.xlsx`, [
      {
        name: "Summary",
        columns: REPORT_COLUMNS,
        rows: enrichedRows,
        summaryRows: [...activitySubtotals, ...holeOpSubtotals],
      },
      ...activitySheets,
    ]);
  };

  if (selectedImportId == null) {
    return (
      <Card className="border-border">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Upload or select an import on the Data page to build a report.
        </CardContent>
      </Card>
    );
  }

  const visible = enrichedRows.slice(0, TABLE_CAP);

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-wrap items-center justify-between gap-3">
          Job Wise Report
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            disabled={!rows.length}
            onClick={handleExcel}
          >
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-muted-foreground">
          Filtered by the header filters (job, activity, contractor, and more).
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {rows.length.toLocaleString()} rows • {totalQty.toLocaleString()} pcs •{" "}
            {formatWeight(totalWt)}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setShowItemwise((v) => !v)}
            >
              {showItemwise ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
              {showItemwise ? "Hide Itemwise" : "Show Itemwise"}
            </Button>
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Sort by
            </label>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {holeOpBreakdown.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">
              Hole Operation
            </span>
            {holeOpBreakdown.map((h) => (
              <div
                key={h.key}
                className="rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="font-semibold">{h.label}</span>
                <span className="text-muted-foreground">
                  {" "}
                  • {h.marks.toLocaleString()} marks • {num(h.qty)} pcs • {formatWeight(h.wt)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto border border-border rounded-lg">
          <Table>
            <TableBody>
              {subtotalRows.length > 0 && (
                <>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableCell
                      colSpan={COL_COUNT}
                      className="font-semibold text-xs uppercase tracking-wider text-muted-foreground"
                    >
                      Activity-wise Subtotal
                    </TableCell>
                  </TableRow>
                  {subtotalRows.map((s) => (
                    <TableRow
                      key={`sub-${s.activity}`}
                      className="bg-muted/30 hover:bg-muted/30 font-semibold"
                    >
                      <TableCell>{s.activity}</TableCell>
                      <TableCell className="text-xs font-normal text-muted-foreground">
                        {s.marks.toLocaleString()} marks
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-right tabular-nums">{num(s.qty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatWeight(s.wt)}</TableCell>
                      <TableCell></TableCell>
                      <TableCell className={`text-right tabular-nums ${getAgeingColor(s.avgAge)}`}>
                        {s.avgAge !== null ? `${s.avgAge}d` : "-"}
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  ))}
                </>
              )}
              {rows.length > 0 && showItemwise && (
                <>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableCell
                      colSpan={COL_COUNT}
                      className="font-semibold text-xs uppercase tracking-wider text-muted-foreground"
                    >
                      Itemwise Data
                    </TableCell>
                  </TableRow>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Activity</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Section</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Mark No.</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Length</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Width</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Balance Qty</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Balance Wt</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Contractor</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Ageing</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Target</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Overrun</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Consumed</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">To Target</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Status</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Stalled</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Velocity</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Days/Stage</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">ETA</TableCell>
                    <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">ETA Gap</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Trend</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Section Type</TableCell>
                    <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Hole Op.</TableCell>
                  </TableRow>
                </>
              )}
              {showItemwise && visible.map((r, i) => (
                <TableRow key={`${r.markId}-${i}`}>
                  <TableCell>{r.activity ?? "-"}</TableCell>
                  <TableCell>{r.section ?? "-"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.markId}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.length)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.width)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.balanceQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatWeight(r.balanceWt)}</TableCell>
                  <TableCell>{r.contractor ?? "Unassigned"}</TableCell>
                  <TableCell className={`text-right font-bold ${getAgeingColor(r.ageingDays)}`}>
                    {ageingCell(r)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.cumulativeTarget !== null ? `${r.cumulativeTarget}d` : "-"}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-bold ${lifecycleTextColor(r.lifecycleStatusRaw)}`}>
                    {r.overrun !== null && r.overrun > 0 ? `+${r.overrun}d` : r.overrun !== null ? `${r.overrun}d` : "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.consumedPct !== null ? `${r.consumedPct}%` : "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.daysToTarget !== null ? `${r.daysToTarget}d` : "-"}
                  </TableCell>
                  <TableCell className={`text-xs font-semibold ${lifecycleTextColor(r.lifecycleStatusRaw)}`}>
                    {r.lifecycleStatus}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.stalled ? (
                      <span className="font-semibold text-ageing-red">Stalled</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs font-semibold">
                    {r.velocityStatusRaw ? (
                      <span className={velocityStatusColor(r.velocityStatusRaw)}>
                        {r.velocityStatusLabel}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtDays(r.daysPerStage)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtDays(r.etaDays)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.etaGap !== null && r.etaGap !== undefined
                      ? `${r.etaGap > 0 ? "+" : ""}${fmtDays(r.etaGap)}`
                      : "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.trendRaw ? (
                      <span>
                        {trendArrow(r.trendRaw)} {r.trendLabel}
                      </span>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.sectionType ?? "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.holeOperationLabel}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COL_COUNT} className="text-center text-sm text-muted-foreground py-8">
                    No rows match the current filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {showItemwise && rows.length > TABLE_CAP && (
          <div className="text-xs text-muted-foreground">
            Showing first {TABLE_CAP.toLocaleString()} of {rows.length.toLocaleString()} rows. Export
            to Excel for the full set.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- "Fabrication Load for TLT" report ---------------------------------------
// TLT-only planning view. Two sections (Operational = work AT an operation; In
// Hand = work BEFORE it) x five load columns, each summing Balance Wt (tonnes)
// per project, with a per-row Priority (P1..P10) persisted server-side. Pure
// display/planning overlay — reuses existing record fields (activity,
// sectionType, holeOperation, balanceWt, job); changes nothing in the engine.

const NONE_PRIORITY = "__none__";
const W_RANK = activityRank("W");
const B_RANK = activityRank("B");

// Does a record belong in a given (section, column) cell? Welded/Bending use a
// POSITIONAL rule in the TLT sequence (at the activity = Operational; before it
// = In Hand). Drilling/Plate Punch/Plate Drill use a SPECIFIC-ACTIVITY rule
// (RFI = Operational, C = In Hand) combined with sectionType + holeOperation.
function fabLoadMatch(
  section: FabLoadSection,
  column: FabLoadColumn,
  r: ApiRecord,
): boolean {
  const act = normalizeActivity(r.activity);
  const rank = activityRank(r.activity);
  const sec = r.sectionType;
  const op = r.holeOperation;
  if (section === "operational") {
    switch (column) {
      case "welded":
        return act === "W";
      case "bending":
        return act === "B";
      case "drilling":
        return sec === "ANGLE" && act === "RFI" && op === "DRILLING";
      case "platePunch":
        return sec === "PLATE" && act === "RFI" && op === "PUNCHING";
      case "plateDrill":
        return sec === "PLATE" && act === "RFI" && op === "DRILLING";
    }
  }
  switch (column) {
    case "welded":
      return rank < W_RANK; // before W (C,RFI,NH,B,HAB,HG); unknown ranks excluded
    case "bending":
      return rank < B_RANK; // before B (C,RFI,NH)
    case "drilling":
      return sec === "ANGLE" && act === "C" && op === "DRILLING";
    case "platePunch":
      return sec === "PLATE" && act === "C" && op === "PUNCHING";
    case "plateDrill":
      return sec === "PLATE" && act === "C" && op === "DRILLING";
  }
  return false;
}

function priKey(section: string, column: string, project: string): string {
  return `${section}|${column}|${project}`;
}

const toTonnes = (kg: number): number => Math.round((kg / 1000) * 1000) / 1000;
const fmtTonnes = (kg: number): string => toTonnes(kg).toFixed(3);

type FabRow = { project: string; weightKg: number };
type FabColumnData = { rows: FabRow[]; totalKg: number };

function FabricationLoadReport() {
  const { selectedImportId, filters } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: selectedImportId != null,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });
  const filtered = useFilteredRecords(allRecords);
  const queryClient = useQueryClient();
  const [sortByPriority, setSortByPriority] = useState(false);

  const { data: priorityRows } = useListFabricationPriorities({
    query: { queryKey: getListFabricationPrioritiesQueryKey() },
  });
  const upsert = useUpsertFabricationPriority();
  const del = useDeleteFabricationPriority();

  const priorityMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of priorityRows ?? [])
      m.set(priKey(p.section, p.column, p.project), p.priority);
    return m;
  }, [priorityRows]);

  // TLT only — the report ignores NTLT marks regardless of the Order Type
  // toggle. (category defaults to "TLT" when unset on legacy rows.)
  const tltRecords = useMemo(
    () => filtered.filter((r) => (r.category || "TLT") === "TLT"),
    [filtered],
  );

  // Sum Balance Wt (kg) per project for every (section, column) cell.
  const data = useMemo(() => {
    const out = new Map<string, FabColumnData>();
    for (const s of FAB_LOAD_SECTIONS) {
      for (const c of FAB_LOAD_COLUMNS) {
        out.set(`${s.value}|${c.value}`, { rows: [], totalKg: 0 });
      }
    }
    const acc = new Map<string, Map<string, number>>(); // cell -> project -> kg
    for (const r of tltRecords) {
      const project = (r.job || "").trim();
      if (!project || project === "(Unassigned)") continue;
      const wt = r.balanceWt ?? 0;
      if (wt <= 0) continue;
      for (const s of FAB_LOAD_SECTIONS) {
        for (const c of FAB_LOAD_COLUMNS) {
          if (!fabLoadMatch(s.value, c.value, r)) continue;
          const cell = `${s.value}|${c.value}`;
          let pm = acc.get(cell);
          if (!pm) {
            pm = new Map();
            acc.set(cell, pm);
          }
          pm.set(project, (pm.get(project) ?? 0) + wt);
        }
      }
    }
    for (const [cell, pm] of acc) {
      let totalKg = 0;
      const rows: FabRow[] = [];
      for (const [project, weightKg] of pm) {
        if (weightKg <= 0) continue;
        rows.push({ project, weightKg });
        totalKg += weightKg;
      }
      out.set(cell, { rows, totalKg });
    }
    return out;
  }, [tltRecords]);

  const orderedRows = (
    section: FabLoadSection,
    column: FabLoadColumn,
    cell: FabColumnData,
  ): FabRow[] => {
    const arr = [...cell.rows];
    if (sortByPriority) {
      // Numeric rank of P1..P10 (unset sorts last); ties broken by weight desc.
      const rankOf = (project: string): number => {
        const p = priorityMap.get(priKey(section, column, project));
        if (!p) return Number.MAX_SAFE_INTEGER;
        const n = Number(p.slice(1));
        return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
      };
      arr.sort(
        (a, b) =>
          rankOf(a.project) - rankOf(b.project) || b.weightKg - a.weightKg,
      );
    } else {
      arr.sort((a, b) => b.weightKg - a.weightKg);
    }
    return arr;
  };

  const setPriority = (
    section: FabLoadSection,
    column: FabLoadColumn,
    project: string,
    value: string,
  ) => {
    const invalidate = () =>
      queryClient.invalidateQueries({
        queryKey: getListFabricationPrioritiesQueryKey(),
      });
    if (value === NONE_PRIORITY) {
      del.mutate(
        { params: { section, column, project } },
        { onSuccess: invalidate },
      );
    } else {
      upsert.mutate(
        { data: { section, column, project, priority: value as never } },
        { onSuccess: invalidate },
      );
    }
  };

  const buildExportRows = (): Record<string, string | number>[] => {
    const rows: Record<string, string | number>[] = [];
    for (const s of FAB_LOAD_SECTIONS) {
      for (const c of FAB_LOAD_COLUMNS) {
        const cell = data.get(`${s.value}|${c.value}`)!;
        for (const r of orderedRows(s.value, c.value, cell)) {
          rows.push({
            section: s.label,
            column: c.label,
            project: r.project,
            weightT: toTonnes(r.weightKg),
            priority: priorityMap.get(priKey(s.value, c.value, r.project)) ?? "",
          });
        }
        rows.push({
          section: s.label,
          column: c.label,
          project: "G. Total",
          weightT: toTonnes(cell.totalKg),
          priority: "",
        });
      }
    }
    return rows;
  };

  const exportExcel = () => {
    const date = new Date().toISOString().slice(0, 10);
    const columns: XlsxColumn[] = [
      { label: "Section", field: "section" },
      { label: "Load Column", field: "column" },
      { label: "Project", field: "project" },
      { label: "Weight (t)", field: "weightT", numeric: true, decimals: 3 },
      { label: "Priority", field: "priority" },
    ];
    exportToXlsxSheets(`fabrication_load_tlt_${date}.xlsx`, [
      { name: "Fabrication Load", columns, rows: buildExportRows() },
    ]);
  };

  const exportCsv = () => {
    const date = new Date().toISOString().slice(0, 10);
    const rows = buildExportRows().map((r) => ({
      Section: r.section,
      "Load Column": r.column,
      Project: r.project,
      "Weight (t)": typeof r.weightT === "number" ? r.weightT.toFixed(3) : r.weightT,
      Priority: r.priority,
    }));
    exportToCsv(`fabrication_load_tlt_${date}.csv`, rows);
  };

  if (selectedImportId == null) {
    return (
      <Card className="border-border">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Upload a report to see the fabrication load.
        </CardContent>
      </Card>
    );
  }

  if (filters.category === "NTLT") {
    return (
      <Card className="border-border">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          This report covers TLT only. Switch the Order Type to TLT or All to see
          it.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          TLT only. Weight is Balance Wt in tonnes. Respects the header filters
          (contractor, dates, job). Priority is saved automatically.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setSortByPriority((v) => !v)}
          >
            Sort: {sortByPriority ? "Priority" : "Weight"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            onClick={exportCsv}
          >
            <FileSpreadsheet className="w-4 h-4" /> Export CSV
          </Button>
          <Button size="sm" className="h-8 gap-2" onClick={exportExcel}>
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </div>
      </div>

      {FAB_LOAD_SECTIONS.map((s) => (
        <div key={s.value} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {s.label}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {FAB_LOAD_COLUMNS.map((c) => {
              const cell = data.get(`${s.value}|${c.value}`)!;
              const rows = orderedRows(s.value, c.value, cell);
              return (
                <Card key={c.value} className="border-border">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center justify-between gap-2">
                      <span>{c.label}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {rows.length} proj
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {rows.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">
                        No matching marks.
                      </p>
                    ) : (
                      <Table>
                        <TableBody>
                          {rows.map((r) => {
                            const key = priKey(s.value, c.value, r.project);
                            const current = priorityMap.get(key) ?? NONE_PRIORITY;
                            return (
                              <TableRow key={r.project}>
                                <TableCell className="font-medium py-1.5">
                                  {r.project}
                                </TableCell>
                                <TableCell className="text-right tabular-nums py-1.5">
                                  {fmtTonnes(r.weightKg)}
                                </TableCell>
                                <TableCell className="py-1.5 w-24">
                                  <Select
                                    value={current}
                                    onValueChange={(v) =>
                                      setPriority(s.value, c.value, r.project, v)
                                    }
                                  >
                                    <SelectTrigger className="h-7 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NONE_PRIORITY}>—</SelectItem>
                                      {FAB_PRIORITIES.map((p) => (
                                        <SelectItem key={p} value={p}>
                                          {p}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          <TableRow className="border-t-2 font-semibold">
                            <TableCell className="py-1.5">G. Total</TableCell>
                            <TableCell className="text-right tabular-nums py-1.5">
                              {fmtTonnes(cell.totalKg)}
                            </TableCell>
                            <TableCell className="py-1.5" />
                          </TableRow>
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ReportsView() {
  const [reportType, setReportType] = useState<ReportType>("jobwise");
  return (
    <div className="space-y-6">
      <Card className="border-border">
        <CardContent className="py-4">
          <div className="flex flex-col gap-3">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Report type
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {REPORT_TYPES.map((t) => {
                const active = t.id === reportType;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setReportType(t.id)}
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm">{t.name}</span>
                      {active && <Check className="w-4 h-4 text-primary shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>
      {reportType === "jobwise" ? (
        <ReportBuilder />
      ) : reportType === "fabload" ? (
        <FabricationLoadReport />
      ) : reportType === "plantop" ? (
        <PlantOperationView />
      ) : (
        <AiTurnaroundReport />
      )}
    </div>
  );
}
