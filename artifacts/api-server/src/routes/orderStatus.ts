import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  orderReviewAnomaliesTable,
  orderReviewImportsTable,
  orderReviewRowsTable,
  orderDispatchTable,
  dispatchLedgerTable,
  importDeletionLogTable,
  uploadStageEvidenceTable,
} from "@workspace/db";
import {
  loadLatestOrderReview,
  crossCheckDispatch,
  crossCheckBalance,
  recomputeDispatch,
} from "../lib/dispatch";
import {
  hasRecentCumulativeOverride,
  orderReviewDeletionCleanup,
} from "../lib/order-review-maintenance";
import { requireAdmin, requireAuth } from "./auth";
import {
  ListOrderReviewAnomaliesResponse,
  UpdateOrderReviewAnomalyBody,
  UpdateOrderReviewAnomalyParams,
  UpdateOrderReviewAnomalyResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function anomalyResponse(row: typeof orderReviewAnomaliesTable.$inferSelect) {
  return {
    id: row.id,
    project: row.project,
      signature: row.signature,
      reason: row.reason,
    status: row.status,
    explanation: row.explanation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Order Status (the second-file overlay): per (project, structure) order rows
// from the latest Order Review ingest, joined to the computed running Dispatch
// (seed + Yard-departure accruals). Fabrication / Galvanizing / Yard tonnages
// are computed CLIENT-SIDE from the selected WIP import's records (via
// ACTIVITY_BUNDLES) so header filters are honoured — this endpoint serves only
// the file-sourced fields + dispatch + the file-vs-computed reconciliation.
// Purely additive: reads only; never mutates WIP / dispatch state.
// ---------------------------------------------------------------------------

router.get("/order-status", async (_req, res): Promise<void> => {
  // Fire both reads in parallel — Order Review rows and dispatch table are
  // independent data sources with no read/write dependency.
  const [latest, dispatchRows, imports] = await Promise.all([
    loadLatestOrderReview(),
    db.select().from(orderDispatchTable),
    db
      .select()
      .from(orderReviewImportsTable)
      .orderBy(desc(orderReviewImportsTable.id)),
  ]);
  const recentCumulativeOverrides = imports.filter((imp) =>
    hasRecentCumulativeOverride(imp.overrideAt),
  );

  if (!latest) {
    res.json({
      available: false,
      asOnDate: null,
      fileImport: null,
      rows: [],
      reconciliation: { tolerancePct: 1, matched: 0, mismatched: 0, rows: [] },
      balanceReconciliation: {
        tolerancePct: 1,
        absFloorMt: 0.05,
        releaseMatched: 0,
        releaseMismatched: 0,
        dispatchMatched: 0,
        dispatchMismatched: 0,
        rows: [],
      },
      imports: [],
      recentCumulativeOverrides: [],
    });
    return;
  }

  const dispatchByKey = new Map(
    dispatchRows.map((d) => [`${d.project}\u0001${d.structure}`, d]),
  );

  const rows = latest.rows.map((r) => {
    const d = dispatchByKey.get(`${r.project}\u0001${r.structure}`);
    const seedMt = d?.seedMt ?? 0;
    const accruedMt = d?.accruedMt ?? 0;
    return {
      project: r.project,
      structure: r.structure,
      subType: r.subType,
      sets: r.sets,
      weightMt: r.weightMt,
      woOrderQtyMt: r.woOrderQtyMt,
      bomType: r.bomType,
      releaseMt: r.releaseMt,
      fileFabMt: r.fabMt,
      fileGalvMt: r.galvMt,
      inspectionMt: r.inspectionMt,
      fileDespatchMt: r.fileDespatchMt,
      fileBalReleaseMt: r.fileBalReleaseMt,
      fileBalDespatchMt: r.fileBalDespatchMt,
      // Balance from WO Order Qty (col J) — the ordered base — minus Release (L)
      // and Despatch (Q). Null WO Order Qty leaves these null (no base to net).
      releaseBalanceMt:
        r.woOrderQtyMt == null ? null : r.woOrderQtyMt - (r.releaseMt ?? 0),
      dispatchBalanceMt:
        r.woOrderQtyMt == null
          ? null
          : r.woOrderQtyMt - (r.fileDespatchMt ?? 0),
      seedMt,
      accruedMt,
      // Computed Dispatch is WIP-derived only (tonnage observed leaving the
      // Yard). The Order Review file feeds File Dispatch (fileDespatchMt) and
      // the seed baseline (seedMt) ONLY; it never contributes to this figure.
      computedDispatchMt: accruedMt,
      // Balance Fabrication (col T) and Balance Galvanising (col U) from file.
      balFabMt: r.balFabMt,
      balGalvMt: r.balGalvMt,
      // Balance Work Order (col R) from file — remaining WO qty after despatch.
      balWoMt: r.balWoMt,
      // A current order row whose last-seen import is older than the latest
      // ingest was absent from the latest file (kept, never deleted).
      notInLatest: r.importId !== latest.import.id,
    };
  });

  const reconciliation = crossCheckDispatch(
    latest.rows.map((r) => ({
      project: r.project,
      structure: r.structure,
      fileDespatchMt: r.fileDespatchMt,
    })),
    dispatchRows,
  );

  // File-vs-computed cross-check for the two order balances (Release balance =
  // J - L vs file col S; Despatch balance = J - Q vs file col W).
  const balanceReconciliation = crossCheckBalance(
    latest.rows.map((r) => ({
      project: r.project,
      structure: r.structure,
      woOrderQtyMt: r.woOrderQtyMt,
      releaseMt: r.releaseMt,
      fileDespatchMt: r.fileDespatchMt,
      fileBalReleaseMt: r.fileBalReleaseMt,
      fileBalDespatchMt: r.fileBalDespatchMt,
    })),
  );

  res.json({
    available: true,
    asOnDate: latest.import.asOnDate,
    fileImport: latest.import,
    rows,
    reconciliation,
    balanceReconciliation,
    imports,
    recentCumulativeOverrides,
  });
});

// ---------------------------------------------------------------------------
// Order Review anomaly register — durable investigation metadata. It is
// deliberately separate from the cumulative guard: changing this register can
// never waive blockers, alter tolerance, or change report calculations.
// ---------------------------------------------------------------------------

router.get(
  "/order-review/anomalies",
  requireAuth,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(orderReviewAnomaliesTable)
      .orderBy(desc(orderReviewAnomaliesTable.updatedAt), orderReviewAnomaliesTable.project);
    res.json(ListOrderReviewAnomaliesResponse.parse(rows.map(anomalyResponse)));
  },
);

router.patch(
  "/order-review/anomalies/:project",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateOrderReviewAnomalyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateOrderReviewAnomalyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const actor = req.user?.displayName || req.user?.email || "unknown";
    const [updated] = await db
      .update(orderReviewAnomaliesTable)
      .set({
        status: body.data.status,
        explanation: body.data.explanation.trim(),
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(orderReviewAnomaliesTable.project, params.data.project.trim()))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Order Review anomaly not found" });
      return;
    }
    res.json(UpdateOrderReviewAnomalyResponse.parse(anomalyResponse(updated)));
  },
);

// ---------------------------------------------------------------------------
// DELETE /order-imports/:id — remove one Order Review upload from the history.
// The Order Review file is a daily snapshot merged (UPSERTed) into ONE current
// order book per (project, structure). An older value cannot be reconstructed
// after an UPSERT, so rows last seen in a deleted upload are removed rather than
// silently re-attributed to a surviving import. Rows last seen in other uploads
// remain untouched. When no uploads remain, the entire order/dispatch overlay is
// cleared.
// Purely additive to WIP state — never touches WIP parsing/activity/dedup/
// ageing/warning/milestone math.
// ---------------------------------------------------------------------------
router.delete("/order-imports/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    // Serialize with the shared Order Review / WIP commit lock so concurrent
    // deletes can't each read a stale "remaining" snapshot and both skip cleanup.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(728041)`);

    const [target] = await tx
      .select({
        id: orderReviewImportsTable.id,
        sourceFilename: orderReviewImportsTable.sourceFilename,
        asOnDate: orderReviewImportsTable.asOnDate,
      })
      .from(orderReviewImportsTable)
      .where(eq(orderReviewImportsTable.id, id));
    if (!target) return false;

    // Keep the retained evidence link in the same transaction as deletion.
    await tx
      .update(uploadStageEvidenceTable)
      .set({
        importDeletedAt: new Date(),
        importDeletionScope: "single Order Review deletion",
      })
      .where(
        and(
          eq(uploadStageEvidenceTable.kind, "order-review"),
          eq(uploadStageEvidenceTable.importId, id),
        ),
      );
    await tx
      .delete(orderReviewImportsTable)
      .where(eq(orderReviewImportsTable.id, id));
    try {
      const actor = req.user?.displayName || req.user?.email || "unknown";
      await tx.insert(importDeletionLogTable).values({
        importId: target.id,
        fileType: "order-review",
        sourceFilename: target.sourceFilename,
        reportDate: target.asOnDate ?? null,
        deletedBy: actor,
      });
    } catch (err) {
      req.log.warn({ err, importId: id }, "Could not write Order Review deletion log");
    }

    // Base cleanup on POST-delete DB state (inside the lock), never on a
    // pre-delete snapshot.
    const remaining = await tx
      .select({ id: orderReviewImportsTable.id })
      .from(orderReviewImportsTable);
    const cleanup = orderReviewDeletionCleanup(remaining.length);
    if (cleanup === "clear-order-book-and-dispatch") {
      // No uploads left: clear the merged order book and the computed dispatch
      // overlay so the system returns to a clean "no Order Review" state.
      await tx.delete(orderReviewRowsTable);
      await tx.delete(orderDispatchTable);
      await tx.delete(dispatchLedgerTable);
    } else {
      // Do not repoint. A remaining import did not actually contain these keys;
      // retaining them under a different ID would make history misleading.
      await tx.delete(orderReviewRowsTable).where(eq(orderReviewRowsTable.importId, id));
      // A dispatch record with no live Order Review key is not useful and makes
      // the overlay internally inconsistent. Its ledger entries are pruned too;
      // the remaining keys are replayed below from durable WIP history.
      await tx.execute(sql`
        DELETE FROM "order_dispatch" AS dispatch
        WHERE NOT EXISTS (
          SELECT 1
          FROM "order_review_rows" AS review
          WHERE review."project" = dispatch."project"
            AND review."structure" = dispatch."structure"
        )
      `);
      await tx.execute(sql`
        DELETE FROM "dispatch_ledger" AS ledger
        WHERE NOT EXISTS (
          SELECT 1
          FROM "order_dispatch" AS dispatch
          WHERE dispatch."project" = ledger."project"
            AND dispatch."structure" = ledger."structure"
        )
      `);
    }
    return true;
  });

  if (!deleted) {
    res.status(404).json({ error: "Order Review import not found" });
    return;
  }

  // The dispatch overlay is derived from durable Order Review + WIP history.
  // Rebuild it after the transaction so deleted seeds cannot linger. A failure
  // is logged; the next deterministic recompute also repairs it.
  try {
    await recomputeDispatch();
  } catch (err) {
    req.log.error({ err, importId: id }, "Order Review deletion dispatch rebuild failed");
  }

  res.sendStatus(204);
});

export default router;
