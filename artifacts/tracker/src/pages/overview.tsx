import { useTracker, resolveActiveFilters } from "@/lib/store";
import { getImportSummary, type SummaryRequest } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { formatWeight } from "@/lib/utils";
import { useMemo } from "react";
import { ChangesPanel } from "@/components/changes-panel";
import { Clock, AlertTriangle, ChevronRight, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";

export default function Overview() {
  const { selectedImportId } = useTracker();

  if (!selectedImportId) {
    return <EmptyState />;
  }

  return <OverviewContent />;
}

function OverviewContent() {
  const { selectedImportId, filters } = useTracker();
  const importId = selectedImportId as number;

  // Build the server-summary request from the active header filters + resolved
  // date window. The window is resolved from the client's LOCAL today so the
  // server classifies dates identically regardless of its timezone.
  const request: SummaryRequest = useMemo(() => {
    const { filters: rf, dateWindow } = resolveActiveFilters(filters);
    return { filters: rf, dateWindow };
  }, [filters]);

  // Server computes every headline metric (KPIs, ageing buckets, top aged,
  // busiest contractors, lifecycle + velocity tallies) from the same shared
  // code the client used to run locally, so the numbers are identical — but we
  // no longer download the full ~40 MB records payload to render the dashboard.
  const { data: summary, isLoading } = useQuery({
    queryKey: ["importSummary", importId, request],
    queryFn: () => getImportSummary(importId, request),
    enabled: !!importId,
  });

  const ageingPct = useMemo(() => {
    if (!summary) return { p0to30: 0, p31to60: 0, p60Plus: 0, pNoAgeing: 0 };
    const totalAged =
      summary.age0to30 + summary.age31to60 + summary.age60Plus + summary.noAgeing || 1;
    return {
      p0to30: (summary.age0to30 / totalAged) * 100,
      p31to60: (summary.age31to60 / totalAged) * 100,
      p60Plus: (summary.age60Plus / totalAged) * 100,
      pNoAgeing: (summary.noAgeing / totalAged) * 100,
    };
  }, [summary]);

  if (isLoading || !summary) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const handleExport = () => {
    const sheets: XlsxSheet[] = [
      {
        name: "KPIs",
        columns: [
          { label: "Metric", field: "metric" },
          { label: "Value", field: "value", numeric: true, decimals: 2 },
        ],
        rows: [
          { metric: "Pending Marks", value: summary.totalMarks },
          { metric: "Balance Qty", value: summary.totalQty },
          { metric: "Balance Wt", value: summary.totalWt },
          { metric: "Avg Ageing (days)", value: summary.avgAgeing },
          { metric: "Contractors", value: summary.contractorsCount },
          { metric: "Structures", value: summary.structuresCount },
        ],
      },
      {
        name: "Ageing",
        columns: [
          { label: "Bucket", field: "bucket" },
          { label: "Count", field: "count", numeric: true, decimals: 0, total: true },
        ],
        rows: [
          { bucket: "0-30 days", count: summary.age0to30 },
          { bucket: "31-60 days", count: summary.age31to60 },
          { bucket: "60+ days", count: summary.age60Plus },
          { bucket: "No ageing date", count: summary.noAgeing },
        ],
      },
      {
        name: "Top Aged Marks",
        columns: [
          { label: "Mark", field: "markId" },
          { label: "Contractor", field: "contractor" },
          { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
        ],
        rows: summary.topAgedMarks.map((m) => ({
          markId: m.markId ?? "",
          contractor: m.contractor || "Unassigned",
          ageingDays: m.ageingDays,
        })),
      },
      {
        name: "Busiest Contractors",
        columns: [
          { label: "Contractor", field: "contractor" },
          { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
          { label: "Marks", field: "count", numeric: true, decimals: 0, total: true },
        ],
        rows: summary.busiestContractors.map((c) => ({
          contractor: c.contractor || "Unassigned",
          weight: c.weight,
          count: c.count,
        })),
      },
    ];
    void exportToXlsxSheets(
      `overview_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleExport}
        >
          <FileSpreadsheet className="h-4 w-4" /> Export Excel
        </Button>
      </div>
      <SnapshotCards summary={summary} />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiTile title="Pending Marks" value={summary.totalMarks} />
        <KpiTile title="Balance Qty" value={summary.totalQty.toLocaleString()} />
        <KpiTile title="Balance Wt" value={formatWeight(summary.totalWt)} />
        <KpiTile title="Avg Ageing (d)" value={summary.avgAgeing} />
        <KpiTile title="Contractors" value={summary.contractorsCount} />
        <KpiTile title="Structures" value={summary.structuresCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Ageing Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-6 rounded-sm overflow-hidden mb-3">
            <div style={{ width: `${ageingPct.p0to30}%` }} className="bg-ageing-green transition-all" title="0-30 Days" />
            <div style={{ width: `${ageingPct.p31to60}%` }} className="bg-ageing-amber transition-all" title="31-60 Days" />
            <div style={{ width: `${ageingPct.p60Plus}%` }} className="bg-ageing-red transition-all" title="60+ Days" />
            <div style={{ width: `${ageingPct.pNoAgeing}%` }} className="bg-ageing-neutral transition-all" title="No ageing date" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-green" />0-30d ({summary.age0to30})</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-amber" />31-60d ({summary.age31to60})</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-red" />60d+ ({summary.age60Plus})</div>
            <div className="flex items-center gap-1.5" title="Not started: activity C, no production date. No production date: progressed past cutting but date missing."><div className="w-3 h-3 rounded-sm bg-ageing-neutral" />No ageing date ({summary.noAgeing}) — {summary.notStarted} not started, {summary.noProductionDate} no prod. date</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase text-muted-foreground tracking-wider">Top Aged Marks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {summary.topAgedMarks.map((m, i) => (
                <div key={`${m.markId ?? ""}-${i}`} className="flex justify-between items-center text-sm p-2 bg-muted/30 hover:bg-muted/50 transition-colors rounded-md border border-transparent hover:border-border">
                  <div>
                    <div className="font-mono font-medium text-foreground">{m.markId}</div>
                    <div className="text-xs text-muted-foreground">{m.contractor || 'Unassigned'}</div>
                  </div>
                  <div className={`font-bold tabular-nums ${getAgeingColor(m.ageingDays)}`}>
                    {m.ageingDays}d
                  </div>
                </div>
              ))}
              {summary.topAgedMarks.length === 0 && <div className="text-sm text-muted-foreground">No marks with assign dates.</div>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase text-muted-foreground tracking-wider">Busiest Contractors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {summary.busiestContractors.map((stats) => (
                <div key={stats.contractor} className="flex justify-between items-center text-sm p-2 bg-muted/30 hover:bg-muted/50 transition-colors rounded-md border border-transparent hover:border-border">
                  <div className="font-medium text-foreground">{stats.contractor}</div>
                  <div className="text-right">
                    <div className="font-bold tabular-nums">{formatWeight(stats.weight)}</div>
                    <div className="text-xs text-muted-foreground">{stats.count} marks</div>
                  </div>
                </div>
              ))}
              {summary.busiestContractors.length === 0 && <div className="text-sm text-muted-foreground">No contractors found.</div>}
            </div>
          </CardContent>
        </Card>
      </div>

      {selectedImportId && <ChangesPanel importId={selectedImportId} />}
    </div>
  );
}

// Overview snapshot hub: two compact cards summarising the Turnaround and
// Velocity/Stuck pages, each linking through for the full deep-dive. The
// lifecycle + movement tallies come from the server summary (computed on the
// same identity basis as the deep-dive pages) and degrade gracefully without
// movement history.
function SnapshotCards({
  summary,
}: {
  summary: {
    lifecycle: { green: number; prewarn: number; breach: number; na: number };
    velocity: { stalled: number; slow: number; hasHistory: boolean };
  };
}) {
  const { lifecycle, velocity } = summary;

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Link href="/turnaround">
        <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
          <CardHeader className="pb-3">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Turnaround
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-2 text-center">
              <SnapStat label="On track" value={lifecycle.green} cls="bg-lc-green" />
              <SnapStat label="Pre-warn" value={lifecycle.prewarn} cls="bg-lc-prewarn2" />
              <SnapStat label="Breached" value={lifecycle.breach} cls="bg-lc-breach3" />
              <SnapStat label="n/a" value={lifecycle.na} cls="bg-lc-na" />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Open the deep-dive for the 8-state lifecycle, per-activity bars,
              overrun by contractor and the AI report.
            </p>
          </CardContent>
        </Card>
      </Link>

      <Link href="/stuck">
        <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
          <CardHeader className="pb-3">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-ageing-red" /> Stuck Projects
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 text-center">
              <SnapStat label="Stalled" value={velocity.stalled} cls="bg-red-500" />
              <SnapStat label="Slow" value={velocity.slow} cls="bg-amber-500" />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {velocity.hasHistory
                ? "Open for pace, projected ETA, ETA gap and the stuck-project leaderboard."
                : "Upload another report to unlock pace, ETA and trend across snapshots."}
            </p>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}

function SnapStat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-border p-2">
      <span className={`w-3 h-3 rounded-sm ${cls} mb-1`} />
      <span className="text-base font-semibold tabular-nums">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

function KpiTile({ title, value }: { title: string, value: string | number }) {
  return (
    <Card className="shadow-sm border-border bg-card">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 line-clamp-1">{title}</p>
        <p className="text-sm sm:text-base font-medium tracking-tight text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6">
      <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
      <h2 className="text-2xl font-bold mb-2">No Active Import</h2>
      <p className="text-muted-foreground max-w-md mb-8">
        Upload a balance and activity report to start tracking shop-floor progress and ageing.
      </p>
      <Link href="/data">
        <Button size="lg" className="px-8 font-bold tracking-wide">
          GO TO DATA UPLOAD
        </Button>
      </Link>
    </div>
  );
}

export function getAgeingColor(days: number | null): string {
  if (days === null) return "ageing-neutral";
  if (days <= 30) return "ageing-green";
  if (days <= 60) return "ageing-amber";
  return "ageing-red";
}

export function getAgeingBgColor(days: number | null): string {
  if (days === null) return "bg-ageing-neutral";
  if (days <= 30) return "bg-ageing-green";
  if (days <= 60) return "bg-ageing-amber";
  return "bg-ageing-red";
}
