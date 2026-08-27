import { useState } from "react";
import {
  useListUploadStageEvidence,
  getListUploadStageEvidenceQueryKey,
  type UploadStageEvidence,
} from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, ClipboardList, FileWarning, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

const OUTCOME_LABEL: Record<string, string> = {
  imported: "Imported",
  skipped: "Skipped",
  expired: "Expired",
  refused: "Refused",
};

function EvidenceRow({ evidence }: { evidence: UploadStageEvidence }) {
  const [expanded, setExpanded] = useState(false);
  const assessment = evidence.assessment;
  const outcome = evidence.outcome ? OUTCOME_LABEL[evidence.outcome] : "Awaiting decision";
  const findings = [
    ...assessment.blocking.map((finding) => ({ ...finding, tone: "text-destructive" })),
    ...assessment.warnings.map((finding) => ({ ...finding, tone: "text-amber-700 dark:text-amber-300" })),
  ];

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold truncate max-w-80">{evidence.sourceFilename}</span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {evidence.kind === "order-review"
                ? "Order Review"
                : evidence.kind === "wip"
                  ? "WIP"
                  : "Unrecognized file"}
            </span>
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{outcome}</span>
            {evidence.isReconstruction && (
              <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
                Reconstruction
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Staged {formatDate(evidence.stagedAt)}
            {evidence.reportDate ? ` · report ${formatDate(evidence.reportDate)}` : ""}
            {evidence.comparedAgainstImportId ? ` · compared with import #${evidence.comparedAgainstImportId}` : ""}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
          className="gap-1"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Panel evidence
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">
          SHA-256 <code>{evidence.sourceHash.slice(0, 16)}…</code>
        </span>
        {evidence.projectCodes.map((project) => (
          <span key={project} className="rounded border px-1.5 py-0.5 font-medium">
            {project}
          </span>
        ))}
      </div>

      {evidence.reconstructionNote && (
        <p className="rounded border border-violet-300/60 bg-violet-50/50 p-2 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
          {evidence.reconstructionNote}
        </p>
      )}

      {expanded && (
        <div className="space-y-3 border-t pt-3">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-md bg-muted/40 p-2 text-xs">
              <strong>Verdict:</strong> {assessment.verdict}
              <br />
              <strong>Blockers:</strong> {assessment.blocking.length}
              <br />
              <strong>Warnings:</strong> {assessment.warnings.length}
            </div>
            <div className="rounded-md bg-muted/40 p-2 text-xs">
              <strong>Imported as:</strong> {evidence.importId ? `#${evidence.importId}` : "—"}
              <br />
              <strong>Decision:</strong> {evidence.outcomeAt ? formatDate(evidence.outcomeAt) : "Pending"}
              {evidence.importDeletedAt && (
                <>
                  <br />
                  <strong>Import history:</strong> {evidence.importDeletionScope ?? "Import later deleted"} · {formatDate(evidence.importDeletedAt)}
                </>
              )}
            </div>
          </div>
          {evidence.outcomeReason && (
            <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">
              <strong>Outcome:</strong> {evidence.outcomeReason}
            </p>
          )}
          {findings.map((finding, index) => (
            <div key={`${finding.title}-${index}`} className="rounded border p-2 text-xs">
              <div className={`font-semibold ${finding.tone}`}>{finding.title}</div>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-muted-foreground">{finding.detail}</pre>
            </div>
          ))}
          {assessment.information.map((finding, index) => (
            <div key={`${finding.title}-${index}`} className="rounded border border-dashed p-2 text-xs">
              <div className="font-semibold">{finding.title}</div>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-muted-foreground">{finding.detail}</pre>
            </div>
          ))}
          <details className="rounded border p-2 text-xs">
            <summary className="cursor-pointer font-medium">Structured panel data</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
              {JSON.stringify(evidence.details, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export function StagingEvidenceRegister() {
  const { data: evidence = [], isLoading } = useListUploadStageEvidence({
    query: { queryKey: getListUploadStageEvidenceQueryKey() },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <History className="h-4 w-4" />
          Upload staging evidence
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Exact panel findings are preserved independently of staging cleanup and import deletion.
          Project badges connect Order Review findings to the anomaly register without changing blockers or calculations.
        </p>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading staging evidence…</div>
        ) : evidence.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <FileWarning className="h-4 w-4" />
            No staging evidence has been captured yet.
          </div>
        ) : (
          <div className="space-y-3">
            {evidence.map((entry) => <EvidenceRow key={entry.id} evidence={entry} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}