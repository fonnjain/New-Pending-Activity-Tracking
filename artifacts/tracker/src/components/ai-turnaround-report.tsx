import { useState } from "react";
import {
  useAiReport,
  useAiStatus,
  getAiStatusQueryKey,
  type ReportResult,
  type ReportRisk,
  type ReportAction,
  type ReportBottleneck,
} from "@workspace/api-client-react";
import { useTracker, dateRangeWindow } from "@/lib/store";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { exportAiReportPdf } from "@/lib/export";
import {
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  FileText,
  ChevronDown,
  RefreshCw,
} from "lucide-react";

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// AI turnaround analysis: red flags, bottlenecks and an action plan, with a
// PDF/JSON export. The deterministic engine remains the source of truth; this
// is advisory analysis only and never changes any value. Honours the global
// header filters when generating.
export function AiTurnaroundReport() {
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

  const handleExportPdf = () => {
    if (!result) return;
    const date = new Date().toISOString().slice(0, 10);
    exportAiReportPdf(`ai_report_import_${result.importId ?? selectedImportId}_${date}.pdf`, result);
  };

  const unavailable = !aiAvailable || (result != null && !result.available);
  const hasResult = result?.available === true;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" /> AI Turnaround Report
          </h2>
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
                    <div className="overflow-auto max-h-[70vh]">
                      <table className="w-full text-sm">
                        <thead className="bg-card sticky top-0 z-10">
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
