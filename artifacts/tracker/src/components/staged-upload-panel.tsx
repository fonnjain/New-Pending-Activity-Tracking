import { useState } from "react";
import {
  useStageImport,
  useValidateStagedImport,
  useCommitStagedImport,
  useDiscardStagedImport,
  type StageResult,
  type StructuralRead,
  type WipFormatCheck,
  type ValidationResult,
  type StagedSanitizeSuggestion,
  type CommitResult,
  type OrderReviewStageInfo,
  type OrSanityResult,
  type OrDataFlag,
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
  Info,
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
  /**
   * Order Review slot only: the set of committed WIP "As on" dates. A staged Order
   * Review whose date is not in this set is blocked (strict per-date pairing). When
   * undefined, this client-side gate is skipped (the server still enforces it).
   */
  allowedDates?: Set<string>;
}

export function StagedUploadPanel({
  expectedType,
  onCommitted,
  locked = false,
  lockedMessage,
  allowedDates,
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
  const [formatAcknowledged, setFormatAcknowledged] = useState(false);

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
    setFormatAcknowledged(false);
  };

  // Format check gate: null wipFormatCheck (non-WIP or unreadable) = pass through.
  const wipCheck = staged?.structural?.wipFormatCheck ?? null;
  const formatOk = wipCheck === null || wipCheck.ok;

  const isOrderReview = expectedType === "order-review";
  // Slot gate: the file the user picked must match THIS slot's expected type.
  const typeMismatch = staged != null && staged.fileType !== expectedType;
  // Per-date pairing gate (Order Review only): the staged file's "As on" date must
  // already have a committed WIP import. allowedDates is that set of WIP dates; when
  // undefined the client gate is skipped (the server still enforces pairing).
  const stagedOrderDate =
    isOrderReview && staged != null ? staged.orderReview?.asOnDate ?? null : null;
  const dateUnmatched =
    isOrderReview &&
    staged != null &&
    !typeMismatch &&
    allowedDates != null &&
    (stagedOrderDate == null || !allowedDates.has(stagedOrderDate));
  const dateMismatchMessage =
    stagedOrderDate == null
      ? "Could not read this Order Review's 'As on' date, so it can't be matched to a WIP report."
      : `No committed WIP / Balance & Activity report for ${stagedOrderDate}. Upload and accept that WIP report first.`;

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
          setFormatAcknowledged(false);
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
            ) : dateUnmatched ? (
              <TypeMismatchView
                message={dateMismatchMessage}
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

                {phase === "staged" && !formatOk && !formatAcknowledged && (
                  <WipFormatWarning
                    check={wipCheck!}
                    onProceed={() => setFormatAcknowledged(true)}
                    onDiscard={doDiscard}
                    busy={busy}
                  />
                )}

                {phase === "staged" && (formatOk || formatAcknowledged) && isOrderReview && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      onClick={runValidate}
                      disabled={busy}
                      className="gap-2 text-primary-foreground"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      {validate.isPending ? "Checking..." : "Check with AI"}
                    </Button>
                    <Button
                      onClick={doCommit}
                      disabled={busy}
                      variant="outline"
                      className="gap-2"
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

                {phase === "staged" && (formatOk || formatAcknowledged) && !isOrderReview && (
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
                    {isOrderReview
                      ? "Running AI advisory review..."
                      : "Checking the file with Claude..."}
                  </div>
                )}

                {phase === "validated" && validation && !isOrderReview && (
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

                {phase === "validated" && validation && isOrderReview && (
                  <OrAiAdvisoryView
                    validation={validation}
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
  const fc = structural.wipFormatCheck;
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
      {fc !== null && fc !== undefined && fc.ok && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Format OK — {fc.foundCount} columns, matches expected layout.
        </div>
      )}
      {fc !== null && fc !== undefined && !fc.ok && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            Column layout differs
          </span>{" "}
          — {fc.foundCount} columns found, {fc.expectedCount} expected.
          {fc.isOldFormat && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">
              Looks like the older 21-column format.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function WipFormatWarning({
  check,
  onProceed,
  onDiscard,
  busy,
}: {
  check: WipFormatCheck;
  onProceed: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const hasCritical = check.criticalMissing.length > 0;
  return (
    <div className="space-y-3">
      <div
        className={`rounded-md border p-3 text-sm space-y-2.5 ${
          hasCritical
            ? "border-destructive/40 bg-destructive/5"
            : "border-amber-300/60 bg-amber-50/50 dark:border-amber-600/30 dark:bg-amber-950/20"
        }`}
      >
        <div
          className={`flex items-center gap-2 font-bold ${
            hasCritical
              ? "text-destructive"
              : "text-amber-700 dark:text-amber-400"
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Column layout mismatch detected
        </div>

        <div className="text-xs space-y-1 text-foreground/80">
          <div>
            Found <strong>{check.foundCount}</strong> column
            {check.foundCount === 1 ? "" : "s"}, expected{" "}
            <strong>{check.expectedCount}</strong>.
            {check.isOldFormat && (
              <span className="ml-1 text-amber-700 dark:text-amber-400">
                This appears to be the older 21-column format.
              </span>
            )}
          </div>

          {check.missingExpected.length > 0 && (
            <div>
              <span className="font-medium">
                Missing ({check.missingExpected.length}):
              </span>{" "}
              {check.missingExpected.map((col, i) => (
                <span key={col}>
                  {i > 0 && ", "}
                  <span
                    className={
                      check.criticalMissing.includes(col)
                        ? "text-destructive font-semibold"
                        : undefined
                    }
                  >
                    {col}
                  </span>
                </span>
              ))}
            </div>
          )}

          {check.unexpectedFound.length > 0 && (
            <div>
              <span className="font-medium">
                New / unexpected ({check.unexpectedFound.length}):
              </span>{" "}
              {check.unexpectedFound.join(", ")}
            </div>
          )}

          {check.renames.length > 0 && (
            <div>
              <span className="font-medium">
                Possible renames ({check.renames.length}):
              </span>
              <ul className="mt-0.5 ml-3 list-disc list-inside space-y-0.5">
                {check.renames.map((r) => (
                  <li key={r.position}>
                    Column {r.position}: expected &quot;{r.expected}&quot;,
                    found &quot;{r.found}&quot;
                  </li>
                ))}
              </ul>
            </div>
          )}

          {check.reorders.length > 0 && (
            <div>
              <span className="font-medium">
                Reordered ({check.reorders.length}):
              </span>{" "}
              {check.reorders
                .slice(0, 6)
                .map(
                  (r) =>
                    `"${r.name}" (pos ${r.foundPosition}, expected ${r.expectedPosition})`,
                )
                .join("; ")}
              {check.reorders.length > 6 && (
                <span className="text-muted-foreground">
                  {" "}
                  + {check.reorders.length - 6} more
                </span>
              )}
            </div>
          )}

          {check.impactNote && (
            <div className="flex items-start gap-1.5 mt-1 pt-1.5 border-t border-current/10">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{check.impactNote}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          variant="outline"
          onClick={onProceed}
          disabled={busy}
          className="gap-2"
        >
          Proceed anyway
        </Button>
        <Button
          variant="ghost"
          onClick={onDiscard}
          disabled={busy}
          className="text-muted-foreground hover:text-destructive"
        >
          Cancel upload
        </Button>
      </div>
    </div>
  );
}

function OrderReviewSummary({ info }: { info: OrderReviewStageInfo }) {
  const s = info.summary;
  return (
    <div className="space-y-3">
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
        <p className="text-xs text-muted-foreground">
          Dispatch totals are seeded once, then accrued from WIP yard
          departures.
        </p>
      </div>
      {info.sanityCheck && <OrSanityCheckPanel result={info.sanityCheck} />}
    </div>
  );
}

function OrSanityCheckPanel({ result }: { result: OrSanityResult }) {
  const { formatCheck: fc, dataFlags, passedAll } = result;
  const warnFlags = dataFlags.filter((f) => f.severity === "warn");
  const infoFlags = dataFlags.filter((f) => f.severity === "info");

  if (passedAll) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400 font-medium py-1">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        Sanity check passed — format and data look correct.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50/50 dark:border-amber-600/30 dark:bg-amber-950/20 p-3 text-sm space-y-3">
      <div className="flex items-center gap-2 font-bold text-amber-800 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        Sanity check findings
      </div>

      {/* Format drift */}
      {!fc.ok && (
        <div className="space-y-1.5">
          <div className="text-xs font-bold uppercase text-muted-foreground">
            Format
          </div>
          {!fc.headerFound && (
            <OrFlag
              severity="warn"
              message="Two-row header block could not be located."
              impact="All column positions fall back to fixed offsets — verify parsed values."
            />
          )}
          {fc.criticalMissing.length > 0 && (
            <OrFlag
              severity="warn"
              message={`Critical columns missing: ${fc.criticalMissing.join(", ")}.`}
              impact={fc.impactNote ?? "Key features may show incorrect values."}
            />
          )}
          {fc.missingExpected
            .filter((m) => !fc.criticalMissing.includes(m))
            .map((m) => (
              <OrFlag
                key={m}
                severity="warn"
                message={`Column not found: "${m}".`}
                impact="Parser falls back to fixed position."
              />
            ))}
          {fc.renames.map((r) => (
            <OrFlag
              key={r.expected}
              severity="warn"
              message={`"${r.expected}" appears to have been renamed to "${r.foundAs}".`}
              impact='Parser falls back to position-based matching — verify parsed values are correct.'
            />
          ))}
        </div>
      )}
      {fc.ok && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Format OK — {fc.foundCount} columns, matches expected layout.
        </div>
      )}

      {/* Data flags */}
      {(warnFlags.length > 0 || infoFlags.length > 0) && (
        <div className="space-y-1.5">
          <div className="text-xs font-bold uppercase text-muted-foreground">
            Data
          </div>
          {warnFlags.map((f) => (
            <OrFlag key={f.check} severity="warn" message={f.message} impact={f.impact} />
          ))}
          {infoFlags.map((f) => (
            <OrFlag key={f.check} severity="info" message={f.message} impact={f.impact} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrFlag({
  severity,
  message,
  impact,
}: Pick<OrDataFlag, "severity" | "message" | "impact">) {
  return (
    <div
      className={`rounded border p-2 text-xs space-y-0.5 ${
        severity === "warn"
          ? "border-amber-400/50 bg-amber-50 dark:border-amber-600/30 dark:bg-amber-950/30"
          : "border-sky-300/40 bg-sky-50/50 dark:border-sky-700/30 dark:bg-sky-950/20"
      }`}
    >
      <div className={`font-medium ${severity === "warn" ? "text-amber-800 dark:text-amber-300" : "text-sky-700 dark:text-sky-300"}`}>
        {message}
      </div>
      <div className="text-muted-foreground">Impact: {impact}</div>
    </div>
  );
}

function OrAiAdvisoryView({
  validation,
  onCommit,
  onDiscard,
  busy,
  committing,
}: {
  validation: ValidationResult;
  onCommit: () => void;
  onDiscard: () => void;
  busy: boolean;
  committing: boolean;
}) {
  return (
    <div className="space-y-3">
      {validation.aiAdvisory ? (
        <div className="rounded-md border border-sky-300/50 bg-sky-50/50 dark:border-sky-700/30 dark:bg-sky-950/20 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-bold text-sky-800 dark:text-sky-300">
            <Info className="w-4 h-4 shrink-0" />
            AI advisory (read-only — import decision is yours)
          </div>
          <p className="text-foreground/90 leading-relaxed">{validation.aiAdvisory}</p>
        </div>
      ) : (
        <div className="rounded-md border border-muted bg-muted/20 p-3 text-sm text-muted-foreground">
          {validation.available
            ? "AI review completed but returned no output."
            : "AI advisory is unavailable (ANTHROPIC_API_KEY not set). You can still import the file — the deterministic checks above are the authoritative guide."}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          onClick={onCommit}
          disabled={busy}
          className="gap-2 text-primary-foreground"
        >
          <ClipboardList className="w-4 h-4" />
          {committing ? "Importing..." : "Import Order Review"}
        </Button>
        <Button variant="outline" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
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
