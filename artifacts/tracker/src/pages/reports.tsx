import { useMemo, useState } from "react";
import { compareActivity } from "@workspace/domain";
import {
  useAiReport,
  useAiStatus,
  getAiStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type ReportResult,
  type ReportRisk,
  type ReportAction,
  type ReportBottleneck,
} from "@workspace/api-client-react";
import { useTracker, dateRangeWindow, useFilteredRecords } from "@/lib/store";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { exportToJson, exportToXlsx, exportAiReportPdf, type XlsxColumn } from "@/lib/export";
import { formatWeight } from "@/lib/utils";
import {
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  Download,
  FileSpreadsheet,
  FileText,
  Printer,
  ChevronDown,
  RefreshCw,
  ListFilter,
  Check,
} from "lucide-react";

type ReportType = "jobwise" | "ai";

type SortKey = "activity" | "ageing" | "contractor";

const SORT_OPTIONS: { id: SortKey; name: string }[] = [
  { id: "activity", name: "Activity" },
  { id: "ageing", name: "Ageing" },
  { id: "contractor", name: "Contractor" },
];

const REPORT_TYPES: { id: ReportType; name: string; description: string }[] = [
  {
    id: "jobwise",
    name: "Job Wise Report",
    description: "Filter pending work with the header filters, then export to Excel.",
  },
  {
    id: "ai",
    name: "AI Report",
    description: "AI turnaround analysis with red flags, bottlenecks and a PDF/JSON export.",
  },
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Controls the exported .xlsx. Numeric columns are right-aligned and number
// formatted; Balance Qty/Wt carry a totals-row SUM. Wt stays in raw kg numbers.
const REPORT_COLUMNS: XlsxColumn[] = [
  { label: "Mark No.", field: "markId" },
  { label: "Activity", field: "activity" },
  { label: "Section", field: "section" },
  { label: "Length", field: "length", numeric: true, decimals: 2 },
  { label: "Width", field: "width", numeric: true, decimals: 2 },
  { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
  { label: "Balance Wt (kg)", field: "balanceWt", numeric: true, decimals: 2, total: true },
  { label: "Contractor", field: "contractor" },
];

const TABLE_CAP = 500;

function num(v: number | null | undefined): string {
  if (v == null) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ReportBuilder() {
  const { selectedImportId, filters } = useTracker();
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

  const totalQty = rows.reduce((s, r) => s + (r.balanceQty ?? 0), 0);
  const totalWt = rows.reduce((s, r) => s + (r.balanceWt ?? 0), 0);

  const handleExcel = () => {
    if (!rows.length) return;
    const tag = `${filters.job ?? "all"}_${filters.activity ?? "all"}_by-${sortBy}`.replace(
      /[^\w-]+/g,
      "-",
    );
    exportToXlsx(`report_${tag}.xlsx`, REPORT_COLUMNS, rows);
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

  const visible = rows.slice(0, TABLE_CAP);

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
            <TableHeader>
              <TableRow>
                <TableHead>Mark No.</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Length</TableHead>
                <TableHead className="text-right">Width</TableHead>
                <TableHead className="text-right">Balance Qty</TableHead>
                <TableHead className="text-right">Balance Wt</TableHead>
                <TableHead>Contractor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r, i) => (
                <TableRow key={`${r.markId}-${i}`}>
                  <TableCell className="font-mono text-xs">{r.markId}</TableCell>
                  <TableCell>{r.activity ?? "-"}</TableCell>
                  <TableCell>{r.section ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.length)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.width)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.balanceQty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatWeight(r.balanceWt)}</TableCell>
                  <TableCell>{r.contractor ?? "Unassigned"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
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

function HealthBadge({ health }: { health: "good" | "watch" | "critical" }) {
  if (health === "good") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-3 py-1 text-xs font-bold uppercase tracking-wider">
        <ShieldCheck className="w-3.5 h-3.5" /> Good
      </span>
    );
  }
  if (health === "watch") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-3 py-1 text-xs font-bold uppercase tracking-wider">
        <AlertTriangle className="w-3.5 h-3.5" /> Watch
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 text-destructive px-3 py-1 text-xs font-bold uppercase tracking-wider">
      <XCircle className="w-3.5 h-3.5" /> Critical
    </span>
  );
}

function severityChip(severity: ReportRisk["severity"]) {
  const cls =
    severity === "high"
      ? "bg-destructive/15 text-destructive"
      : severity === "med"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {severity}
    </span>
  );
}

function effortChip(value: ReportAction["effort"] | ReportAction["horizon"]) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {value}
    </span>
  );
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border border-border rounded-lg">
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between px-4 py-3 text-left">
          <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AiReports() {
  const { selectedImportId, filters } = useTracker();
  const report = useAiReport();
  const { data: status } = useAiStatus({ query: { queryKey: getAiStatusQueryKey() } });
  const [result, setResult] = useState<ReportResult | null>(null);

  const aiAvailable = status?.available === true;

  const buildFilters = () => {
    const win = dateRangeWindow(filters.dateRange);
    return {
      job: filters.job,
      structure: filters.structure,
      mark: filters.mark,
      contractor: filters.contractor,
      activity: filters.activity,
      search: filters.search || null,
      dateStart: win ? ymd(win.start) : null,
      dateEnd: win ? ymd(win.end) : null,
    };
  };

  const run = (regenerate: boolean) => {
    if (selectedImportId == null) return;
    report.mutate(
      { data: { importId: selectedImportId, regenerate, filters: buildFilters() } },
      { onSuccess: (res) => setResult(res) },
    );
  };

  const handleExport = () => {
    if (!result) return;
    exportToJson(`ai_report_import_${result.importId ?? selectedImportId}.json`, result);
  };

  const handleExportPdf = () => {
    if (!result) return;
    exportAiReportPdf(`ai_report_import_${result.importId ?? selectedImportId}.pdf`, result);
  };

  const unavailable = !aiAvailable || (result != null && !result.available);
  const hasResult = result?.available === true;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" /> AI Reports
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            A deep turnaround-time analysis of the selected import: red flags, bottlenecks, and an
            action plan. The deterministic engine remains the source of truth; this is advisory
            analysis only and never changes any value.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasResult && (
            <>
              <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleExportPdf}>
                <FileText className="w-4 h-4" /> Export PDF
              </Button>
              <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleExport}>
                <Download className="w-4 h-4" /> Export JSON
              </Button>
              <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => window.print()}>
                <Printer className="w-4 h-4" /> Print
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                disabled={report.isPending || !aiAvailable || selectedImportId == null}
                onClick={() => run(true)}
              >
                <RefreshCw className="w-4 h-4" /> Regenerate
              </Button>
            </>
          )}
          {!hasResult && (
            <Button
              size="sm"
              className="h-9 gap-1.5"
              disabled={report.isPending || !aiAvailable || selectedImportId == null}
              onClick={() => run(false)}
            >
              <Sparkles className="w-4 h-4" />
              {report.isPending ? "Generating..." : "Generate report"}
            </Button>
          )}
        </div>
      </div>

      {selectedImportId == null && (
        <Card className="border-border">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Upload or select an import on the Data page to generate a report.
          </CardContent>
        </Card>
      )}

      {unavailable && selectedImportId != null && (
        <Card className="border-border">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Set ANTHROPIC_API_KEY to enable AI reports. All dashboards and imports work without it.
          </CardContent>
        </Card>
      )}

      {report.isPending && (
        <Card className="border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Analyzing the selected import. This is a deep pass and can take a little longer...
          </CardContent>
        </Card>
      )}

      {report.isError && (
        <Card className="border-border">
          <CardContent className="py-6 text-center text-sm text-destructive">
            Report generation failed. Please try again.
          </CardContent>
        </Card>
      )}

      {hasResult && result && !report.isPending && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {result.model && <span>Model: {result.model}</span>}
            {result.generatedAt && (
              <span>Generated: {new Date(result.generatedAt).toLocaleString()}</span>
            )}
            {result.filtered && (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                Filtered slice (current filters applied)
              </span>
            )}
            {result.cached && <span>Served from cache</span>}
          </div>

          {/* 1. SUMMARY */}
          {result.summary && (
            <Card className="border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center justify-between gap-3">
                  Summary
                  <HealthBadge health={result.summary.health} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-foreground/90">{result.summary.headline}</p>
                {result.summary.topRisks.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {result.summary.topRisks.map((risk: ReportRisk, i: number) => (
                      <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-sm">{risk.title}</span>
                          {severityChip(risk.severity)}
                        </div>
                        {risk.metric && (
                          <p className="text-xs font-mono text-foreground/80">{risk.metric}</p>
                        )}
                        <p className="text-xs text-muted-foreground">{risk.why}</p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 2. ACTION PLAN */}
          {result.actionPlan.length > 0 && (
            <Card className="border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
                  Action Plan
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {result.actionPlan.map((a: ReportAction, i: number) => (
                    <div key={i} className="flex gap-3 rounded-lg border border-border p-3">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                        {a.priority}
                      </div>
                      <div className="flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-sm">{a.action}</span>
                          <div className="flex items-center gap-1.5">
                            {effortChip(a.horizon)}
                            <span className="text-[10px] text-muted-foreground">effort</span>
                            {effortChip(a.effort)}
                          </div>
                        </div>
                        {a.target && (
                          <p className="text-xs text-muted-foreground">
                            Target: <span className="text-foreground/80">{a.target}</span>
                          </p>
                        )}
                        {a.rationale && <p className="text-xs text-foreground/80">{a.rationale}</p>}
                        {a.expectedImpact && (
                          <p className="text-xs text-emerald-600 dark:text-emerald-400">
                            Expected impact: {a.expectedImpact}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 3. DETAILED ANALYSIS */}
          {result.detailed && (
            <Card className="border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
                  Detailed Analysis
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.detailed.bottlenecks.length > 0 && (
                  <Section title="Bottlenecks" defaultOpen>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border">
                            <th className="py-2 pr-3 font-semibold">Area</th>
                            <th className="py-2 pr-3 font-semibold">Name</th>
                            <th className="py-2 pr-3 font-semibold">Metric</th>
                            <th className="py-2 pr-3 font-semibold">Finding</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.detailed.bottlenecks.map((b: ReportBottleneck, i: number) => (
                            <tr key={i} className="border-b border-border/50 align-top">
                              <td className="py-2 pr-3 capitalize whitespace-nowrap">{b.area}</td>
                              <td className="py-2 pr-3 font-medium whitespace-nowrap">{b.name}</td>
                              <td className="py-2 pr-3 font-mono text-xs">{b.metric}</td>
                              <td className="py-2 pr-3">{b.finding}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                )}

                {result.detailed.ageingAnalysis && (
                  <Section title="Ageing">
                    <p className="text-sm text-foreground/90 whitespace-pre-line">
                      {result.detailed.ageingAnalysis}
                    </p>
                  </Section>
                )}

                {result.detailed.contractorAnalysis && (
                  <Section title="Contractor">
                    <p className="text-sm text-foreground/90 whitespace-pre-line">
                      {result.detailed.contractorAnalysis}
                    </p>
                  </Section>
                )}

                {result.detailed.throughput && (
                  <Section title="Throughput">
                    <p className="text-sm text-foreground/90 whitespace-pre-line">
                      {result.detailed.throughput}
                    </p>
                  </Section>
                )}

                {result.detailed.dataQuality.length > 0 && (
                  <Section title="Data quality">
                    <ul className="list-disc list-inside space-y-1 text-sm text-foreground/90">
                      {result.detailed.dataQuality.map((d: string, i: number) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </Section>
                )}

                {result.detailed.assumptions.length > 0 && (
                  <Section title="Assumptions">
                    <ul className="list-disc list-inside space-y-1 text-sm text-foreground/90">
                      {result.detailed.assumptions.map((d: string, i: number) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </Section>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export default function ReportsView() {
  const [reportType, setReportType] = useState<ReportType>("jobwise");

  return (
    <div className="space-y-8">
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <ListFilter className="w-4 h-4" /> Report Builder
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1 max-w-xs">
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Report type
            </label>
            <Select value={reportType} onValueChange={(v) => setReportType(v as ReportType)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {REPORT_TYPES.map((t) => {
              const active = t.id === reportType;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setReportType(t.id)}
                  className={`text-left rounded-lg border p-4 transition-colors ${
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm">{t.name}</span>
                    {active && <Check className="w-4 h-4 text-primary" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {reportType === "jobwise" ? <ReportBuilder /> : <AiReports />}
    </div>
  );
}
