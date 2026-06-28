import { useState } from "react";
import {
  useStageImport,
  useValidateStagedImport,
  useCommitStagedImport,
  useDiscardStagedImport,
  type StageResult,
  type StructuralRead,
  type ValidationResult,
  type StagedSanitizeSuggestion,
  type CommitResult,
  type OrderReviewStageInfo,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Upload,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Lock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Phase = "idle" | "staged" | "validating" | "validated";

export type SlotType = "wip" | "order-review";

const SLOT_LABEL: Record<SlotType, string> = {
  wip: "WIP / Balance & Activity",
  "order-review": "Order Review",
};

// A helpful, slot-aware message when the staged file does not match the slot's
// expected type. Mirrors the server's typeMismatchMessage wording.
function mismatchMessage(detected: StageResult["fileType"]): string {
  if (detected === "wip" || detected === "order-review") {
    return `This looks like a ${SLOT_LABEL[detected]} file — please use the ${SLOT_LABEL[detected]} uploader.`;
  }
  return "This doesn't look like a valid WIP or Order Review file.";
}

interface Props {
  expectedType: SlotType;
  onCommitted: (res: CommitResult) => void;
  /** When true, the slot is gated: no file can be selected and a note explains why. */
  locked?: boolean;
  /** Explanation shown in place of the upload control when locked. */
  lockedMessage?: string;
}

export function StagedUploadPanel({
  expectedType,
  onCommitted,
  locked = false,
  lockedMessage,
}: Props) {
  const stage = useStageImport();
  const validate = useValidateStagedImport();
  const commit = useCommitStagedImport();
  const discard = useDiscardStagedImport();
  const { toast } = useToast();

  const [phase, setPhase] = useState<Phase>("idle");
  const [staged, setStaged] = useState<StageResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const busy =
    stage.isPending ||
    validate.isPending ||
    commit.isPending ||
    discard.isPending;

  const reset = () => {
    setPhase("idle");
    setStaged(null);
    setValidation(null);
    setAccepted(new Set());
  };

  const isOrderReview = expectedType === "order-review";
  // Slot gate: the file the user picked must match THIS slot's expected type.
  const typeMismatch = staged != null && staged.fileType !== expectedType;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stage.mutate(
      { data: { file } },
      {
        onSuccess: (res) => {
          setStaged(res);
          setValidation(null);
          setAccepted(new Set());
          setPhase("staged");
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not stage file",
            description:
              err?.data?.error || err?.message || "Unknown error",
          });
        },
      },
    );
    e.target.value = "";
  };

  const runValidate = () => {
    if (!staged) return;
    setPhase("validating");
    validate.mutate(
      { data: { stagingId: staged.stagingId, expectedType } },
      {
        onSuccess: (res) => {
          setValidation(res);
          // Pre-select all suggested cleanups by default.
          setAccepted(new Set(res.sanitize.map((_, i) => i)));
          setPhase("validated");
        },
        onError: (err) => {
          setPhase("staged");
          toast({
            variant: "destructive",
            title: "Check failed",
            description:
              err?.data?.error || err?.message || "Unknown error",
          });
        },
      },
    );
  };

  const doCommit = () => {
    if (!staged) return;
    const acceptedSuggestions =
      validation?.sanitize
        .filter((_, i) => accepted.has(i))
        .map((s) => ({ field: s.field, from: s.from, to: s.to })) ?? [];

    commit.mutate(
      { data: { stagingId: staged.stagingId, expectedType, acceptedSuggestions } },
      {
        onSuccess: (res) => {
          onCommitted(res);
          reset();
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Import failed",
            description:
              err?.data?.error || err?.message || "Unknown error",
          });
        },
      },
    );
  };

  const doDiscard = () => {
    if (!staged) {
      reset();
      return;
    }
    discard.mutate(
      { id: staged.stagingId },
      {
        onSuccess: () => reset(),
        onError: () => reset(),
      },
    );
  };

  const toggle = (i: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const heading = isOrderReview
    ? "Order Review File"
    : "WIP / Balance & Activity Report";
  const helper = isOrderReview
    ? "The Order Review export (per project & structure: sets, weight, release, dispatch). Updates the Order Status page; re-uploading is safe (idempotent upsert, one row per project + structure)."
    : "The daily WIP balance/activity export (marks, activities, weights). Staged and checked first; nothing imports until you accept. Re-uploading the same file is safe and registers zero changes.";
  const Icon = isOrderReview ? ClipboardList : Upload;
  // Visually distinguish the two slots so a file can never go to the wrong one.
  const accent = isOrderReview
    ? {
        card: "border-sky-500/40 bg-sky-500/5",
        chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
      }
    : {
        card: "border-primary/40 bg-primary/5",
        chip: "bg-primary/10 text-primary",
      };

  return (
    <div className="space-y-4">
      <Card className={`border-dashed border-2 ${accent.card}`}>
        <CardContent className="flex flex-col items-center justify-center p-10 text-center">
          <div
            className={`w-14 h-14 rounded-full flex items-center justify-center mb-4 ${accent.chip}`}
          >
            <Icon className="w-7 h-7" />
          </div>
          <h3 className="text-lg font-bold mb-2">{heading}</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">{helper}</p>
          {locked ? (
            <div className="flex flex-col items-center gap-3 max-w-md">
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <Lock className="w-4 h-4 shrink-0" />
                <span>
                  {lockedMessage ??
                    "Upload a WIP report and accept its checks first."}
                </span>
              </div>
              <Button disabled className="px-8 font-bold">
                SELECT FILE
              </Button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="file"
                accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={busy}
              />
              <Button
                disabled={busy}
                className="px-8 font-bold text-primary-foreground"
              >
                {stage.isPending ? "STAGING..." : "SELECT FILE"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {staged && (
        <Card className="border-border">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold truncate">
                  {staged.sourceFilename}
                </div>
                <div className="text-xs text-muted-foreground">
                  Staged. Not yet imported.
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={doDiscard}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive"
              >
                Reset
              </Button>
            </div>

            {typeMismatch ? (
              <TypeMismatchView
                message={mismatchMessage(staged.fileType)}
                onDiscard={doDiscard}
                busy={busy}
              />
            ) : (
              <>
                {staged.structural && (
                  <StructuralSummary structural={staged.structural} />
                )}

                {isOrderReview && staged.orderReview && (
                  <OrderReviewSummary info={staged.orderReview} />
                )}

                {phase === "staged" && isOrderReview && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      onClick={doCommit}
                      disabled={busy}
                      className="gap-2 text-primary-foreground"
                    >
                      <ClipboardList className="w-4 h-4" />
                      {commit.isPending ? "Importing..." : "Import Order Review"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={doDiscard}
                      disabled={busy}
                    >
                      Discard
                    </Button>
                  </div>
                )}

                {phase === "staged" && !isOrderReview && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      onClick={runValidate}
                      disabled={busy}
                      className="gap-2 text-primary-foreground"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      Check &amp; sanitize with Claude
                    </Button>
                    <Button
                      variant="outline"
                      onClick={doCommit}
                      disabled={busy}
                      className="gap-2"
                    >
                      Skip check &amp; import as-is
                    </Button>
                  </div>
                )}

                {phase === "validating" && (
                  <div className="text-sm text-muted-foreground">
                    Checking the file with Claude...
                  </div>
                )}

                {phase === "validated" && validation && (
                  <ValidationView
                    validation={validation}
                    accepted={accepted}
                    onToggle={toggle}
                    onCommit={doCommit}
                    onDiscard={doDiscard}
                    busy={busy}
                    committing={commit.isPending}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TypeMismatchView({
  message,
  onDiscard,
  busy,
}: {
  message: string;
  onDiscard: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm space-y-2">
        <div className="flex items-center gap-2 font-bold text-destructive">
          <AlertTriangle className="w-4 h-4" />
          Wrong file for this uploader
        </div>
        <p className="text-foreground/90">{message}</p>
      </div>
      <Button variant="outline" onClick={onDiscard} disabled={busy}>
        Reset
      </Button>
    </div>
  );
}

function StructuralSummary({ structural }: { structural: StructuralRead }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2 text-sm">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Sheet" value={structural.sheetName ?? "—"} />
        <Stat
          label="Header row"
          value={
            structural.headerRow === null
              ? "—"
              : String(structural.headerRow + 1)
          }
        />
        <Stat label="Rows read" value={structural.rowsRead.toLocaleString()} />
        <Stat
          label="Rows with Mark"
          value={structural.rowsWithMark.toLocaleString()}
        />
      </div>
      {structural.missingColumns.length > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          Missing columns: {structural.missingColumns.join(", ")}
        </div>
      )}
      {structural.problems.length > 0 && (
        <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
          {structural.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderReviewSummary({ info }: { info: OrderReviewStageInfo }) {
  const s = info.summary;
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2 text-sm">
      <div className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
        <ClipboardList className="w-3.5 h-3.5" />
        Order Review file
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="As-on date" value={info.asOnDate ?? "—"} />
        <Stat
          label="Rows read"
          value={s ? s.rowsRead.toLocaleString() : "—"}
        />
        <Stat label="Rows kept" value={s ? s.rowsKept.toLocaleString() : "—"} />
        <Stat
          label="Projects"
          value={s ? s.projectsFound.toLocaleString() : "—"}
        />
        <Stat
          label="Order wt (MT)"
          value={s ? s.totalWeightMt.toLocaleString() : "—"}
        />
        <Stat
          label="Released (MT)"
          value={s ? s.totalReleaseMt.toLocaleString() : "—"}
        />
        <Stat
          label="File despatch (MT)"
          value={s ? s.totalFileDespatchMt.toLocaleString() : "—"}
        />
        <Stat
          label="Matched to WIP"
          value={s ? s.matchedToWip.toLocaleString() : "—"}
        />
        <Stat
          label="Unmatched to WIP"
          value={s ? s.unmatchedToWip.toLocaleString() : "—"}
        />
        <Stat
          label="Skipped totals"
          value={s ? s.skippedTotals.toLocaleString() : "—"}
        />
      </div>
      {s && s.missingStructure > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          {s.missingStructure.toLocaleString()} row
          {s.missingStructure === 1 ? "" : "s"} had no structure and will not
          join to WIP marks.
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Order Review files are ingested deterministically. No AI check is
        applied. Dispatch totals are seeded once, then accrued from WIP yard
        departures.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-muted-foreground text-xs uppercase mb-0.5">
        {label}
      </span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );
}

function ValidationView({
  validation,
  accepted,
  onToggle,
  onCommit,
  onDiscard,
  busy,
  committing,
}: {
  validation: ValidationResult;
  accepted: Set<number>;
  onToggle: (i: number) => void;
  onCommit: () => void;
  onDiscard: () => void;
  busy: boolean;
  committing: boolean;
}) {
  // No key configured: offer import as-is.
  if (!validation.available) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-muted bg-muted/20 p-3 text-sm text-muted-foreground">
          AI check is unavailable. Set ANTHROPIC_API_KEY to enable the Claude
          gatekeeper. You can still import the file as-is — the deterministic
          engine remains the source of truth.
        </div>
        <div className="flex gap-2">
          <Button
            onClick={onCommit}
            disabled={busy}
            className="text-primary-foreground"
          >
            {committing ? "Importing..." : "Import as-is"}
          </Button>
          <Button variant="outline" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  // Rejected: the file is not a valid report.
  if (validation.verdict === "reject") {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-bold text-destructive">
            <AlertTriangle className="w-4 h-4" />
            This does not look like a valid balance/activity report
          </div>
          {validation.reason && (
            <p className="text-foreground/90">{validation.reason}</p>
          )}
          {validation.expectedShape && (
            <p className="text-muted-foreground">
              Expected: {validation.expectedShape}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          <Button
            variant="outline"
            onClick={onCommit}
            disabled={busy}
            className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          >
            {committing ? "Importing..." : "Import anyway"}
          </Button>
        </div>
      </div>
    );
  }

  // Accepted: optionally apply descriptive cleanups, then commit.
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="w-4 h-4" />
        Looks like a valid report
      </div>

      {validation.sanitize.length > 0 ? (
        <div className="space-y-2">
          <div className="text-sm font-bold">
            Suggested cleanups ({validation.sanitize.length})
          </div>
          <p className="text-xs text-muted-foreground">
            These only touch descriptive fields and are applied before import.
            They never change mark identity, quantities, weights, activity, or
            operation. Untick any you do not want.
          </p>
          <div className="grid gap-2">
            {validation.sanitize.map((s, i) => (
              <SuggestionRow
                key={i}
                s={s}
                checked={accepted.has(i)}
                onToggle={() => onToggle(i)}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No descriptive cleanups suggested.
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          onClick={onCommit}
          disabled={busy}
          className="text-primary-foreground"
        >
          {committing
            ? "Importing..."
            : accepted.size > 0
              ? `Accept ${accepted.size} & import`
              : "Import"}
        </Button>
        <Button variant="outline" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
    </div>
  );
}

function SuggestionRow({
  s,
  checked,
  onToggle,
}: {
  s: StagedSanitizeSuggestion;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border p-3 text-sm cursor-pointer hover:bg-muted/30">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1"
      />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs uppercase rounded bg-muted px-1.5 py-0.5">
            {s.field}
          </span>
          <span className="text-muted-foreground line-through">
            {s.from ?? "(empty)"}
          </span>
          <span className="text-muted-foreground">to</span>
          <span className="font-bold">{s.to ?? "(empty)"}</span>
          <span className="text-xs text-muted-foreground">
            · {s.count.toLocaleString()} row{s.count === 1 ? "" : "s"}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">{s.reason}</div>
      </div>
    </label>
  );
}
