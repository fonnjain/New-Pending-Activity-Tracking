import { Router, type IRouter } from "express";
import { db, releaseBalanceWipTable, importsTable } from "@workspace/db";
import { loadLatestOrderReview } from "../lib/dispatch";
import { desc, eq, sql } from "drizzle-orm";
import { GetReleaseBalanceQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// Mirror the OR parser's leading-dash normalization for structure keys.
// Strips exactly one leading "-" when the result is non-empty and contains at
// least one non-dash character. All-dash VR082 placeholders are left untouched.
function stripLeadingDash(structure: string): string {
  if (!structure.startsWith("-")) return structure;
  const stripped = structure.slice(1);
  if (!stripped || !/[^-]/.test(stripped)) return structure;
  return stripped;
}

// GET /release-balance — per-(project, structure) Release Balance Computed,
// optionally scoped to a specific import by ?importId=<id>.  When importId is
// omitted, falls back to the most recently committed WIP import so the
// Release Balance comparison page always shows up-to-date figures.
//
// Joined to the Order Review's stated Release Balance (fileBalReleaseMt) for
// cross-checking. Full outer join: OR-only structures appear with null
// computed; WIP-only structures appear with null OR value.
// Purely additive read: never mutates any state.
//
// Also returns batchBreakdown: per-(project, mfcBatch) sums of the WIP
// release balance, with no OR join. Used by the project-wise batch view to
// show the correct per-batch release balance without cross-contaminating the
// project+structure comparison table.
router.get("/release-balance", async (req, res): Promise<void> => {
  const parsed = GetReleaseBalanceQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "importId must be a positive integer" });
    return;
  }
  const { importId: requestedImportId } = parsed.data;

  // Resolve the target import: use the requested one when provided, otherwise
  // the latest committed WIP import.
  let targetImportId: number | null = requestedImportId ?? null;
  if (targetImportId == null) {
    const [latest] = await db
      .select({ id: importsTable.id })
      .from(importsTable)
      .orderBy(desc(importsTable.id))
      .limit(1);
    targetImportId = latest?.id ?? null;
  }

  // If there's no import at all yet, return empty.
  if (targetImportId == null) {
    res.json({
      available: false,
      orderReviewAsOnDate: null,
      importId: null,
      rows: [],
      batchBreakdown: [],
      totals: {
        releaseBalanceComputedMt: 0,
        releaseBalanceOrderReviewMt: 0,
        rowCount: 0,
      },
    });
    return;
  }

  const [wipRows, orderReview, batchBreakdown] = await Promise.all([
    db
      .select()
      .from(releaseBalanceWipTable)
      .where(eq(releaseBalanceWipTable.importId, targetImportId)),
    loadLatestOrderReview(),
    // Per-(project, mfcBatch) sums — no OR join, no structure granularity.
    // Used by the batch-view client to look up release balance per project+batch.
    db
      .select({
        project: releaseBalanceWipTable.project,
        mfcBatch: releaseBalanceWipTable.mfcBatch,
        releaseBalanceComputedMt: sql<number>`sum(${releaseBalanceWipTable.releaseBalanceComputedMt})`,
      })
      .from(releaseBalanceWipTable)
      .where(eq(releaseBalanceWipTable.importId, targetImportId))
      .groupBy(releaseBalanceWipTable.project, releaseBalanceWipTable.mfcBatch),
  ]);

  // Build WIP lookup keyed by project\u0001structure (aggregated across batches
  // for the OR comparison table — OR has no batch dimension).
  // Apply the same leading-dash normalization the OR parser uses so that
  // e.g. WIP "-069-2NBD2" and OR "069-2NBD2" resolve to the same key and
  // collapse into a single joined row instead of splitting into two.
  const wipMap = new Map<
    string,
    { project: string; structure: string; computedMt: number }
  >();
  for (const w of wipRows) {
    const normalizedStructure = stripLeadingDash(w.structure);
    const key = `${w.project}\u0001${normalizedStructure}`;
    const existing = wipMap.get(key);
    if (existing) {
      // Two WIP structures or batches collapsed to the same normalized key — sum them.
      existing.computedMt += w.releaseBalanceComputedMt;
    } else {
      wipMap.set(key, {
        project: w.project,
        structure: normalizedStructure,
        computedMt: w.releaseBalanceComputedMt,
      });
    }
  }

  // Build OR lookup — scoped to the LATEST Order Review import only.
  // order_review_rows is an UPSERT table: every (project, structure) has one row
  // whose import_id is set to the most-recent OR import that included it. Rows
  // from older imports that were NOT present in the latest upload keep their old
  // import_id. We only want the current file's structures, so we filter to
  // import_id = latest_import_id.
  const orMap = new Map<
    string,
    { project: string; structure: string; releaseMt: number | null }
  >();
  if (orderReview) {
    const latestOrImportId = orderReview.import.id;
    for (const r of orderReview.rows.filter(
      (row) => row.importId === latestOrImportId,
    )) {
      const key = `${r.project}\u0001${r.structure}`;
      const prev = orMap.get(key);
      if (!prev) {
        orMap.set(key, {
          project: r.project,
          structure: r.structure,
          releaseMt: r.fileBalReleaseMt ?? null,
        });
      } else {
        const a = prev.releaseMt;
        const b = r.fileBalReleaseMt ?? null;
        prev.releaseMt =
          a == null && b == null ? null : (a ?? 0) + (b ?? 0);
      }
    }
  }

  if (wipMap.size === 0 && orMap.size === 0) {
    res.json({
      available: false,
      orderReviewAsOnDate: null,
      importId: targetImportId,
      rows: [],
      batchBreakdown,
      totals: {
        releaseBalanceComputedMt: 0,
        releaseBalanceOrderReviewMt: 0,
        rowCount: 0,
      },
    });
    return;
  }

  // Scope to the current snapshot:
  //   (a) every key present in the latest Order Review, PLUS
  //   (b) every WIP key where Release Balance Computed > 0.
  // This excludes historical record_pool structures that are absent from the
  // current loaded files. A separate filter below drops any row where both
  // sides end up null/zero (e.g. OR structure with null release + no WIP).
  const candidateKeys = new Set<string>();
  for (const key of orMap.keys()) candidateKeys.add(key);
  for (const [key, w] of wipMap.entries()) {
    if (w.computedMt > 0) candidateKeys.add(key);
  }

  const rows = [...candidateKeys]
    .map((key) => {
      const wip = wipMap.get(key);
      const or = orMap.get(key);
      const project = wip?.project ?? or!.project;
      const structure = wip?.structure ?? or!.structure;
      const computedMt = wip?.computedMt ?? null;
      const orMt = or?.releaseMt ?? null;
      const diffMt =
        computedMt != null && orMt != null ? computedMt - orMt : null;
      return {
        project,
        structure,
        releaseBalanceComputedMt: computedMt,
        releaseBalanceOrderReviewMt: orMt,
        diffMt,
      };
    })
    // Drop rows where both columns are null/zero — these are OR structures that
    // have no release value on either side (e.g. null OR value + no WIP entry).
    .filter(
      (r) =>
        (r.releaseBalanceComputedMt != null && r.releaseBalanceComputedMt > 0) ||
        (r.releaseBalanceOrderReviewMt != null && r.releaseBalanceOrderReviewMt > 0),
    )
    .sort((a, b) =>
      a.project !== b.project
        ? a.project.localeCompare(b.project)
        : a.structure.localeCompare(b.structure),
    );

  const totals = rows.reduce(
    (acc, r) => ({
      releaseBalanceComputedMt:
        acc.releaseBalanceComputedMt + (r.releaseBalanceComputedMt ?? 0),
      releaseBalanceOrderReviewMt:
        acc.releaseBalanceOrderReviewMt + (r.releaseBalanceOrderReviewMt ?? 0),
      diffMt: acc.diffMt + (r.diffMt ?? 0),
      rowCount: acc.rowCount + 1,
    }),
    {
      releaseBalanceComputedMt: 0,
      releaseBalanceOrderReviewMt: 0,
      diffMt: 0,
      rowCount: 0,
    },
  );

  res.json({
    available: true,
    orderReviewAsOnDate: orderReview?.import.asOnDate ?? null,
    importId: targetImportId,
    rows,
    batchBreakdown,
    totals,
  });
});

export default router;
