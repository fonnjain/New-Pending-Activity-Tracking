import { useMemo, useState, useEffect } from "react";
import { NetBalanceMovementPanel } from "@/components/NetBalanceMovementPanel";
import { ContractorNetMovementPanel } from "@/components/ContractorNetMovementPanel";
import {
  activityRank,
  assignDayKey,
  bundleActivitySet,
  compareActivity,
  dateToDayKey,
  FAB_LOAD_SECTIONS,
  fabLoadColumnsForSection,
  FAB_PRIORITIES,
  lifecycleStatus,
  matchesContractorCategoryFilter,
  migrateTurnaroundSettings,
  normalizeActivity,
  routeIncludesOp,
  scopeFor,
  sequenceFor,
  sortActivities,
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
  useGetContractorMovement,
  useGetFabricationProjectCompletionTlt,
  useGetImportProductionMovement,
  getGetImportProductionMovementQueryKey,
  useGetImportContractorMovement,
  getGetImportContractorMovementQueryKey,
  type FabricationProjectCompletionRow,
  type Record as ApiRecord,
  type ContractorMovementEntry,
  type ProductionMovementDay,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTracker,
  useFilteredRecords,
  useContractorCategoryMap,
  contractorCategoryFor,
  dateRangeWindow,
  isNamedJobSetFilter,
  MULTI_JOBS_FILTER_VALUE,
  useActiveJobSet,
} from "@/lib/store";
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
  exportToXlsxBlockGrid,
  type XlsxSheet,
  type XlsxColumn,
  type XlsxSection,
  type XlsxSummaryRow,
  type XlsxGridSheet,
  type XlsxGridBlock,
} from "@/lib/export";
import { formatWeight, formatWeightMT, formatDate } from "@/lib/utils";
import { ageingCell, isActiveCutting, isCutting } from "@/lib/ageing";
import { getAgeingColor } from "./overview";
import { AiTurnaroundReport } from "@/components/ai-turnaround-report";
import PlantOperationView from "./plant-operation";
import { FileSpreadsheet, Check, Eye, EyeOff } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type SortKey = "activity" | "ageing" | "contractor";

type ReportType = "jobwise" | "fabload" | "plantop" | "contractorperf" | "fabcompletion" | "dailymov" | "activitymov" | "contractormov" | "ai";

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
      "TLT planning view: Operational vs In Hand load across five columns per project, with editable P1-P10 priorities.",
  },
  {
    id: "plantop",
    name: "Plant Operation Wise",
    description:
      "Work grouped by plant operation, showing load and progress across each stage of the process.",
  },
  {
    id: "contractorperf",
    name: "Contractor Performance",
    description:
      "Daily marks/weight moved from one activity to the next, credited to the contractor who released each stage.",
  },
  {
    id: "fabcompletion",
    name: "Fabrication Report – Project Completion - TLT",
    description:
      "TLT-only completion breakdown by Project and BOM Label: Release, Assignment, and per-activity Fabrication Stage balances (C, HG, RFI, NH, B, HAB, W, Q/TS) in MT.",
  },
  {
    id: "dailymov",
    name: "Daily Production Movement (Activity Wise)",
    description:
      "Balance weight moved per activity per day, with per-activity contractor drill-down. Dates driven by the global date filter.",
  },
  {
    id: "activitymov",
    name: "Activity Wise Net Balance Movement",
    description:
      "Net balance weight change (MT) per activity across consecutive imports — negative = clearing, positive = accumulating.",
  },
  {
    id: "contractormov",
    name: "Contractor Wise Net Balance Movement",
    description:
      "Per-contractor Produced, Received, Released, New Intake and Net Change across consecutive imports. TLT marks only.",
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
                  • {h.marks.toLocaleString()} marks • {num(h.qty)} pcs •{" "}
                  <span className="font-bold text-foreground">{formatWeight(h.wt)}</span>
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
  // Initial Cutting marks (unreleased, counted as Release Balance) must not
  // appear in any fabrication load figure — operational or in-hand.
  if (isCutting(r.activity) && !isActiveCutting(r)) return false;
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
      // before W (C,HG,RFI,NH,B,HAB); unknown ranks excluded. AND the mark must
      // actually weld: W must be in its Col Q route, else it is upcoming-load for
      // an operation it never performs. Blank route keeps prior behaviour.
      return rank < W_RANK && routeIncludesOp(r.operation, "W");
    case "bending":
      // before B (C,HG,RFI,NH) AND B must be in the mark's Col Q route.
      return rank < B_RANK && routeIncludesOp(r.operation, "B");
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

type FabRow = { project: string; weightKg: number; avgThicknessMm: number | null };
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
  // Also accumulates a weight-averaged thickness (mm) per project per cell.
  const data = useMemo(() => {
    const out = new Map<string, FabColumnData>();
    for (const s of FAB_LOAD_SECTIONS) {
      for (const c of fabLoadColumnsForSection(s.value)) {
        out.set(`${s.value}|${c.value}`, { rows: [], totalKg: 0 });
      }
    }
    // cell -> project -> { kg, thickWtSum, thickWtKg }
    const acc = new Map<string, Map<string, { kg: number; thickWtSum: number; thickWtKg: number }>>();
    for (const r of tltRecords) {
      const project = (r.job || "").trim();
      if (!project || project === "(Unassigned)") continue;
      const wt = r.balanceWt ?? 0;
      if (wt <= 0) continue;
      for (const s of FAB_LOAD_SECTIONS) {
        for (const c of fabLoadColumnsForSection(s.value)) {
          if (!fabLoadMatch(s.value, c.value, r)) continue;
          const cell = `${s.value}|${c.value}`;
          let pm = acc.get(cell);
          if (!pm) { pm = new Map(); acc.set(cell, pm); }
          const prev = pm.get(project) ?? { kg: 0, thickWtSum: 0, thickWtKg: 0 };
          const thick = r.thicknessMm;
          pm.set(project, {
            kg: prev.kg + wt,
            thickWtSum: thick != null ? prev.thickWtSum + wt * thick : prev.thickWtSum,
            thickWtKg: thick != null ? prev.thickWtKg + wt : prev.thickWtKg,
          });
        }
      }
    }
    for (const [cell, pm] of acc) {
      let totalKg = 0;
      const rows: FabRow[] = [];
      for (const [project, { kg, thickWtSum, thickWtKg }] of pm) {
        if (kg <= 0) continue;
        const avgThicknessMm = thickWtKg > 0 ? thickWtSum / thickWtKg : null;
        rows.push({ project, weightKg: kg, avgThicknessMm });
        totalKg += kg;
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

  // Mirror the on-screen layout: each section is its own sheet, and inside it
  // the load columns sit side by side as [Project | Wt (t) | Priority] blocks,
  // rows aligned by the current sort, with a bold G. Total row per column.
  const buildSectionGrid = (section: FabLoadSection) => {
    const cols = fabLoadColumnsForSection(section);
    const blocks = cols.map((c) => {
      const cell = data.get(`${section}|${c.value}`)!;
      return { c, cell, rows: orderedRows(section, c.value, cell) };
    });
    const maxLen = blocks.reduce((m, b) => Math.max(m, b.rows.length), 0);
    return { blocks, maxLen };
  };

  const exportExcel = () => {
    const date = new Date().toISOString().slice(0, 10);
    const sheets: XlsxGridSheet[] = FAB_LOAD_SECTIONS.map((s) => {
      const { blocks } = buildSectionGrid(s.value);
      const gridBlocks: XlsxGridBlock[] = blocks.map(({ c, cell, rows: rs }) => ({
        title: c.label,
        headers: ["Project", "Wt (t)", "Priority"],
        numeric: [false, true, false],
        decimals: 2,
        rows: rs.map((r) => [
          r.project,
          toTonnes(r.weightKg),
          priorityMap.get(priKey(s.value, c.value, r.project)) ?? "",
        ]),
        totals: ["G. Total", toTonnes(cell.totalKg), ""],
      }));
      return { name: s.label, blocks: gridBlocks };
    });
    exportToXlsxBlockGrid(`fabrication_load_tlt_${date}.xlsx`, sheets);
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
          <Button size="sm" className="h-8 gap-2" onClick={exportExcel}>
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </div>
      </div>

      {FAB_LOAD_SECTIONS.map((s) => {
        const columns = fabLoadColumnsForSection(s.value);
        return (
          <div key={s.value} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </h2>
            <div className="overflow-x-auto rounded-lg border border-border">
              <div
                className="grid divide-x divide-border min-w-[560px]"
                style={{
                  gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
                }}
              >
                {columns.map((c) => {
                  const cell = data.get(`${s.value}|${c.value}`)!;
                  const rows = orderedRows(s.value, c.value, cell);
                  return (
                    <div key={c.value} className="min-w-0 flex flex-col">
                      <div className="px-2 py-2 bg-muted/50 border-b border-border flex items-center justify-between gap-1">
                        <span className="text-xs font-semibold truncate">{c.label}</span>
                        <span className="text-[10px] font-normal text-muted-foreground shrink-0">
                          {rows.length}
                        </span>
                      </div>
                      {rows.length === 0 ? (
                        <p className="text-xs text-muted-foreground px-3 py-3">
                          No matching marks.
                        </p>
                      ) : (
                        <Table>
                          <TableBody>
                            <TableRow className="text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-transparent">
                              <TableCell className="px-1.5 py-1.5 font-medium">
                                Project
                              </TableCell>
                              <TableCell className="px-1.5 py-1.5 text-right font-medium">
                                Weight
                              </TableCell>
                              <TableCell className="px-1.5 py-1.5 font-medium">
                                Priority
                              </TableCell>
                            </TableRow>
                            {rows.map((r) => {
                              const key = priKey(s.value, c.value, r.project);
                              const current =
                                priorityMap.get(key) ?? NONE_PRIORITY;
                              return (
                                <TableRow key={r.project}>
                                  <TableCell className="font-medium py-1.5 px-1.5 text-xs">
                                    {r.project}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums py-1.5 px-1.5 text-xs">
                                    {fmtTonnes(r.weightKg)}
                                  </TableCell>
                                  <TableCell className="py-1.5 px-1.5">
                                    <Select
                                      value={current}
                                      onValueChange={(v) =>
                                        setPriority(
                                          s.value,
                                          c.value,
                                          r.project,
                                          v,
                                        )
                                      }
                                    >
                                      <SelectTrigger className="h-7 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent
                                        position="popper"
                                        side="bottom"
                                        avoidCollisions={false}
                                      >
                                        <SelectItem value={NONE_PRIORITY}>
                                          —
                                        </SelectItem>
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
                              <TableCell className="py-1.5 px-1.5 text-xs">G. Total</TableCell>
                              <TableCell className="py-1.5 px-1.5" />
                              <TableCell className="text-right tabular-nums py-1.5 px-1.5 text-xs">
                                {fmtTonnes(cell.totalKg)}
                              </TableCell>
                              <TableCell className="py-1.5 px-1.5" />
                            </TableRow>
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- "Contractor Performance" report -----------------------------------
// Daily log of how many marks (and how much weight) moved from one activity
// to the next, credited to the contractor of the FROM activity — the one who
// completed and released that stage. Sourced from the deterministic
// full-history contractor-movement ledger (GET /contractor-movement), not the
// currently selected import's records, so it always reflects the full
// history regardless of which import is selected.
//
// Global filter support: each ledger entry only carries
// {date, project, contractor, fromActivity, toActivity, markCount, weightKg}
// (no mfcBatch/structure/mark/section/ntltSubtype/holeOperation/category —
// those would need server-side enrichment). So this report honours every
// global filter that its data CAN answer — Job, Contractor (+ category via
// the category map), Activity (plain code or bundle, matched against either
// side of the move), Date range, and Search (project/contractor text) — and
// intentionally leaves the rest alone rather than silently mis-filtering.

const BUNDLE_PREFIX = "bundle:";
const UNASSIGNED_CONTRACTOR = "Unassigned";

function contractorLabel(c: string | null): string {
  return c && c.trim() ? c : UNASSIGNED_CONTRACTOR;
}

// Bifurcation: every move is a completion of whichever activity it LEFT (the
// FROM activity is fully done for that mark once it moves on). A stage is
// simply that from-activity's code, so the breakdown spans the full process
// (C, RFI, NH, ... Y) rather than only the two Fabrication/Galvanizing
// milestones. Blank from-activity (shouldn't happen on a real move) has no
// stage.
type Stage = string;

function stageFor(fromActivity: string | null | undefined): Stage | null {
  const a = (fromActivity ?? "").toUpperCase().trim();
  return a || null;
}

// Live-balance completion status (additive, separate from the movement-based
// Stage above). Fabrication activities per the user's spec are C..Q — the
// TLT_FABRICATION bundle minus its terminal TS step, since TS itself is a
// Quality gate, not a fabrication op. Galvanizing completion checks GB only
// (not G, not the wider GALVANIZING bundle which also spans Y).
const FAB_COMPLETION_SET = new Set(
  [...(bundleActivitySet("TLT_FABRICATION") ?? [])].filter((c) => c !== "TS"),
);
const GALV_COMPLETION_ACTIVITY = "GB";

// Stage-summary subtotal grouping: which activity columns roll up into the
// Fabrication vs Galvanizing subtotal. Uses the same bundle definitions as
// everywhere else (TLT_FABRICATION = C..TS, GALVANIZING = G/GB/Y) so this
// stays consistent with every other Fab/Galv split in the app.
const STAGE_FAB_SET = bundleActivitySet("TLT_FABRICATION") ?? new Set<string>();
const STAGE_GALV_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();

function CompletionBadge({ remainingKg }: { remainingKg: number }) {
  const complete = remainingKg <= 0;
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${
        complete
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      }`}
    >
      {complete ? "Completed" : `Pending (${formatWeightMT(remainingKg)})`}
    </span>
  );
}

export function ContractorPerformanceReport() {
  const { filters, selectedImportId } = useTracker();
  const { data, isLoading } = useGetContractorMovement();
  const { data: liveRecords = [] } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) },
  });
  const categoryMap = useContractorCategoryMap();
  const activeJobSet = useActiveJobSet();
  const [contractorFilter, setContractorFilter] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<Stage | null>(null);

  // Global filters this ledger's data can actually answer: Job, Contractor
  // (a specific name, or a CNC/Sub-contractor/Out-vendor classification via
  // the overlay map), Activity (plain code or bundle, matched against either
  // side of a move), Date range, and Search (project/contractor text). Every
  // other global filter (MFC, Structure, Mark, Section, NTLT sub-type, Hole
  // Operation) has no equivalent field on a movement entry and is left alone.
  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const activityFilter = filters.activity;
    const bundleSet =
      activityFilter && activityFilter.startsWith(BUNDLE_PREFIX)
        ? bundleActivitySet(activityFilter.slice(BUNDLE_PREFIX.length))
        : null;
    const win = dateRangeWindow(filters.dateRange);
    const startKey = win ? dateToDayKey(win.start) : null;
    const endKey = win ? dateToDayKey(win.end) : null;
    const search = filters.search.trim().toLowerCase();

    return all.filter((e) => {
      // Project-less moves (RSJ POLE / EARTHING / GENERAL / blank Order
      // Nature) are excluded here for the same reason they're excluded from
      // milestones and the Fabrication Load guard: "(Unassigned)" is not a
      // real project and clutters a per-project contractor report.
      if (e.project === "(Unassigned)") return false;
      if (filters.job) {
        if (isNamedJobSetFilter(filters.job)) {
          if (!activeJobSet.has(e.project)) return false;
        } else if (filters.job === MULTI_JOBS_FILTER_VALUE) {
          if (!filters.selectedJobs?.includes(e.project)) return false;
        } else if (e.project !== filters.job) {
          return false;
        }
      }

      if (filters.contractor && contractorLabel(e.contractor) !== filters.contractor) return false;
      if (filters.contractorCategory) {
        const info = contractorCategoryFor(e.contractor, categoryMap);
        if (!matchesContractorCategoryFilter(info.category, filters.contractorCategory)) return false;
        if (filters.outVendorType && !info.outVendorType.includes(filters.outVendorType)) return false;
      }

      if (activityFilter) {
        if (bundleSet) {
          if (!bundleSet.has(e.fromActivity.toUpperCase()) && !bundleSet.has(e.toActivity.toUpperCase())) {
            return false;
          }
        } else if (e.fromActivity !== activityFilter && e.toActivity !== activityFilter) {
          return false;
        }
      }

      if (startKey !== null && endKey !== null) {
        const dayKey = assignDayKey(e.date);
        if (dayKey === null || dayKey < startKey || dayKey >= endKey) return false;
      }

      if (search && !e.project.toLowerCase().includes(search) && !contractorLabel(e.contractor).toLowerCase().includes(search)) {
        return false;
      }

      return true;
    });
  }, [data, filters.job, filters.selectedJobs, filters.contractor, filters.contractorCategory, filters.outVendorType, filters.activity, filters.dateRange, filters.search, categoryMap, activeJobSet]);

  // Live-balance completion (additive): per contractor, how much balance
  // weight is still pending in the Fabrication (C..Q) / Galvanizing (GB)
  // activities right now, from the currently selected import's records.
  // Records carry the full field set, so this honours EVERY global filter
  // (via useFilteredRecords), unlike the ledger-derived sections above.
  const filteredLiveRecords = useFilteredRecords(liveRecords);
  const { fabRemainingByContractor, galvRemainingByContractor } = useMemo(() => {
    const fabMap = new Map<string, number>();
    const galvMap = new Map<string, number>();
    for (const r of filteredLiveRecords) {
      const activity = (r.activity ?? "").toUpperCase();
      const c = contractorLabel(r.contractor);
      if (FAB_COMPLETION_SET.has(activity)) {
        fabMap.set(c, (fabMap.get(c) ?? 0) + r.balanceWt);
      } else if (activity === GALV_COMPLETION_ACTIVITY) {
        galvMap.set(c, (galvMap.get(c) ?? 0) + r.balanceWt);
      }
    }
    return { fabRemainingByContractor: fabMap, galvRemainingByContractor: galvMap };
  }, [filteredLiveRecords]);

  const toggleContractor = (c: string) =>
    setContractorFilter((cur) => (cur === c ? null : c));
  // Clicking a stage cell for a specific contractor selects that exact
  // combination (or clears it if already selected); clicking a stage total
  // (no contractor) filters to that stage across every contractor.
  const toggleStage = (s: Stage, c?: string) => {
    const alreadySelected = stageFilter === s && (c === undefined ? contractorFilter === null : contractorFilter === c);
    if (alreadySelected) {
      setStageFilter(null);
      setContractorFilter(null);
    } else {
      setStageFilter(s);
      setContractorFilter(c ?? null);
    }
  };
  const clearFilters = () => {
    setContractorFilter(null);
    setStageFilter(null);
  };

  // Chronological date columns + contractors sorted by total weight desc
  // (ties broken alphabetically; Unassigned always last).
  const { dates, contractors, matrix, rowTotals, colTotals, grandTotal } =
    useMemo(() => {
      const dateSet = new Set<string>();
      const contractorSet = new Set<string>();
      const cellWt = new Map<string, number>(); // `${contractor}|${date}` -> kg
      const rowTot = new Map<string, number>();
      const colTot = new Map<string, number>();
      let grand = 0;

      for (const e of entries) {
        const c = contractorLabel(e.contractor);
        dateSet.add(e.date);
        contractorSet.add(c);
        const key = `${c}|${e.date}`;
        cellWt.set(key, (cellWt.get(key) ?? 0) + e.weightKg);
        rowTot.set(c, (rowTot.get(c) ?? 0) + e.weightKg);
        colTot.set(e.date, (colTot.get(e.date) ?? 0) + e.weightKg);
        grand += e.weightKg;
      }

      const sortedDates = [...dateSet].sort();
      const sortedContractors = [...contractorSet].sort((a, b) => {
        if (a === UNASSIGNED_CONTRACTOR) return 1;
        if (b === UNASSIGNED_CONTRACTOR) return -1;
        return (rowTot.get(b) ?? 0) - (rowTot.get(a) ?? 0) || a.localeCompare(b);
      });

      return {
        dates: sortedDates,
        contractors: sortedContractors,
        matrix: cellWt,
        rowTotals: rowTot,
        colTotals: colTot,
        grandTotal: grand,
      };
    }, [entries]);

  // Detail log rows: newest date first, then project/contractor/activity.
  const detailRows = useMemo(
    () =>
      [...entries].sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.project.localeCompare(b.project) ||
          contractorLabel(a.contractor).localeCompare(contractorLabel(b.contractor)),
      ),
    [entries],
  );

  // Per-activity bifurcation: for every contractor, the weight moved OUT of
  // each activity (that activity is done for those marks), across the full
  // process — not just Fabrication (TS) / Galvanizing (Y). Activities are
  // ordered by the canonical TLT sequence (unknown codes sort after known,
  // never dropped), mirroring the Activity Wise page.
  const {
    stageActivities,
    stageMatrix,
    stageColTotals,
    stageRowTotals,
    stageGrandTotal,
    stageFabByContractor,
    stageGalvByContractor,
    stageFabTotal,
    stageGalvTotal,
  } = useMemo(() => {
    const actSet = new Set<string>();
    const cellWt = new Map<string, number>(); // `${contractor}|${activity}` -> kg
    const rowTot = new Map<string, number>();
    const colTot = new Map<string, number>();
    const fabByContractor = new Map<string, number>();
    const galvByContractor = new Map<string, number>();
    let grand = 0;
    let fabTot = 0;
    let galvTot = 0;
    for (const e of entries) {
      const stage = stageFor(e.fromActivity);
      if (!stage) continue;
      const c = contractorLabel(e.contractor);
      actSet.add(stage);
      const key = `${c}|${stage}`;
      cellWt.set(key, (cellWt.get(key) ?? 0) + e.weightKg);
      rowTot.set(c, (rowTot.get(c) ?? 0) + e.weightKg);
      colTot.set(stage, (colTot.get(stage) ?? 0) + e.weightKg);
      grand += e.weightKg;
      if (STAGE_FAB_SET.has(stage)) {
        fabByContractor.set(c, (fabByContractor.get(c) ?? 0) + e.weightKg);
        fabTot += e.weightKg;
      } else if (STAGE_GALV_SET.has(stage)) {
        galvByContractor.set(c, (galvByContractor.get(c) ?? 0) + e.weightKg);
        galvTot += e.weightKg;
      }
    }
    return {
      stageActivities: sortActivities([...actSet]),
      stageMatrix: cellWt,
      stageColTotals: colTot,
      stageRowTotals: rowTot,
      stageGrandTotal: grand,
      stageFabByContractor: fabByContractor,
      stageGalvByContractor: galvByContractor,
      stageFabTotal: fabTot,
      stageGalvTotal: galvTot,
    };
  }, [entries]);

  // Detail log scoped by the clickable contractor/stage filters above it.
  const scopedDetailRows = useMemo(
    () =>
      detailRows.filter(
        (e) =>
          (!contractorFilter || contractorLabel(e.contractor) === contractorFilter) &&
          (!stageFilter || stageFor(e.fromActivity) === stageFilter),
      ),
    [detailRows, contractorFilter, stageFilter],
  );

  // Split the process-ordered stage columns so the two subtotal columns sit
  // right after the last activity they summarize: Fabrication Subtotal after
  // TS (the last STAGE_FAB_SET activity), Galvanization Subtotal after GB
  // (the last STAGE_GALV_SET activity before the terminal Y). Y itself always
  // renders last since it's the shared terminal stage for every sequence.
  const { fabStageActs, galvStageActsPreY, hasYStage } = useMemo(() => {
    const fab: string[] = [];
    const galvPreY: string[] = [];
    let hasY = false;
    for (const a of stageActivities) {
      if (a === "Y") {
        hasY = true;
      } else if (STAGE_GALV_SET.has(a)) {
        galvPreY.push(a);
      } else {
        fab.push(a);
      }
    }
    return { fabStageActs: fab, galvStageActsPreY: galvPreY, hasYStage: hasY };
  }, [stageActivities]);

  const totalMarks = entries.reduce((s, e) => s + e.markCount, 0);

  const handleExcel = () => {
    if (!entries.length) return;
    const date = new Date().toISOString().slice(0, 10);
    const tag = (filters.job ?? "all").replace(/[^\w-]+/g, "-");

    // Summary sheet: contractors as rows, dates as columns, weight (MT)
    // totals. Column keys stay the raw ISO date (so the underlying matrix
    // lookup + chronological sort are unaffected); only the header label is
    // shown as dd-mm-yyyy.
    const summaryColumns: XlsxColumn[] = [
      { label: "Contractor", field: "contractor" },
      ...dates.map((d) => ({ label: formatDate(d), field: d, numeric: true, decimals: 2, total: true })),
      { label: "Total (MT)", field: "__total", numeric: true, decimals: 2, total: true },
    ];
    const summaryRows = contractors.map((c) => {
      const row: Record<string, string | number> = { contractor: c };
      for (const d of dates) row[d] = (matrix.get(`${c}|${d}`) ?? 0) / 1000;
      row.__total = (rowTotals.get(c) ?? 0) / 1000;
      return row;
    });

    // Detail sheet: one row per day/contractor/activity-move. Date is
    // pre-formatted dd-mm-yyyy (this is a plain text column, not numeric, so
    // the value is written to the cell exactly as given); weight in MT.
    const detailColumns: XlsxColumn[] = [
      { label: "Date", field: "date" },
      { label: "Project", field: "project" },
      { label: "From Activity", field: "fromActivity" },
      { label: "To Activity", field: "toActivity" },
      { label: "Stage", field: "stage" },
      { label: "Mark Count", field: "markCount", numeric: true, decimals: 0, total: true },
      { label: "Weight (MT)", field: "weightKg", numeric: true, decimals: 2, total: true },
    ];

    // Stage summary sheet: weight moved out of each activity (that activity
    // is done for those marks), per contractor, in MT — one column per
    // activity present, TLT-sequence ordered, plus a Total column.
    const stageColumns: XlsxColumn[] = [
      { label: "Contractor", field: "contractor" },
      ...fabStageActs.map((a) => ({ label: a, field: a, numeric: true, decimals: 2, total: true })),
      { label: "Fabrication Subtotal (MT)", field: "__fabSubtotal", numeric: true, decimals: 2, total: true },
      ...galvStageActsPreY.map((a) => ({ label: a, field: a, numeric: true, decimals: 2, total: true })),
      { label: "Galvanization Subtotal (MT)", field: "__galvSubtotal", numeric: true, decimals: 2, total: true },
      ...(hasYStage ? [{ label: "Y", field: "Y", numeric: true, decimals: 2, total: true }] : []),
      { label: "Total (MT)", field: "__total", numeric: true, decimals: 2, total: true },
    ];
    const stageRowsMt = contractors.map((c) => {
      const row: Record<string, string | number> = { contractor: c };
      for (const a of stageActivities) row[a] = (stageMatrix.get(`${c}|${a}`) ?? 0) / 1000;
      row.__fabSubtotal = (stageFabByContractor.get(c) ?? 0) / 1000;
      row.__galvSubtotal = (stageGalvByContractor.get(c) ?? 0) / 1000;
      row.__total = (stageRowTotals.get(c) ?? 0) / 1000;
      return row;
    });

    // Detail: one worksheet per contractor (sheet names are sanitized +
    // de-duplicated by exportToXlsxSheets), each scoped to that contractor's
    // moves only, newest first, tagged with the Fabrication/Galvanizing stage,
    // date formatted dd-mm-yyyy and weight converted to MT.
    const contractorSheets = contractors.map((c) => ({
      name: c,
      columns: detailColumns,
      rows: detailRows
        .filter((e) => contractorLabel(e.contractor) === c)
        .map((e) => ({
          ...e,
          date: formatDate(e.date),
          weightKg: e.weightKg / 1000,
          stage: stageFor(e.fromActivity) ?? "-",
        })),
    }));

    exportToXlsxSheets(`contractor_performance_${tag}_${date}.xlsx`, [
      { name: "Summary", columns: summaryColumns, rows: summaryRows },
      { name: "Stage Summary", columns: stageColumns, rows: stageRowsMt },
      ...contractorSheets,
    ]);
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-wrap items-center justify-between gap-3">
          Contractor Performance
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            disabled={!entries.length}
            onClick={handleExcel}
          >
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-muted-foreground">
          Daily marks and weight moved from one activity to the next, credited to
          the contractor who completed and released the FROM activity. Sourced
          from the full import history (not just the selected import); honours
          the global Job, Contractor, Activity, Date range and Search filters
          (MFC/Structure/Mark/Section/Hole Operation have no equivalent on a
          move record and are not applied here).
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
        ) : !entries.length ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No activity movements found for the current filter.
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {contractors.length.toLocaleString()} contractors • {dates.length.toLocaleString()}{" "}
              days • {totalMarks.toLocaleString()} marks moved •{" "}
              <span className="font-bold text-foreground">{formatWeightMT(grandTotal)}</span>
            </div>

            {(contractorFilter || stageFilter) && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Drill-down filter:</span>
                {contractorFilter && (
                  <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 font-medium">
                    {contractorFilter}
                  </span>
                )}
                {stageFilter && (
                  <span className="rounded bg-primary/10 text-primary px-1.5 py-0.5 font-medium">
                    {stageFilter}
                  </span>
                )}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-muted-foreground hover:text-foreground underline"
                >
                  Clear
                </button>
              </div>
            )}

            <Tabs defaultValue="summary">
              <TabsList>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="stage">Fabrication / Galvanizing</TabsTrigger>
                <TabsTrigger value="detail">
                  Detail log
                  {scopedDetailRows.length !== detailRows.length && (
                    <span className="ml-1.5 rounded-full bg-primary/15 text-primary px-1.5 text-[10px] font-bold">
                      {scopedDetailRows.length.toLocaleString()}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="summary" className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Weight moved per day, in MT (click a contractor to filter the detail log)
                </h3>
                <Table containerClassName="max-h-[60vh] border border-border rounded-lg">
                  <TableBody>
                    <TableRow className="bg-muted/60 hover:bg-muted/60 sticky top-0 z-10">
                      <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground sticky left-0 bg-muted/60">
                        Contractor
                      </TableCell>
                      {dates.map((d) => (
                        <TableCell
                          key={d}
                          className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                        >
                          {formatDate(d)}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Total
                      </TableCell>
                    </TableRow>
                    {contractors.map((c) => (
                      <TableRow
                        key={c}
                        className={contractorFilter === c ? "bg-primary/5" : undefined}
                      >
                        <TableCell
                          className="font-medium text-xs sticky left-0 bg-background cursor-pointer hover:text-primary hover:underline"
                          onClick={() => toggleContractor(c)}
                        >
                          {c}
                        </TableCell>
                        {dates.map((d) => {
                          const wt = matrix.get(`${c}|${d}`) ?? 0;
                          return (
                            <TableCell key={d} className="text-right tabular-nums text-xs text-muted-foreground">
                              {wt ? formatWeightMT(wt) : "-"}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right tabular-nums text-xs font-bold">
                          {formatWeightMT(rowTotals.get(c) ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 font-bold bg-muted/30 hover:bg-muted/30">
                      <TableCell className="text-xs sticky left-0 bg-muted/30">Total</TableCell>
                      {dates.map((d) => (
                        <TableCell key={d} className="text-right tabular-nums text-xs">
                          {formatWeightMT(colTotals.get(d) ?? 0)}
                        </TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums text-xs">
                        {formatWeightMT(grandTotal)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TabsContent>

              <TabsContent value="stage" className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Weight moved out of each activity, per contractor, in MT (click a
                  cell to filter the detail log)
                </h3>
                <div className="text-xs text-muted-foreground">
                  Each activity column counts a move that LEFT that activity (it's
                  fully done for those marks) — the same breakdown as the Activity
                  Wise page, ordered by the process sequence. Fabrication Subtotal
                  sums the C..TS columns and Galvanization Subtotal sums the
                  G/GB/Y columns (the same split used everywhere else in the
                  app); Total is the grand sum. The two Status columns are a
                  separate, live-balance check against the currently selected
                  import: Fabrication is Complete when that contractor has zero
                  balance weight left across activities C..Q; Galvanizing is
                  Complete when zero balance weight is left at GB.
                </div>
                <Table containerClassName="max-h-[60vh] border border-border rounded-lg">
                  <TableBody>
                    <TableRow className="bg-muted/60 hover:bg-muted/60 sticky top-0 z-10">
                      <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground sticky left-0 bg-muted/60">
                        Contractor
                      </TableCell>
                      {fabStageActs.map((a) => (
                        <TableCell
                          key={a}
                          className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                        >
                          {a}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Fabrication Subtotal
                      </TableCell>
                      {galvStageActsPreY.map((a) => (
                        <TableCell
                          key={a}
                          className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                        >
                          {a}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Galvanization Subtotal
                      </TableCell>
                      {hasYStage && (
                        <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                          Y
                        </TableCell>
                      )}
                      <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Total
                      </TableCell>
                      <TableCell className="text-center font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Fab. Status
                      </TableCell>
                      <TableCell className="text-center font-semibold text-xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                        Galv. Status
                      </TableCell>
                    </TableRow>
                    {contractors.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={stageActivities.length + 6}
                          className="text-center text-xs text-muted-foreground py-6"
                        >
                          No activity completions found for the current filter.
                        </TableCell>
                      </TableRow>
                    )}
                    {contractors.map((c) => {
                      const fabRemaining = fabRemainingByContractor.get(c) ?? 0;
                      const galvRemaining = galvRemainingByContractor.get(c) ?? 0;
                      return (
                        <TableRow key={c} className={contractorFilter === c ? "bg-primary/5" : undefined}>
                          <TableCell
                            className="font-medium text-xs sticky left-0 bg-background cursor-pointer hover:text-primary hover:underline"
                            onClick={() => toggleContractor(c)}
                          >
                            {c}
                          </TableCell>
                          {fabStageActs.map((a) => {
                            const wt = stageMatrix.get(`${c}|${a}`) ?? 0;
                            return (
                              <TableCell
                                key={a}
                                className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                                  stageFilter === a && contractorFilter === c
                                    ? "font-bold text-primary"
                                    : "text-muted-foreground"
                                }`}
                                onClick={() => toggleStage(a, c)}
                              >
                                {wt ? formatWeightMT(wt) : "-"}
                              </TableCell>
                            );
                          })}
                          <TableCell className="text-right tabular-nums text-xs font-semibold">
                            {formatWeightMT(stageFabByContractor.get(c) ?? 0)}
                          </TableCell>
                          {galvStageActsPreY.map((a) => {
                            const wt = stageMatrix.get(`${c}|${a}`) ?? 0;
                            return (
                              <TableCell
                                key={a}
                                className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                                  stageFilter === a && contractorFilter === c
                                    ? "font-bold text-primary"
                                    : "text-muted-foreground"
                                }`}
                                onClick={() => toggleStage(a, c)}
                              >
                                {wt ? formatWeightMT(wt) : "-"}
                              </TableCell>
                            );
                          })}
                          <TableCell className="text-right tabular-nums text-xs font-semibold">
                            {formatWeightMT(stageGalvByContractor.get(c) ?? 0)}
                          </TableCell>
                          {hasYStage && (() => {
                            const wt = stageMatrix.get(`${c}|Y`) ?? 0;
                            return (
                              <TableCell
                                className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                                  stageFilter === "Y" && contractorFilter === c
                                    ? "font-bold text-primary"
                                    : "text-muted-foreground"
                                }`}
                                onClick={() => toggleStage("Y", c)}
                              >
                                {wt ? formatWeightMT(wt) : "-"}
                              </TableCell>
                            );
                          })()}
                          <TableCell className="text-right tabular-nums text-xs font-bold">
                            {formatWeightMT(stageRowTotals.get(c) ?? 0)}
                          </TableCell>
                          <TableCell className="text-center">
                            <CompletionBadge remainingKg={fabRemaining} />
                          </TableCell>
                          <TableCell className="text-center">
                            <CompletionBadge remainingKg={galvRemaining} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {contractors.length > 0 && (
                      <TableRow className="border-t-2 font-bold bg-muted/30 hover:bg-muted/30">
                        <TableCell className="text-xs sticky left-0 bg-muted/30">Total</TableCell>
                        {fabStageActs.map((a) => (
                          <TableCell
                            key={a}
                            className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                              stageFilter === a && contractorFilter === null ? "text-primary" : ""
                            }`}
                            onClick={() => toggleStage(a)}
                          >
                            {formatWeightMT(stageColTotals.get(a) ?? 0)}
                          </TableCell>
                        ))}
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatWeightMT(stageFabTotal)}
                        </TableCell>
                        {galvStageActsPreY.map((a) => (
                          <TableCell
                            key={a}
                            className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                              stageFilter === a && contractorFilter === null ? "text-primary" : ""
                            }`}
                            onClick={() => toggleStage(a)}
                          >
                            {formatWeightMT(stageColTotals.get(a) ?? 0)}
                          </TableCell>
                        ))}
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatWeightMT(stageGalvTotal)}
                        </TableCell>
                        {hasYStage && (
                          <TableCell
                            className={`text-right tabular-nums text-xs cursor-pointer hover:text-primary hover:underline ${
                              stageFilter === "Y" && contractorFilter === null ? "text-primary" : ""
                            }`}
                            onClick={() => toggleStage("Y")}
                          >
                            {formatWeightMT(stageColTotals.get("Y") ?? 0)}
                          </TableCell>
                        )}
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatWeightMT(stageGrandTotal)}
                        </TableCell>
                        <TableCell colSpan={2} />
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TabsContent>

              <TabsContent value="detail" className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Detail log ({scopedDetailRows.length.toLocaleString()}
                  {scopedDetailRows.length !== detailRows.length
                    ? ` of ${detailRows.length.toLocaleString()}`
                    : ""}{" "}
                  moves)
                </h3>
                <div className="overflow-x-auto border border-border rounded-lg">
                  <Table containerClassName="max-h-[60vh]">
                    <TableBody>
                      <TableRow className="bg-muted/60 hover:bg-muted/60 sticky top-0">
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Date</TableCell>
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Project</TableCell>
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Contractor</TableCell>
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">From</TableCell>
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">To</TableCell>
                        <TableCell className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Stage</TableCell>
                        <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Marks</TableCell>
                        <TableCell className="text-right font-semibold text-xs uppercase tracking-wider text-muted-foreground">Weight (MT)</TableCell>
                      </TableRow>
                      {scopedDetailRows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">
                            No moves match the current filter.
                          </TableCell>
                        </TableRow>
                      )}
                      {scopedDetailRows.slice(0, TABLE_CAP).map((e, i) => {
                        const stage = stageFor(e.fromActivity);
                        return (
                          <TableRow key={`${e.date}-${e.project}-${e.contractor}-${e.fromActivity}-${e.toActivity}-${i}`}>
                            <TableCell className="text-xs whitespace-nowrap">{formatDate(e.date)}</TableCell>
                            <TableCell className="text-xs">{e.project}</TableCell>
                            <TableCell className="text-xs">{contractorLabel(e.contractor)}</TableCell>
                            <TableCell className="text-xs">{e.fromActivity}</TableCell>
                            <TableCell className="text-xs">{e.toActivity}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{stage ?? "-"}</TableCell>
                            <TableCell className="text-right tabular-nums text-xs">
                              {e.markCount.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs">
                              {formatWeightMT(e.weightKg)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {scopedDetailRows.length > TABLE_CAP && (
                  <div className="text-xs text-muted-foreground">
                    Showing first {TABLE_CAP.toLocaleString()} of {scopedDetailRows.length.toLocaleString()}{" "}
                    moves. Export to Excel for the full set.
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fabrication Report – Project Completion - TLT
// ---------------------------------------------------------------------------
// Per-(project × BOM Label) table with four completion-balance measures.
// All weights server-computed and returned in MT (3 dp). TLT only.
// Respects the global Job filter; groups by project with per-project subtotals.
// Canonical BOM label sort order.
const BOM_LABEL_ORDER = ["Proto", "Mass", "Pre", "Mixed", "Unknown"];
function bomLabelIndex(label: string) {
  const i = BOM_LABEL_ORDER.indexOf(label);
  return i === -1 ? BOM_LABEL_ORDER.length : i;
}

// Canonical sub-type group order within each BOM label section.
const SUBTYPE_ORDER = ["STUB", "SST", "Other"];
function subTypeIndex(g: string) {
  const i = SUBTYPE_ORDER.indexOf(g);
  return i === -1 ? SUBTYPE_ORDER.length : i;
}

type FabSums = {
  releaseBalanceCalcMt: number;
  assignmentBalanceCalcMt: number;
  cuttingBalanceMt: number;
  hgBalanceMt: number;
  rfiBalanceMt: number;
  nhBalanceMt: number;
  bBalanceMt: number;
  habBalanceMt: number;
  wBalanceMt: number;
  qualityCheckBalanceMt: number;
  /** Release + Cutting + HG + RFI + NH + B + HAB + W + Quality.
   *  Assignment Balance is deliberately excluded: it overlaps Release Balance
   *  (Initial marks) and Cutting Balance (Authorized-JCNS marks) and adding it
   *  would double-count those weights. */
  totalFabBalanceMt: number;
};

/** Compute the non-double-counting total:
 *  Release + Cutting + HG + RFI + NH + B + HAB + W + Quality (skip Assignment). */
function fabTotal(s: {
  releaseBalanceCalcMt: number;
  cuttingBalanceMt: number;
  hgBalanceMt: number;
  rfiBalanceMt: number;
  nhBalanceMt: number;
  bBalanceMt: number;
  habBalanceMt: number;
  wBalanceMt: number;
  qualityCheckBalanceMt: number;
}): number {
  return (
    s.releaseBalanceCalcMt +
    s.cuttingBalanceMt +
    s.hgBalanceMt +
    s.rfiBalanceMt +
    s.nhBalanceMt +
    s.bBalanceMt +
    s.habBalanceMt +
    s.wBalanceMt +
    s.qualityCheckBalanceMt
  );
}

function sumRows(rs: FabricationProjectCompletionRow[]): FabSums {
  const sums = {
    releaseBalanceCalcMt:    rs.reduce((s, r) => s + r.releaseBalanceCalcMt,    0),
    assignmentBalanceCalcMt: rs.reduce((s, r) => s + r.assignmentBalanceCalcMt, 0),
    cuttingBalanceMt:        rs.reduce((s, r) => s + r.cuttingBalanceMt,        0),
    hgBalanceMt:             rs.reduce((s, r) => s + r.hgBalanceMt,             0),
    rfiBalanceMt:            rs.reduce((s, r) => s + r.rfiBalanceMt,            0),
    nhBalanceMt:             rs.reduce((s, r) => s + r.nhBalanceMt,             0),
    bBalanceMt:              rs.reduce((s, r) => s + r.bBalanceMt,              0),
    habBalanceMt:            rs.reduce((s, r) => s + r.habBalanceMt,            0),
    wBalanceMt:              rs.reduce((s, r) => s + r.wBalanceMt,              0),
    qualityCheckBalanceMt:   rs.reduce((s, r) => s + r.qualityCheckBalanceMt,   0),
  };
  return { ...sums, totalFabBalanceMt: fabTotal(sums) };
}

// Build the 3-level structure: BOM Label → Sub-Type Group → Project rows.
type SubTypeGroup = {
  subType: string;
  rows: FabricationProjectCompletionRow[];
  subtotal: FabSums;
};
type BomGroup = {
  label: string;
  subGroups: SubTypeGroup[];
  subtotal: FabSums;
};

function buildBomGroups(rows: FabricationProjectCompletionRow[]): BomGroup[] {
  // Level 1: BOM Label
  const bomMap = new Map<string, FabricationProjectCompletionRow[]>();
  for (const row of rows) {
    const list = bomMap.get(row.bomLabel) ?? [];
    list.push(row);
    bomMap.set(row.bomLabel, list);
  }
  return [...bomMap.entries()]
    .sort(([a], [b]) => bomLabelIndex(a) - bomLabelIndex(b))
    .map(([label, bomRows]) => {
      // Level 2: Sub-Type Group
      const stMap = new Map<string, FabricationProjectCompletionRow[]>();
      for (const row of bomRows) {
        const list = stMap.get(row.subTypeGroup) ?? [];
        list.push(row);
        stMap.set(row.subTypeGroup, list);
      }
      const subGroups: SubTypeGroup[] = [...stMap.entries()]
        .sort(([a], [b]) => subTypeIndex(a) - subTypeIndex(b))
        .map(([subType, stRows]) => ({
          subType,
          rows: [...stRows].sort((a, b) => a.project.localeCompare(b.project)),
          subtotal: sumRows(stRows),
        }));
      return { label, subGroups, subtotal: sumRows(bomRows) };
    });
}

// ---------------------------------------------------------------------------
// Checkbox multi-project selector — same pattern as the Bucket List page.
// `selected = null` means "all"; a Set means those specific projects.
// ---------------------------------------------------------------------------
function FabProjectCheckboxFilter({
  projects,
  selected,
  onChange,
}: {
  projects: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
}) {
  if (projects.length === 0) return null;

  const allSelected = selected === null;
  const selectedCount = allSelected ? projects.length : selected.size;

  const toggle = (project: string) => {
    const current = allSelected ? new Set(projects) : new Set(selected);
    if (current.has(project)) current.delete(project);
    else current.add(project);
    onChange(current.size === projects.length ? null : current);
  };

  return (
    <Card className="border-border mb-3">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">
            Projects{" "}
            <span className="text-muted-foreground font-normal">
              ({selectedCount}/{projects.length} selected)
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange(null)}
              disabled={allSelected}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange(new Set())}
              disabled={selectedCount === 0}
            >
              Clear all
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-x-4 gap-y-2 max-h-40 overflow-auto pr-1">
          {projects.map((p) => {
            const checked = allSelected || selected.has(p);
            return (
              <label
                key={p}
                className="flex items-center gap-1.5 text-sm cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary shrink-0"
                  checked={checked}
                  onChange={() => toggle(p)}
                />
                <span>{p}</span>
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// Excel columns include Sub-Type Group between BOM Label and Project.
const FAB_COMP_COLUMNS: XlsxColumn[] = [
  { label: "BOM Label",                                   field: "bomLabel" },
  { label: "Sub-Type Group",                              field: "subTypeGroup" },
  { label: "Project",                                     field: "project" },
  { label: "MFC Batch",                                   field: "mfcBatch" },
  { label: "Release Balance Calc (MT)",                   field: "releaseBalanceCalcMt",    numeric: true, decimals: 3, total: true },
  { label: "Assignment Balance Calc (MT)",                field: "assignmentBalanceCalcMt", numeric: true, decimals: 3, total: true },
  { label: "Cutting Balance — C (MT)",                    field: "cuttingBalanceMt",        numeric: true, decimals: 3, total: true },
  { label: "HG Balance (MT)",                             field: "hgBalanceMt",             numeric: true, decimals: 3, total: true },
  { label: "RFI Balance (MT)",                            field: "rfiBalanceMt",            numeric: true, decimals: 3, total: true },
  { label: "NH Balance (MT)",                             field: "nhBalanceMt",             numeric: true, decimals: 3, total: true },
  { label: "B Balance (MT)",                              field: "bBalanceMt",              numeric: true, decimals: 3, total: true },
  { label: "HAB Balance (MT)",                            field: "habBalanceMt",            numeric: true, decimals: 3, total: true },
  { label: "W Balance (MT)",                              field: "wBalanceMt",              numeric: true, decimals: 3, total: true },
  { label: "Quality Check — Q+TS (MT)",                   field: "qualityCheckBalanceMt",   numeric: true, decimals: 3, total: true },
  // Total = Release + Cutting + HG + RFI + NH + B + HAB + W + Quality.
  // Assignment Balance is EXCLUDED — it overlaps Release (Initial) and Cutting (Authorized-JCNS).
  { label: "Total Fabrication Balance (excl. Assignment)", field: "totalFabBalanceMt",       numeric: true, decimals: 3, total: true },
];

function FabCompletionReport() {
  const { data, isLoading } = useGetFabricationProjectCompletionTlt();
  const { filters } = useTracker();
  const activeJobSet = useActiveJobSet();

  // Rows after the global job filter (All / single project / named template set).
  const jobFilteredRows: FabricationProjectCompletionRow[] = useMemo(() => {
    if (!data?.rows) return [];
    if (isNamedJobSetFilter(filters.job)) {
      return data.rows.filter((r) => activeJobSet.has(r.project));
    }
    if (filters.job) return data.rows.filter((r) => r.project === filters.job);
    return data.rows;
  }, [data, filters.job, activeJobSet]);

  // Distinct projects within the current job scope — drives the checkbox list.
  const availableProjects = useMemo(
    () => [...new Set(jobFilteredRows.map((r) => r.project))].sort(),
    [jobFilteredRows],
  );

  // Checkbox refinement on top of the global filter. null = all selected.
  const [selectedProjects, setSelectedProjects] = useState<Set<string> | null>(null);

  // B / HAB / W can be collapsed into one "Special Operations" column.
  const [specOpsExpanded, setSpecOpsExpanded] = useState(false);

  // Reset checkbox selection whenever the global job scope changes.
  useEffect(() => {
    setSelectedProjects(null);
  }, [filters.job]);

  // Final rows: global filter + checkbox refinement.
  const rows = useMemo(
    () =>
      selectedProjects === null
        ? jobFilteredRows
        : jobFilteredRows.filter((r) => selectedProjects.has(r.project)),
    [jobFilteredRows, selectedProjects],
  );

  // Per-project Unknown combined total (sum of all measures).
  // Threshold: < 1.0 MT → hide that project's Unknown rows entirely;
  // >= 1.0 MT → show. If ALL projects are < 1 MT the Unknown group disappears.
  const UNKNOWN_THRESHOLD_MT = 1.0;

  const { visibleRows, visibleUnknownProjects } = useMemo(() => {
    const unknownCombined = new Map<string, number>();
    for (const r of rows) {
      if (r.bomLabel !== "Unknown") continue;
      const combined =
        r.releaseBalanceCalcMt +
        r.assignmentBalanceCalcMt +
        r.cuttingBalanceMt +
        r.hgBalanceMt +
        r.rfiBalanceMt +
        r.nhBalanceMt +
        r.bBalanceMt +
        r.habBalanceMt +
        r.wBalanceMt +
        r.qualityCheckBalanceMt;
      unknownCombined.set(r.project, (unknownCombined.get(r.project) ?? 0) + combined);
    }
    const visibleUnknownProjects = new Set(
      [...unknownCombined.entries()]
        .filter(([, v]) => v >= UNKNOWN_THRESHOLD_MT)
        .map(([p]) => p),
    );
    const visibleRows = rows.filter(
      (r) => r.bomLabel !== "Unknown" || visibleUnknownProjects.has(r.project),
    );
    return { visibleRows, visibleUnknownProjects };
  }, [rows]);

  // 3-level grouping: BOM Label → Sub-Type Group → Project.
  const bomGroups = useMemo(() => buildBomGroups(visibleRows), [visibleRows]);

  const grandTotal = useMemo(() => sumRows(visibleRows), [visibleRows]);

  // Cause footer: shown below the Unknown group only when at least one
  // Unknown project passes the threshold. Groups by mismatch vs. absent.
  const unknownCauseFooter = useMemo(() => {
    if (!data?.unknownCauses || visibleUnknownProjects.size === 0) return null;
    const visibleCauses = data.unknownCauses.filter((c) =>
      visibleUnknownProjects.has(c.project),
    );
    if (visibleCauses.length === 0) return null;

    const mismatches: string[] = [];
    const absents: string[] = [];

    for (const pc of visibleCauses) {
      const mParts = pc.structures
        .filter((s) => s.cause === "mismatch")
        .map((s) => {
          const arrow = s.candidates.join("/");
          return `${s.wip}\u2192${arrow}${s.ambiguous ? " (ambiguous)" : ""}`;
        });
      const aParts = pc.structures
        .filter((s) => s.cause === "absent")
        .map((s) => s.wip);

      if (mParts.length > 0) mismatches.push(`${pc.project} [${mParts.join(", ")}]`);
      if (aParts.length > 0) absents.push(`${pc.project} [${aParts.join(", ")}]`);
    }

    return { mismatches, absents };
  }, [data?.unknownCauses, visibleUnknownProjects]);

  function handleExportExcel() {
    const date = new Date().toISOString().slice(0, 10);

    const subtotalValues = (s: FabSums) => ({
      releaseBalanceCalcMt:    s.releaseBalanceCalcMt,
      assignmentBalanceCalcMt: s.assignmentBalanceCalcMt,
      cuttingBalanceMt:        s.cuttingBalanceMt,
      hgBalanceMt:             s.hgBalanceMt,
      rfiBalanceMt:            s.rfiBalanceMt,
      nhBalanceMt:             s.nhBalanceMt,
      bBalanceMt:              s.bBalanceMt,
      habBalanceMt:            s.habBalanceMt,
      wBalanceMt:              s.wBalanceMt,
      qualityCheckBalanceMt:   s.qualityCheckBalanceMt,
      // Assignment excluded (double-counts Release + Cutting).
      totalFabBalanceMt:       s.totalFabBalanceMt,
    });

    // Summary sheet: one section per sub-group. Each section's summaryRows
    // contains the sub-type subtotal immediately after its rows, and the last
    // sub-group of each BOM label also carries the BOM-level total — so every
    // subtotal/total appears directly below the rows it summarises.
    const summarySections: XlsxSection[] = [];
    for (const bom of bomGroups) {
      bom.subGroups.forEach((sg, si) => {
        const isLast = si === bom.subGroups.length - 1;
        summarySections.push({
          rows: sg.rows,
          summaryRows: [
            {
              label: `${bom.label} / ${sg.subType} Subtotal`,
              values: subtotalValues(sg.subtotal),
              level: "subtotal" as const,
            },
            ...(isLast
              ? [{ label: `${bom.label} Total`, values: subtotalValues(bom.subtotal), level: "total" as const }]
              : []),
          ],
        });
      });
    }

    // Per-BOM-label sheets: one section per sub-group with its subtotal inline.
    const bomSheets = bomGroups.map((bom) => ({
      name: bom.label,
      columns: FAB_COMP_COLUMNS,
      sections: bom.subGroups.map((sg) => ({
        rows: sg.rows,
        summaryRows: [
          {
            label: `${sg.subType} Subtotal`,
            values: subtotalValues(sg.subtotal),
            level: "subtotal" as const,
          },
        ],
      })),
    }));

    exportToXlsxSheets(`fab_completion_tlt_${date}.xlsx`, [
      { name: "Summary", columns: FAB_COMP_COLUMNS, sections: summarySections },
      ...bomSheets,
    ]);
  }

  if (isLoading) {
    return (
      <Card className="border-border">
        <CardContent className="py-6 text-sm text-muted-foreground">
          Loading...
        </CardContent>
      </Card>
    );
  }

  if (!data?.available) {
    return (
      <Card className="border-border">
        <CardContent className="py-6 text-sm text-muted-foreground">
          No WIP import available. Upload a WIP file to generate this report.
        </CardContent>
      </Card>
    );
  }

  const fmt = (n: number) => n.toFixed(3);

  return (
    <div className="space-y-0">
      <FabProjectCheckboxFilter
        projects={availableProjects}
        selected={selectedProjects}
        onChange={setSelectedProjects}
      />
      {rows.length === 0 ? (
        <Card className="border-border">
          <CardContent className="py-6 text-sm text-muted-foreground">
            No TLT data for the selected filters.
          </CardContent>
        </Card>
      ) : (
      <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-center justify-between gap-3">
          Fabrication Report – Project Completion - TLT
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={!rows.length}
            onClick={handleExportExcel}
          >
            <FileSpreadsheet className="w-4 h-4" /> Export Excel
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          {/* specOps(s) = collapsed B+HAB+W combined weight */}
          {(() => {
            const specOps = (b: number, hab: number, w: number) => b + hab + w;
            // total column count: +1 for MFC Batch, +1 for Total Fab Balance (13 collapsed, 15 expanded)
            const totalCols = specOpsExpanded ? 15 : 13;
            const fabGroupSpan = specOpsExpanded ? 8 : 6;
            const TOTAL_COL_TOOLTIP =
              "Total Fabrication Balance = Release + Cutting + HG + RFI + NH + B + HAB + W + Quality (Q/TS).\n" +
              "Assignment Balance is excluded because it overlaps Release Balance (Initial marks) and Cutting Balance (Authorized-JCNS marks) — including it would double-count those weights.";

            return (
          <table className="w-full text-xs border-collapse">
            <thead>
              {/* Row 1: group spans */}
              <tr className="border-b border-border/50 bg-muted/60">
                <th className="text-left px-3 py-2 font-semibold border-r border-border/30" rowSpan={2}>
                  BOM Label
                </th>
                <th className="text-left px-3 py-2 font-semibold border-r border-border/30" rowSpan={2}>
                  Sub-Type
                </th>
                <th className="text-left px-3 py-2 font-semibold border-r border-border/30" rowSpan={2}>
                  Project
                </th>
                <th className="text-left px-3 py-2 font-semibold border-r border-border/30" rowSpan={2}>
                  MFC Batch
                </th>
                <th className="text-center px-2 py-1.5 font-semibold border-r border-border/30 text-indigo-700 dark:text-indigo-400" colSpan={2}>
                  Pre-Production (MT)
                </th>
                <th className="text-center px-2 py-1.5 font-semibold text-amber-700 dark:text-amber-400" colSpan={fabGroupSpan}>
                  Fabrication Stage Balance (MT) — C → HG → RFI → NH → {specOpsExpanded ? "B → HAB → W" : "Spec. Ops"} → Q/TS
                </th>
                {/* Total column — rowSpan=2 so it spans both header rows */}
                <th
                  className="text-right px-2 py-1.5 font-semibold min-w-[72px] leading-tight border-l-2 border-border/50 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 cursor-help"
                  rowSpan={2}
                  title={TOTAL_COL_TOOLTIP}
                >
                  Total Fab<br />Balance ⓘ<br /><span className="font-normal text-[10px] opacity-70">(excl. Assign.)</span>
                </th>
              </tr>
              {/* Row 2: individual column labels */}
              <tr className="border-b-2 border-border bg-muted/40">
                <th className="text-right px-2 py-1.5 font-medium min-w-[72px] leading-tight text-indigo-700 dark:text-indigo-400">
                  Release<br />Bal. Calc
                </th>
                <th className="text-right px-2 py-1.5 font-medium min-w-[72px] leading-tight border-r border-border/30 text-indigo-700 dark:text-indigo-400">
                  Assign.<br />Bal. Calc
                </th>
                <th className="text-right px-2 py-1.5 font-medium min-w-[52px] leading-tight text-amber-700 dark:text-amber-400">
                  Cutting<br />(C)
                </th>
                <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">HG</th>
                <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">RFI</th>
                <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">NH</th>
                {specOpsExpanded ? (
                  <>
                    <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">
                      <button
                        onClick={() => setSpecOpsExpanded(false)}
                        className="inline-flex items-center gap-0.5 hover:text-amber-900 dark:hover:text-amber-200 transition-colors"
                        title="Collapse B / HAB / W into Special Operations"
                      >B <span className="text-[10px]">◀</span></button>
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">HAB</th>
                    <th className="text-right px-2 py-1.5 font-medium min-w-[44px] leading-tight text-amber-700 dark:text-amber-400">W</th>
                  </>
                ) : (
                  <th
                    className="text-right px-2 py-1.5 font-medium min-w-[80px] leading-tight text-amber-700 dark:text-amber-400 cursor-pointer hover:bg-amber-50 dark:hover:bg-amber-950/30 select-none transition-colors"
                    onClick={() => setSpecOpsExpanded(true)}
                    title="Expand into B / HAB / W columns"
                  >
                    <span className="inline-flex items-center justify-end gap-0.5 w-full">
                      Special<br />Ops <span className="text-[10px]">▶</span>
                    </span>
                  </th>
                )}
                <th className="text-right px-2 py-1.5 font-medium min-w-[56px] leading-tight text-amber-700 dark:text-amber-400">
                  Quality<br />(Q/TS)
                </th>
              </tr>
            </thead>
            <tbody>
              {bomGroups.map((bom, bomIdx) => (
                <>
                  {bom.subGroups.map((sg, sgIdx) => (
                    <>
                      {sg.rows.map((row, rowIdx) => (
                        <tr
                          key={`${row.bomLabel}-${row.subTypeGroup}-${row.project}-${row.mfcBatch ?? ""}`}
                          className="border-b border-border/40 hover:bg-muted/30"
                        >
                          <td className="px-3 py-1.5 text-muted-foreground border-r border-border/20">
                            {sgIdx === 0 && rowIdx === 0 ? row.bomLabel : ""}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground border-r border-border/20">
                            {rowIdx === 0 ? row.subTypeGroup : ""}
                          </td>
                          <td className="px-3 py-1.5 font-medium border-r border-border/20">{row.project}</td>
                          <td className="px-3 py-1.5 border-r border-border/20 text-muted-foreground">{row.mfcBatch ?? ""}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-indigo-800 dark:text-indigo-300">
                            {fmt(row.releaseBalanceCalcMt)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums border-r border-border/20 text-indigo-800 dark:text-indigo-300">
                            {fmt(row.assignmentBalanceCalcMt)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.cuttingBalanceMt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.hgBalanceMt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.rfiBalanceMt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.nhBalanceMt)}</td>
                          {specOpsExpanded ? (
                            <>
                              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.bBalanceMt)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.habBalanceMt)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.wBalanceMt)}</td>
                            </>
                          ) : (
                            <td className="px-2 py-1.5 text-right tabular-nums bg-amber-50/40 dark:bg-amber-950/10">
                              {fmt(specOps(row.bBalanceMt, row.habBalanceMt, row.wBalanceMt))}
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.qualityCheckBalanceMt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-medium border-l-2 border-border/50 bg-emerald-50/40 dark:bg-emerald-950/10 text-emerald-900 dark:text-emerald-200">
                            {fmt(fabTotal(row))}
                          </td>
                        </tr>
                      ))}
                      {/* Sub-type subtotal row */}
                      <tr
                        key={`${bom.label}-${sg.subType}-subtotal`}
                        className="border-b border-border bg-muted/25 font-medium"
                      >
                        <td className="px-3 py-1.5 border-r border-border/20" />
                        <td className="px-3 py-1.5 text-muted-foreground italic border-r border-border/20">
                          {sg.subType} Subtotal
                        </td>
                        <td className="px-3 py-1.5 border-r border-border/20" />
                        <td className="px-3 py-1.5 border-r border-border/20" />
                        <td className="px-2 py-1.5 text-right tabular-nums text-indigo-800 dark:text-indigo-300">
                          {fmt(sg.subtotal.releaseBalanceCalcMt)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums border-r border-border/20 text-indigo-800 dark:text-indigo-300">
                          {fmt(sg.subtotal.assignmentBalanceCalcMt)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.cuttingBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.hgBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.rfiBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.nhBalanceMt)}</td>
                        {specOpsExpanded ? (
                          <>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.bBalanceMt)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.habBalanceMt)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.wBalanceMt)}</td>
                          </>
                        ) : (
                          <td className="px-2 py-1.5 text-right tabular-nums bg-amber-50/40 dark:bg-amber-950/10">
                            {fmt(specOps(sg.subtotal.bBalanceMt, sg.subtotal.habBalanceMt, sg.subtotal.wBalanceMt))}
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(sg.subtotal.qualityCheckBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold border-l-2 border-border/50 bg-emerald-50/40 dark:bg-emerald-950/10 text-emerald-900 dark:text-emerald-200">
                          {fmt(sg.subtotal.totalFabBalanceMt)}
                        </td>
                      </tr>
                    </>
                  ))}
                  {/* BOM label total row */}
                  <tr
                    key={`${bom.label}-total`}
                    className="border-b-2 border-border bg-muted/40 font-semibold"
                  >
                    <td className="px-3 py-1.5 border-r border-border/20">{bom.label}</td>
                    <td className="px-3 py-1.5 text-muted-foreground border-r border-border/20">Total</td>
                    <td className="px-3 py-1.5 border-r border-border/20" />
                    <td className="px-3 py-1.5 border-r border-border/20" />
                    <td className="px-2 py-1.5 text-right tabular-nums text-indigo-800 dark:text-indigo-300">
                      {fmt(bom.subtotal.releaseBalanceCalcMt)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums border-r border-border/20 text-indigo-800 dark:text-indigo-300">
                      {fmt(bom.subtotal.assignmentBalanceCalcMt)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.cuttingBalanceMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.hgBalanceMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.rfiBalanceMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.nhBalanceMt)}</td>
                    {specOpsExpanded ? (
                      <>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.bBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.habBalanceMt)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.wBalanceMt)}</td>
                      </>
                    ) : (
                      <td className="px-2 py-1.5 text-right tabular-nums bg-amber-50/40 dark:bg-amber-950/10">
                        {fmt(specOps(bom.subtotal.bBalanceMt, bom.subtotal.habBalanceMt, bom.subtotal.wBalanceMt))}
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(bom.subtotal.qualityCheckBalanceMt)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-bold border-l-2 border-border/50 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-200">
                      {fmt(bom.subtotal.totalFabBalanceMt)}
                    </td>
                  </tr>
                  {/* Cause footer — only for the Unknown group when visible */}
                  {bom.label === "Unknown" && unknownCauseFooter && (
                    <tr key="unknown-cause-footer">
                      <td
                        colSpan={totalCols}
                        className="px-3 py-2 text-xs text-muted-foreground border-b border-border bg-muted/10"
                      >
                        <span className="font-medium text-foreground">
                          Unknown structures (cause):
                        </span>
                        {unknownCauseFooter.mismatches.length > 0 && (
                          <div className="mt-0.5">
                            <span className="font-medium">
                              Code mismatch (in OR under a different code):{" "}
                            </span>
                            {unknownCauseFooter.mismatches.join("; ")}
                          </div>
                        )}
                        {unknownCauseFooter.absents.length > 0 && (
                          <div className="mt-0.5">
                            <span className="font-medium">
                              Absent from Order Review:{" "}
                            </span>
                            {unknownCauseFooter.absents.join("; ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted font-bold">
                <td className="px-3 py-2 border-r border-border/20" colSpan={4}>
                  Grand Total
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-indigo-800 dark:text-indigo-300">
                  {fmt(grandTotal.releaseBalanceCalcMt)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums border-r border-border/20 text-indigo-800 dark:text-indigo-300">
                  {fmt(grandTotal.assignmentBalanceCalcMt)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.cuttingBalanceMt)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.hgBalanceMt)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.rfiBalanceMt)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.nhBalanceMt)}</td>
                {specOpsExpanded ? (
                  <>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.bBalanceMt)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.habBalanceMt)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.wBalanceMt)}</td>
                  </>
                ) : (
                  <td className="px-2 py-2 text-right tabular-nums bg-amber-50/40 dark:bg-amber-950/10">
                    {fmt(specOps(grandTotal.bBalanceMt, grandTotal.habBalanceMt, grandTotal.wBalanceMt))}
                  </td>
                )}
                <td className="px-2 py-2 text-right tabular-nums">{fmt(grandTotal.qualityCheckBalanceMt)}</td>
                <td className="px-2 py-2 text-right tabular-nums border-l-2 border-border/60 bg-emerald-100/60 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200">
                  {fmt(grandTotal.totalFabBalanceMt)}
                </td>
              </tr>
            </tfoot>
          </table>
            );
          })()}
        </div>
      </CardContent>
    </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily Production Movement Report (Activity Wise)
// ---------------------------------------------------------------------------

function fmtMoveDateRpt(iso: string): string {
  const parts = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${parseInt(parts[2])} ${months[parseInt(parts[1]) - 1]}`;
}

function DailyProductionMovementReport() {
  const { selectedImportId, filters } = useTracker();
  const { data: allRecords, isLoading } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) },
  });
  const records = useFilteredRecords(allRecords);

  // Production movement: consecutive-import cutting output + net balance delta.
  const { data: productionMovement, isLoading: isMovementLoading } =
    useGetImportProductionMovement(selectedImportId as number, {
      query: {
        enabled: !!selectedImportId,
        queryKey: getGetImportProductionMovementQueryKey(selectedImportId as number),
      },
    });

  const { moveWindow, isDateFiltered } = useMemo(() => {
    const win = filters.dateRange ? dateRangeWindow(filters.dateRange) : null;
    if (win) {
      return {
        moveWindow: { start: win.start.toISOString().slice(0, 10), end: win.end.toISOString().slice(0, 10) },
        isDateFiltered: true,
      };
    }
    const todayStr = new Date().toISOString().slice(0, 10);
    return { moveWindow: { start: todayStr, end: todayStr }, isDateFiltered: false };
  }, [filters.dateRange]);

  // dayKey (import date) → cutting output in kg, consistent with balanceWt units used elsewhere.
  const cuttingByDayKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of productionMovement?.days ?? []) {
      if (day.cuttingOutputMt > 0) {
        map.set(day.dayKey, day.cuttingOutputMt * 1000);
      }
    }
    return map;
  }, [productionMovement]);

  // Days to show in the Net Balance panel, optionally filtered to the active date window.
  const filteredProductionMovementDays = useMemo((): ProductionMovementDay[] => {
    const allDays = productionMovement?.days ?? [];
    if (!isDateFiltered) return allDays;
    return allDays.filter((d) => d.dayKey >= moveWindow.start && d.dayKey <= moveWindow.end);
  }, [productionMovement, isDateFiltered, moveWindow]);

  const moveDates = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const seen = new Set<string>();
    // Dates from lastProductionDate on records (non-C activities)
    for (const r of records) {
      const lpd = r.lastProductionDate as string | null;
      if (!lpd) continue;
      if (isDateFiltered) {
        if (lpd < moveWindow.start || lpd > moveWindow.end) continue;
      } else {
        if (lpd > todayStr) continue;
      }
      seen.add(lpd);
    }
    // Also include import day keys that have cutting output (C activity)
    for (const dk of cuttingByDayKey.keys()) {
      if (isDateFiltered) {
        if (dk < moveWindow.start || dk > moveWindow.end) continue;
      } else {
        if (dk > todayStr) continue;
      }
      seen.add(dk);
    }
    return [...seen].sort().slice(-7);
  }, [records, moveWindow, isDateFiltered, cuttingByDayKey]);

  const { activities, sortedActivities } = useMemo(() => {
    const activities = new Map<string, any[]>();
    for (const r of records) {
      if (isCutting(r.activity) && !isActiveCutting(r)) continue;
      const act = r.activity || "Unassigned";
      if (!activities.has(act)) activities.set(act, []);
      activities.get(act)!.push(r);
    }
    return { activities, sortedActivities: Array.from(activities.keys()).sort(compareActivity) };
  }, [records]);

  const summaryRows = useMemo(
    () => sortedActivities.map((act) => {
      const recs = activities.get(act) ?? [];
      // C row: mark-level cutting output from consecutive import comparison (not LPD-based).
      // All other activities: sum balanceWt for marks whose lastProductionDate matches the column date.
      const perDate =
        act === "C"
          ? moveDates.map((d) => cuttingByDayKey.get(d) ?? 0)
          : moveDates.map((d) =>
              recs.reduce((s: number, r: any) => (r.lastProductionDate === d ? s + (r.balanceWt ?? 0) : s), 0),
            );
      return { act, perDate, total: perDate.reduce((s, v) => s + v, 0) };
    }),
    [sortedActivities, activities, moveDates, cuttingByDayKey],
  );

  const colTotals = useMemo(
    () => moveDates.map((_, di) => summaryRows.reduce((s, row) => s + row.perDate[di], 0)),
    [summaryRows, moveDates],
  );
  const grandTotal = colTotals.reduce((s, v) => s + v, 0);

  const handleExport = () => {
    const dateCols: XlsxColumn[] = moveDates.map((d, i) => ({
      label: fmtMoveDateRpt(d),
      field: `d${i}`,
      numeric: true,
      decimals: 3,
      total: true,
    }));

    // Summary sheet
    const summarySheet: XlsxSheet = {
      name: "Summary",
      columns: [
        { label: "Activity", field: "activity" },
        ...dateCols,
        { label: "Total (MT)", field: "total", numeric: true, decimals: 3, total: true },
      ],
      rows: summaryRows.map((row) => {
        const obj: Record<string, any> = { activity: row.act, total: row.total };
        row.perDate.forEach((v, i) => { obj[`d${i}`] = v > 0 ? v : null; });
        return obj;
      }),
    };

    // Per-activity sheets: Contractor × date drill-down
    const actSheets: XlsxSheet[] = sortedActivities.flatMap((act) => {
      const recs = activities.get(act) ?? [];
      const conMap = new Map<string, number[]>();
      for (const r of recs as any[]) {
        const lpd = r.lastProductionDate as string | null;
        if (!lpd) continue;
        const di = moveDates.indexOf(lpd);
        if (di === -1) continue;
        const con = r.contractor || "(No Contractor)";
        if (!conMap.has(con)) conMap.set(con, moveDates.map(() => 0));
        conMap.get(con)![di] += r.balanceWt ?? 0;
      }
      if (conMap.size === 0) return [];
      const sorted = [...conMap.keys()].sort(
        (a, b) =>
          (conMap.get(b)!.reduce((s, v) => s + v, 0)) -
          (conMap.get(a)!.reduce((s, v) => s + v, 0)),
      );
      return [{
        name: act,
        columns: [
          { label: "Contractor", field: "contractor" },
          ...dateCols,
          { label: "Total (MT)", field: "total", numeric: true, decimals: 3, total: true },
        ],
        rows: sorted.map((con) => {
          const perDate = conMap.get(con)!;
          const obj: Record<string, any> = { contractor: con, total: perDate.reduce((s, v) => s + v, 0) };
          perDate.forEach((v, i) => { obj[`d${i}`] = v > 0 ? v : null; });
          return obj;
        }),
      }];
    });

    void exportToXlsxSheets(
      `Daily_Production_Movement_Activity_Wise_${new Date().toISOString().slice(0, 10)}.xlsx`,
      [summarySheet, ...actSheets],
    );
  };

  if (!selectedImportId) {
    return <div className="text-center p-8 text-muted-foreground">No import selected.</div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base font-semibold">Daily Production Movement — Activity Wise</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {isDateFiltered
                  ? `Filtered period: ${moveWindow.start} to ${moveWindow.end} — showing dates with production in this range`
                  : `Last ${moveDates.length} production days in the data`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 shrink-0"
              onClick={handleExport}
              disabled={moveDates.length === 0 || sortedActivities.length === 0}
            >
              <FileSpreadsheet className="h-4 w-4" /> Download Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : moveDates.length === 0 && !isMovementLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No production dates found. Apply a date filter to see movement data.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left px-4 py-2.5 font-semibold min-w-[90px]">Activity</th>
                    {moveDates.map((d) => (
                      <th key={d} className="text-right px-4 py-2.5 font-semibold text-primary/80 whitespace-nowrap min-w-[80px]">
                        {fmtMoveDateRpt(d)}
                      </th>
                    ))}
                    <th className="text-right px-4 py-2.5 font-semibold min-w-[80px]">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {summaryRows.map(({ act, perDate, total }) => (
                    <tr key={act} className={total > 0 ? "hover:bg-muted/30" : "opacity-40"}>
                      <td className="px-4 py-2 font-bold font-mono">
                        {act}
                        {act === "C" && (
                          <span
                            title="Mark-level cutting output: marks that left C + weight reduction of marks still at C, compared between consecutive imports. Excludes intake."
                            className="ml-1 text-[10px] text-muted-foreground cursor-help align-super"
                          >*</span>
                        )}
                      </td>
                      {perDate.map((wt, i) => (
                        <td key={moveDates[i]} className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                          {wt > 0
                            ? <span className="text-primary font-semibold">{formatWeight(wt)}</span>
                            : <span className="text-muted-foreground text-xs">-</span>}
                        </td>
                      ))}
                      <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap">
                        {total > 0 ? formatWeight(total) : <span className="text-muted-foreground text-xs">-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-muted/30 font-bold">
                    <td className="px-4 py-2.5">Total</td>
                    {colTotals.map((wt, i) => (
                      <td key={moveDates[i]} className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {wt > 0 ? formatWeight(wt) : "-"}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                      {grandTotal > 0 ? formatWeight(grandTotal) : "-"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <NetBalanceMovementPanel
        days={filteredProductionMovementDays}
        isLoading={isMovementLoading}
      />
    </div>
  );
}

function ActivityNetMovementReport() {
  const { selectedImportId, filters } = useTracker();
  const { data: productionMovement, isLoading } = useGetImportProductionMovement(
    selectedImportId as number,
    { query: { enabled: !!selectedImportId, queryKey: getGetImportProductionMovementQueryKey(selectedImportId as number) } },
  );

  const filteredDays = useMemo((): ProductionMovementDay[] => {
    const allDays = productionMovement?.days ?? [];
    if (!filters.dateRange) return allDays;
    const win = dateRangeWindow(filters.dateRange);
    if (!win) return allDays;
    const start = win.start.toISOString().slice(0, 10);
    const end = win.end.toISOString().slice(0, 10);
    return allDays.filter((d) => d.dayKey >= start && d.dayKey <= end);
  }, [productionMovement, filters.dateRange]);

  return (
    <div className="space-y-4">
      <NetBalanceMovementPanel days={filteredDays} isLoading={isLoading} />
    </div>
  );
}

function ContractorNetMovementReport() {
  const { selectedImportId } = useTracker();
  const { data: movementData, isLoading } = useGetImportContractorMovement(
    selectedImportId as number,
    { query: { enabled: !!selectedImportId, queryKey: getGetImportContractorMovementQueryKey(selectedImportId as number) } },
  );

  return (
    <div className="space-y-4">
      <ContractorNetMovementPanel days={movementData?.days ?? []} isLoading={isLoading} />
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
      ) : reportType === "contractorperf" ? (
        <ContractorPerformanceReport />
      ) : reportType === "fabcompletion" ? (
        <FabCompletionReport />
      ) : reportType === "dailymov" ? (
        <DailyProductionMovementReport />
      ) : reportType === "activitymov" ? (
        <ActivityNetMovementReport />
      ) : reportType === "contractormov" ? (
        <ContractorNetMovementReport />
      ) : (
        <AiTurnaroundReport />
      )}
    </div>
  );
}
