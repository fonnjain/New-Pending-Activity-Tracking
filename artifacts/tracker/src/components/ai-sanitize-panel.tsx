import { useState } from "react";
import {
  useAiSanitize,
  useAiStatus,
  getAiStatusQueryKey,
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type SanitizeResult,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Wand2, Download, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportCleanedXlsx } from "@/lib/export";

export function AiSanitizePanel({ importId }: { importId: number }) {
  const sanitize = useAiSanitize();
  const { data: status } = useAiStatus({ query: { queryKey: getAiStatusQueryKey() } });
  const [result, setResult] = useState<SanitizeResult | null>(null);
  const { toast } = useToast();

  const aiAvailable = status?.available === true;

  const { data: allRecords } = useGetImportRecords(importId, {
    query: { enabled: !!importId, queryKey: getGetImportRecordsQueryKey(importId) },
  });

  const run = () => {
    sanitize.mutate(
      { data: { importId } },
      { onSuccess: (res) => setResult(res) },
    );
  };

  const acceptAll = async () => {
    if (!result || !allRecords) return;
    const overrides = new Map<string, Record<string, string | null>>();
    for (const s of result.suggestions) {
      const existing = overrides.get(s.poolHash) ?? {};
      existing[s.field] = s.to;
      overrides.set(s.poolHash, existing);
    }
    await exportCleanedXlsx(
      `cleaned_import_${importId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      allRecords,
      overrides,
    );
    toast({
      title: "Cleaned file downloaded",
      description: "Re-upload it as a new import to apply these cleanups. Nothing was changed server-side.",
    });
    setResult(null);
  };

  const unavailable = !aiAvailable || (result && !result.available);

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
          <span className="flex items-center gap-2">
            <Wand2 className="w-4 h-4" /> AI Sanitize Input
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={sanitize.isPending || !aiAvailable}
            onClick={run}
          >
            {sanitize.isPending ? "Scanning..." : "Sanitize input"}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground">
            Set ANTHROPIC_API_KEY to enable AI assists. Uploads and dashboards work without it.
          </p>
        ) : (
          !result &&
          !sanitize.isPending && (
            <p className="text-sm text-muted-foreground">
              Advisory only. Suggests cleanups to descriptive fields (dates, contractor and section
              spelling). Accepting downloads a cleaned .xlsx to re-upload; the engine recomputes
              everything. Quantities, weights, activity, and mark identity are never touched.
            </p>
          )
        )}

        {result?.available && result.suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No cleanups suggested. The input looks clean.</p>
        )}

        {result?.available && result.suggestions.length > 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{result.counts.dates} date fixes</span>
              <span>{result.counts.names} name fixes</span>
              <span>{result.counts.other} other</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-semibold">Field</th>
                    <th className="py-2 pr-3 font-semibold">Change</th>
                    <th className="py-2 pr-3 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.suggestions.map((s, i) => (
                    <tr key={i} className="border-b border-border/50 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap font-medium">{s.field}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        <span className="text-muted-foreground line-through">{s.from ?? "(empty)"}</span>
                        {" -> "}
                        <span className="text-emerald-600 dark:text-emerald-400">{s.to ?? "(empty)"}</span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <Button size="sm" className="h-8 gap-2" onClick={acceptAll} disabled={!allRecords}>
                <Download className="w-4 h-4" /> Accept all (download cleaned file)
              </Button>
              <Button variant="ghost" size="sm" className="h-8 gap-2" onClick={() => setResult(null)}>
                <X className="w-4 h-4" /> Discard
              </Button>
            </div>
          </div>
        )}

        {sanitize.isError && (
          <p className="text-sm text-destructive">Sanitize failed. Please try again.</p>
        )}
      </CardContent>
    </Card>
  );
}
