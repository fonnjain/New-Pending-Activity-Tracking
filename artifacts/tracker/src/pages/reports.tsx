import { useMemo, useState } from "react";
import { compareActivity, lifecycleStatus, migrateTurnaroundSettings, sequenceFor } from "@workspace/domain";
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
} from "@workspace/api-client-react";
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
  type XlsxColumn,
  type XlsxSummaryRow,
} from "@/lib/export";
import { formatWeight } from "@/lib/utils";
import { ageingCell } from "@/lib/ageing";
import { getAgeingColor } from "./overview";
import { AiTurnaroundReport } from "@/components/ai-turnaround-report";
import { FileSpreadsheet, Check } from "lucide-react";

type SortKey = "activity" | "ageing" | "contractor";

type ReportType = "jobwise" | "ai";

const REPORT_TYPES: { id: ReportType; name: string; description: string }[] = [
  {
    id: "jobwise",
    name: "Job Wise Report",
    description:
      "Pending work filtered by the header filters, with turnaround and velocity columns, exportable to Excel.",
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
];

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
          { activity: r.activity, ageingDays: r.ageingDays, project: r.job, sequence: sequenceFor(r) },
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
      { name: "Summary", columns: REPORT_COLUMNS, rows: enrichedRows, summaryRows: activitySubtotals },
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
                    </TableRow>
                  ))}
                </>
              )}
              {rows.length > 0 && (
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
                  </TableRow>
                </>
              )}
              {visible.map((r, i) => (
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
        {rows.length > TABLE_CAP && (
          <div className="text-xs text-muted-foreground">
            Showing first {TABLE_CAP.toLocaleString()} of {rows.length.toLocaleString()} rows. Export
            to Excel for the full set.
          </div>
        )}
      </CardContent>
    </Card>
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
      {reportType === "jobwise" ? <ReportBuilder /> : <AiTurnaroundReport />}
    </div>
  );
}
