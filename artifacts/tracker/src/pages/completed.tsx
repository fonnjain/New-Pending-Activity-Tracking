import { useMemo, useState } from "react";
import { useTracker } from "@/lib/store";
import {
  useGetMilestones,
  getGetMilestonesQueryKey,
  type ProjectMilestone,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtDays } from "@/lib/velocity";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import { FileSpreadsheet, AlertTriangle, RotateCcw } from "lucide-react";

type Status = "dispatched" | "ready" | "progress";

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  dispatched: {
    label: "Fully dispatched",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  ready: {
    label: "In yard awaiting dispatch",
    cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  progress: {
    label: "In progress",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
};

function statusOf(m: ProjectMilestone): Status {
  if (m.dispatchedDate) return "dispatched";
  if (m.readyDate) return "ready";
  return "progress";
}

function fmtDate(d: string | null): string {
  return d ?? "-";
}

function fmtSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const v = Number(n.toFixed(1));
  return v > 0 ? `+${v}` : `${v}`;
}

type SortKey = "status" | "project" | "marks" | "readyDays" | "variance";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
  { value: "marks", label: "Marks" },
  { value: "readyDays", label: "Ready days" },
  { value: "variance", label: "Variance" },
];

export default function CompletedView() {
  const { filters } = useTracker();
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const { data, isLoading } = useGetMilestones({
    query: { queryKey: getGetMilestonesQueryKey() },
  });

  const all = data?.items ?? [];

  // Honour the global Job filter so this view stays consistent with the rest of
  // the app; all other filters (activity/contractor/etc.) do not apply to a
  // per-project milestone.
  const rows = useMemo(() => {
    const filtered = filters.job ? all.filter((m) => m.project === filters.job) : all;
    // Dispatched first, then in-yard (ready), then in-progress.
    const rank: Record<Status, number> = { dispatched: 0, ready: 1, progress: 2 };
    const byProject = (a: ProjectMilestone, b: ProjectMilestone) =>
      a.project.localeCompare(b.project);
    const numDesc = (av: number | null | undefined, bv: number | null | undefined) =>
      (bv ?? -Infinity) - (av ?? -Infinity);
    return [...filtered].sort((a, b) => {
      let primary = 0;
      switch (sortKey) {
        case "project":
          primary = byProject(a, b);
          break;
        case "marks":
          primary = numDesc(a.marksTotal, b.marksTotal);
          break;
        case "readyDays":
          primary = numDesc(a.readyTurnaroundDays, b.readyTurnaroundDays);
          break;
        case "variance":
          primary = numDesc(a.varianceReadyDays, b.varianceReadyDays);
          break;
        case "status":
        default:
          primary = rank[statusOf(a)] - rank[statusOf(b)];
          break;
      }
      if (primary !== 0) return primary;
      return byProject(a, b);
    });
  }, [all, filters.job, sortKey]);

  const rollup = useMemo(() => {
    let dispatched = 0;
    let ready = 0;
    let progress = 0;
    let readySum = 0;
    let readyCount = 0;
    let varSum = 0;
    let varCount = 0;
    for (const m of rows) {
      const s = statusOf(m);
      if (s === "dispatched") dispatched++;
      else if (s === "ready") ready++;
      else progress++;
      if (m.readyTurnaroundDays != null) {
        readySum += m.readyTurnaroundDays;
        readyCount++;
      }
      if (m.varianceReadyDays != null) {
        varSum += m.varianceReadyDays;
        varCount++;
      }
    }
    return {
      total: rows.length,
      dispatched,
      ready,
      progress,
      avgReady: readyCount ? readySum / readyCount : null,
      avgVariance: varCount ? varSum / varCount : null,
    };
  }, [rows]);

  function onExport() {
    const cols: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Status", field: "status" },
      { label: "Start", field: "projectStart" },
      { label: "Ready", field: "readyDate" },
      { label: "Ready days", field: "readyTurnaroundDays", numeric: true, decimals: 0 },
      { label: "Planned", field: "plannedReadyDays", numeric: true, decimals: 0 },
      { label: "Variance", field: "varianceReadyDays", numeric: true, decimals: 1 },
      { label: "Dispatched", field: "dispatchedDate" },
      { label: "Dispatch days", field: "dispatchedTurnaroundDays", numeric: true, decimals: 0 },
      { label: "Lag", field: "dispatchLagDays", numeric: true, decimals: 0 },
      { label: "Marks", field: "marksTotal", numeric: true, decimals: 0, total: true },
      { label: "Limited history", field: "limitedHistory" },
      { label: "Reopened", field: "reopened" },
    ];
    const out = rows.map((m) => ({
      project: m.project,
      status: STATUS_META[statusOf(m)].label,
      projectStart: m.projectStart ?? "",
      readyDate: m.readyDate ?? "",
      readyTurnaroundDays: m.readyTurnaroundDays ?? "",
      plannedReadyDays: m.plannedReadyDays ?? "",
      varianceReadyDays: m.varianceReadyDays ?? "",
      dispatchedDate: m.dispatchedDate ?? "",
      dispatchedTurnaroundDays: m.dispatchedTurnaroundDays ?? "",
      dispatchLagDays: m.dispatchLagDays ?? "",
      marksTotal: m.marksTotal,
      limitedHistory: m.limitedHistory ? "yes" : "",
      reopened: m.reopened ? "yes" : "",
    }));
    void exportToXlsx(
      `turnaround_milestones_${new Date().toISOString().slice(0, 10)}.xlsx`,
      cols,
      out,
      { sheetName: "Milestones" },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Completed / Turnaround</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Permanent per-project turnaround milestones, measured from each project's
            earliest Assign Date. Ready = every mark at Y or gone; Dispatched = project
            no longer in any report.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-xs font-semibold uppercase text-muted-foreground">
              Sort by
            </span>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={rows.length === 0}
            className="gap-2"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span className="hidden sm:inline">Export Excel</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatTile label="Projects" value={String(rollup.total)} />
        <StatTile label="Dispatched" value={String(rollup.dispatched)} />
        <StatTile label="In yard" value={String(rollup.ready)} />
        <StatTile label="Avg ready (days)" value={fmtDays(rollup.avgReady)} />
        <StatTile label="Avg variance (days)" value={fmtSigned(rollup.avgVariance)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project milestones</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading milestones...</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No project milestones yet. Upload reports to begin tracking turnaround.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="px-4 py-2 font-semibold">Project</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold text-right">Start</th>
                    <th className="px-4 py-2 font-semibold text-right">Ready</th>
                    <th className="px-4 py-2 font-semibold text-right">Ready days</th>
                    <th className="px-4 py-2 font-semibold text-right">Planned</th>
                    <th className="px-4 py-2 font-semibold text-right">Variance</th>
                    <th className="px-4 py-2 font-semibold text-right">Dispatched</th>
                    <th className="px-4 py-2 font-semibold text-right">Dispatch days</th>
                    <th className="px-4 py-2 font-semibold text-right">Lag</th>
                    <th className="px-4 py-2 font-semibold text-right">Marks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const meta = STATUS_META[statusOf(m)];
                    const variance = m.varianceReadyDays;
                    const varCls =
                      variance == null
                        ? "text-muted-foreground"
                        : variance > 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-600 dark:text-emerald-400";
                    return (
                      <tr key={m.project} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-2 font-medium">
                          <div className="flex items-center gap-1.5">
                            <span>{m.project}</span>
                            {m.limitedHistory && (
                              <span title="Captured with limited history">
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              </span>
                            )}
                            {m.reopened && (
                              <span title="Returned to an earlier activity after a milestone">
                                <RotateCcw className="h-3.5 w-3.5 text-orange-500" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}
                          >
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDate(m.projectStart)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDate(m.readyDate)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDays(m.readyTurnaroundDays)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDays(m.plannedReadyDays)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${varCls}`}>{fmtSigned(variance)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDate(m.dispatchedDate)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDays(m.dispatchedTurnaroundDays)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtDays(m.dispatchLagDays)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.marksTotal}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="text-base sm:text-lg font-semibold tabular-nums mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}
