import { useEffect, useState } from "react";
import {
  getListOrderReviewAnomaliesQueryKey,
  useListOrderReviewAnomalies,
  useUpdateOrderReviewAnomaly,
  useListUploadStageEvidence,
  getListUploadStageEvidenceQueryKey,
  type OrderReviewAnomaly,
} from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, History, Save } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";

const STATUS_META = {
  open: {
    label: "Open",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  },
  explained: {
    label: "Explained",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  },
  superseded: {
    label: "Superseded",
    className: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  },
} as const;

function AnomalyRow({
  anomaly,
  evidenceCount,
}: {
  anomaly: OrderReviewAnomaly;
  evidenceCount: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateOrderReviewAnomaly();
  const [status, setStatus] = useState<OrderReviewAnomaly["status"]>(anomaly.status);
  const [explanation, setExplanation] = useState(anomaly.explanation);

  useEffect(() => {
    setStatus(anomaly.status);
    setExplanation(anomaly.explanation);
  }, [anomaly]);

  const save = () => {
    const value = explanation.trim();
    if (!value) {
      toast({
        variant: "destructive",
        title: "Add an explanation first",
        description: "Each anomaly needs a short investigation note before it can be saved.",
      });
      return;
    }
    update.mutate(
      { project: anomaly.project, data: { status, explanation: value } },
      {
        onSuccess: () => {
          toast({ title: `Project ${anomaly.project} updated` });
          queryClient.invalidateQueries({ queryKey: getListOrderReviewAnomaliesQueryKey() });
        },
        onError: (error) => {
          toast({
            variant: "destructive",
            title: "Could not update anomaly",
            description: error.message || "Please try again.",
          });
        },
      },
    );
  };

  const meta = STATUS_META[status];
  const isDirty = status !== anomaly.status || explanation.trim() !== anomaly.explanation;

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold tabular-nums">Project {anomaly.project}</span>
          <span className="inline-flex rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            Signature {anomaly.signature}
          </span>
          <span className="text-xs text-muted-foreground">{anomaly.reason}</span>
          <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${meta.className}`}>
            {meta.label}
          </span>
          {evidenceCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {evidenceCount} preserved panel{evidenceCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Updated {formatDate(anomaly.updatedAt)}
          {anomaly.updatedBy ? ` by ${anomaly.updatedBy}` : ""}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-end">
        <div className="space-y-1">
          <Label htmlFor={`anomaly-status-${anomaly.id}`}>Status</Label>
          <select
            id={`anomaly-status-${anomaly.id}`}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value as OrderReviewAnomaly["status"])}
            disabled={update.isPending}
          >
            <option value="open">Open</option>
            <option value="explained">Explained</option>
            <option value="superseded">Superseded</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`anomaly-explanation-${anomaly.id}`}>Explanation</Label>
          <textarea
            id={`anomaly-explanation-${anomaly.id}`}
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
            maxLength={2000}
            disabled={update.isPending}
          />
        </div>
        <Button
          size="sm"
          onClick={save}
          disabled={!isDirty || update.isPending || explanation.trim().length === 0}
          className="gap-2"
        >
          <Save className="w-4 h-4" />
          {update.isPending ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function OrderReviewAnomalyRegister() {
  const { data: anomalies = [], isLoading } = useListOrderReviewAnomalies({
    query: { queryKey: getListOrderReviewAnomaliesQueryKey() },
  });
  const { data: evidence = [] } = useListUploadStageEvidence({
    query: { queryKey: getListUploadStageEvidenceQueryKey() },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Order Review Anomaly Register
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Track investigation outcomes for cumulative-regression anomalies. Updating this register
          records context only; it never changes upload blockers or report calculations.
        </p>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading anomaly register…</div>
        ) : anomalies.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-md border-dashed p-4">
            No Order Review anomalies have been registered.
          </div>
        ) : (
          <div className="space-y-3">
            {anomalies.map((anomaly) => (
              <AnomalyRow
                key={anomaly.id}
                anomaly={anomaly}
                evidenceCount={evidence.filter(
                  (entry) =>
                    entry.kind === "order-review" &&
                    entry.projectCodes.includes(anomaly.project),
                ).length}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}