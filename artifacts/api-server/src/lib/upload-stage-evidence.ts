import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  uploadStageEvidenceTable,
  uploadStagingTable,
  type UploadStageEvidenceKind,
  type UploadStageEvidenceOutcome,
} from "@workspace/db";
import {
  classifyCumulativeRegressionProjects,
  compareOrderReviewCumulativeProgress,
  detectReportAsOnDate,
  parseOrderReview,
} from "./parse-order-review";
import { logger } from "./logger";

export type PersistStageEvidenceInput = {
  stagingId: string;
  sourceFilename: string;
  fileData: Buffer;
  kind: UploadStageEvidenceKind;
  reportDate: string | null;
  comparedAgainstImportId: number | null;
  assessment: unknown;
  blockers: unknown[];
  warnings: unknown[];
  details: Record<string, unknown>;
  projectCodes?: string[];
};

export function uploadSourceHash(fileData: Buffer): string {
  return createHash("sha256").update(fileData).digest("hex");
}

const DEFAULT_OUTCOME_REASON: Record<UploadStageEvidenceOutcome, string> = {
  imported: "Committed as an import.",
  skipped: "Discarded before import.",
  expired: "Expired from temporary staging storage before import.",
  refused: "Refused by commit-time validation.",
};

/** All accepted staged payloads retain evidence, even before a known type is found. */
export function evidenceKindForDetectedFileType(fileType: string): UploadStageEvidenceKind {
  return fileType === "wip" || fileType === "order-review" ? fileType : "unknown";
}

/**
 * Only a declared WIP slot is discarded by a WIP reset. For legacy staging
 * rows that predate expectedKind, require positive WIP detection rather than
 * risking deletion of an unparseable Order Review upload.
 */
export function shouldDiscardStagingForWipReset(
  expectedKind: "wip" | "order-review" | null,
  detectedFileType: string,
): boolean {
  return expectedKind === "wip" || (expectedKind == null && detectedFileType === "wip");
}

/**
 * Import may replace a provisional terminal state when the same staged payload
 * is retried successfully. Other outcomes only finalize an undecided record.
 */
export function canFinalizeEvidenceOutcome(
  existing: UploadStageEvidenceOutcome | null,
  requested: UploadStageEvidenceOutcome,
): boolean {
  return requested === "imported" || existing == null;
}

/**
 * Records the exact staged panel once. The staging row is disposable, but this
 * evidence is intentionally independent from it and has no cascading relation
 * to imports.
 */
export async function persistStageEvidence(
  input: PersistStageEvidenceInput,
): Promise<number> {
  const values = {
    stagingId: input.stagingId,
    sourceFilename: input.sourceFilename,
    sourceHash: uploadSourceHash(input.fileData),
    kind: input.kind,
    reportDate: input.reportDate,
    comparedAgainstImportId: input.comparedAgainstImportId,
    blockers: input.blockers,
    warnings: input.warnings,
    assessment: input.assessment,
    details: input.details,
    projectCodes: [...new Set(input.projectCodes ?? [])].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
  const inserted = await db
    .insert(uploadStageEvidenceTable)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: uploadStageEvidenceTable.id });
  if (inserted[0]) return inserted[0].id;

  const [existing] = await db
    .select({ id: uploadStageEvidenceTable.id })
    .from(uploadStageEvidenceTable)
    .where(eq(uploadStageEvidenceTable.stagingId, input.stagingId));
  if (!existing) throw new Error("Could not persist staged upload evidence");
  return existing.id;
}

export async function recordStageEvidenceOutcome(
  stagingId: string,
  outcome: UploadStageEvidenceOutcome,
  importId?: number | null,
  outcomeReason?: string,
): Promise<void> {
  const values = {
    outcome,
    outcomeAt: new Date(),
    outcomeReason: outcomeReason ?? DEFAULT_OUTCOME_REASON[outcome],
    ...(importId !== undefined ? { importId } : {}),
    ...(outcome === "imported"
      ? { importDeletedAt: null, importDeletionScope: null }
      : {}),
  };
  // A successful import is final. A refused/discarded attempt only applies while
  // no later final outcome exists, allowing an explicit override retry to end as
  // imported without losing the staged evidence itself.
  const predicate =
    outcome === "imported"
      ? eq(uploadStageEvidenceTable.stagingId, stagingId)
      : and(
          eq(uploadStageEvidenceTable.stagingId, stagingId),
          isNull(uploadStageEvidenceTable.outcome),
        );
  await db.update(uploadStageEvidenceTable).set(values).where(predicate);
}

export async function expireStageEvidence(
  stagingIds: readonly string[],
): Promise<void> {
  if (stagingIds.length === 0) return;
  for (const stagingId of stagingIds) {
    await recordStageEvidenceOutcome(
      stagingId,
      "expired",
      undefined,
      "Expired from temporary staging storage after the retention window.",
    );
  }
}

/**
 * The original 23→24 August stage panel was reconstructed from retained raw
 * staging bytes. Store it once as a reconstruction so the audit trail no longer
 * depends on a chat transcript. If those bytes have already expired, this is a
 * harmless no-op rather than a fabricated record.
 */
export async function backfillAugustOrderReviewEvidence(): Promise<void> {
  const key = "reconstruction:order-review:2026-08-23:2026-08-24";
  const [alreadyRecorded] = await db
    .select({ id: uploadStageEvidenceTable.id })
    .from(uploadStageEvidenceTable)
    .where(eq(uploadStageEvidenceTable.stagingId, key));
  if (alreadyRecorded) return;

  const stagedRows = await db
    .select()
    .from(uploadStagingTable)
    .where(isNotNull(uploadStagingTable.committedOrderReviewImportId));
  const parsed = stagedRows.flatMap((row) => {
    try {
      const date = detectReportAsOnDate(row.fileData, row.sourceFilename);
      if (date !== "2026-08-23" && date !== "2026-08-24") return [];
      return [{ row, date, parsed: parseOrderReview(row.fileData) }];
    } catch {
      return [];
    }
  });
  const baseline = parsed.find((candidate) => candidate.date === "2026-08-23");
  const incoming = parsed.find((candidate) => candidate.date === "2026-08-24");
  if (!baseline || !incoming) return;

  const comparison = compareOrderReviewCumulativeProgress(
    incoming.parsed.rows,
    baseline.parsed.rows,
  );
  const projectDetails = classifyCumulativeRegressionProjects(
    incoming.parsed.rows,
    baseline.parsed.rows,
    comparison.regressions,
  );
  if (projectDetails.length === 0) return;

  const assessment = {
    verdict: "blocked",
    blocking: projectDetails.map((detail) => ({
      title: `${detail.project} — reconstructed ${detail.classification}`,
      detail: "Historical reconstruction from retained 23-August and 24-August source bytes.",
      classification: detail.classification,
    })),
    warnings: comparison.missingProjects,
    deltas: [],
    information: [{
      title: "Historical reconstruction",
      detail:
        "Created after the original staging panel was lost during delete-and-re-import. This is not a live capture.",
    }],
    cumulativeOverrideRequired: true,
  };
  await db.insert(uploadStageEvidenceTable).values({
    stagingId: key,
    sourceFilename: incoming.row.sourceFilename,
    sourceHash: uploadSourceHash(incoming.row.fileData),
    kind: "order-review",
    reportDate: incoming.date,
    comparedAgainstImportId:
      baseline.row.committedOrderReviewImportId ?? null,
    blockers: assessment.blocking,
    warnings: assessment.warnings,
    assessment,
    details: {
      reconstructed: true,
      baseline: {
        sourceFilename: baseline.row.sourceFilename,
        sourceHash: uploadSourceHash(baseline.row.fileData),
        asOnDate: baseline.date,
        importId: baseline.row.committedOrderReviewImportId,
      },
      incoming: {
        sourceFilename: incoming.row.sourceFilename,
        sourceHash: uploadSourceHash(incoming.row.fileData),
        asOnDate: incoming.date,
        importId: incoming.row.committedOrderReviewImportId,
      },
      regressions: comparison.regressions,
      missingProjects: comparison.missingProjects,
      projectDetails,
    },
    projectCodes: projectDetails.map((detail) => detail.project),
    outcome: "imported",
    outcomeAt: new Date(),
    importId: incoming.row.committedOrderReviewImportId ?? null,
    isReconstruction: true,
    reconstructionNote:
      "Deterministic reconstruction from retained 23-August and 24-August source bytes; not a live stage-time capture.",
  }).onConflictDoNothing();
  logger.info(
    { projects: projectDetails.map((detail) => detail.project) },
    "Backfilled historical Order Review staging evidence",
  );
}