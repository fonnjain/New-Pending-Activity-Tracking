import { useState } from "react";
import {
  useAiReview,
  useAiStatus,
  getAiStatusQueryKey,
  type ReviewResult,
  type ReviewFinding,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, ShieldCheck, AlertTriangle, XCircle } from "lucide-react";

function VerdictBadge({ verdict }: { verdict: ReviewResult["verdict"] }) {
  if (verdict === "pass") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-3 py-1 text-xs font-bold uppercase tracking-wider">
        <ShieldCheck className="w-3.5 h-3.5" /> Pass
      </span>
    );
  }
  if (verdict === "warn") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-3 py-1 text-xs font-bold uppercase tracking-wider">
        <AlertTriangle className="w-3.5 h-3.5" /> Warn
      </span>
    );
  }
  if (verdict === "fail") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 text-destructive px-3 py-1 text-xs font-bold uppercase tracking-wider">
        <XCircle className="w-3.5 h-3.5" /> Fail
      </span>
    );
  }
  return null;
}

function severityClass(s: ReviewFinding["severity"]): string {
  if (s === "error") return "text-destructive";
  if (s === "warn") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export function AiReviewPanel({ importId }: { importId: number }) {
  const review = useAiReview();
  const { data: status } = useAiStatus({ query: { queryKey: getAiStatusQueryKey() } });
  const [result, setResult] = useState<ReviewResult | null>(null);

  const aiAvailable = status?.available === true;

  const run = (deep: boolean) => {
    review.mutate(
      { data: { importId, deep } },
      { onSuccess: (res) => setResult(res) },
    );
  };

  const unavailable = !aiAvailable || (result && !result.available);

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
          <span className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> AI Review Of Results
          </span>
          <div className="flex items-center gap-2">
            {result?.available && result.verdict && <VerdictBadge verdict={result.verdict} />}
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={review.isPending || !aiAvailable}
              onClick={() => run(false)}
            >
              {review.isPending ? "Reviewing..." : "Run review"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={review.isPending || !aiAvailable}
              onClick={() => run(true)}
            >
              Run deep review
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground">
            Set ANTHROPIC_API_KEY to enable AI assists. All dashboards and imports work without it.
          </p>
        ) : (
          !result &&
          !review.isPending && (
            <p className="text-sm text-muted-foreground">
              Advisory only. The deterministic engine remains the source of truth; this audits the
              computed results for anomalies and never changes any value.
            </p>
          )
        )}

        {result?.available && (
          <div className="space-y-4">
            {result.summary && <p className="text-sm text-foreground/90">{result.summary}</p>}

            {result.stats && Object.keys(result.stats).length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                {Object.entries(result.stats).map(([k, v]) => (
                  <div key={k}>
                    <span className="block text-muted-foreground text-xs uppercase mb-0.5">{k}</span>
                    <span className="font-bold tabular-nums">
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {result.findings.length > 0 ? (
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-card sticky top-0 z-10">
                    <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3 font-semibold">Severity</th>
                      <th className="py-2 pr-3 font-semibold">Check</th>
                      <th className="py-2 pr-3 font-semibold">Mark</th>
                      <th className="py-2 pr-3 font-semibold">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.findings.map((f, i) => (
                      <tr key={i} className="border-b border-border/50 align-top">
                        <td className={`py-2 pr-3 font-bold uppercase text-xs ${severityClass(f.severity)}`}>
                          {f.severity}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">{f.check}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{f.markId || "-"}</td>
                        <td className="py-2 pr-3">
                          {f.message}
                          {(f.expected || f.actual) && (
                            <span className="block text-xs text-muted-foreground mt-0.5">
                              {f.expected != null && <>expected: {f.expected} </>}
                              {f.actual != null && <>actual: {f.actual}</>}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No anomalies found.</p>
            )}

            {result.deep && result.plan && result.plan.length > 0 && (
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  Remediation plan
                </h4>
                <ol className="list-decimal list-inside space-y-1 text-sm text-foreground/90">
                  {result.plan.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {review.isError && (
          <p className="text-sm text-destructive">Review failed. Please try again.</p>
        )}
      </CardContent>
    </Card>
  );
}
