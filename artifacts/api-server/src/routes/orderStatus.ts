import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  orderReviewImportsTable,
  orderReviewRowsTable,
  orderDispatchTable,
  dispatchLedgerTable,
} from "@workspace/db";
import {
  loadLatestOrderReview,
  crossCheckDispatch,
  crossCheckBalance,
} from "../lib/dispatch";
import { requireAuth } from "./auth";

const router: IRouter = Router();

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
  const [latest, dispatchRows] = await Promise.all([
    loadLatestOrderReview(),
    db.select().from(orderDispatchTable),
  ]);

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

  const imports = await db
    .select()
    .from(orderReviewImportsTable)
    .orderBy(desc(orderReviewImportsTable.id));

  res.json({
    available: true,
    asOnDate: latest.import.asOnDate,
    fileImport: latest.import,
    rows,
    reconciliation,
    balanceReconciliation,
    imports,
  });
});

// ---------------------------------------------------------------------------
// DELETE /order-imports/:id — remove one Order Review upload from the history.
// The Order Review file is a daily snapshot merged (UPSERTed) into ONE current
// order book per (project, structure); history entries do not own per-import
// rows, so deleting a log entry does NOT roll back current order-book values.
//   - Deleting the most recent upload re-points current snapshot rows (which we
//     cannot un-merge) to the now-latest remaining upload, so they stay flagged
//     as present in the latest file.
//   - Deleting the last remaining upload clears the entire order book (rows +
//     computed dispatch + ledger) so the overlay returns to available:false with
//     no orphaned rows.
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
      .select({ id: orderReviewImportsTable.id })
      .from(orderReviewImportsTable)
      .where(eq(orderReviewImportsTable.id, id));
    if (!target) return false;

    await tx
      .delete(orderReviewImportsTable)
      .where(eq(orderReviewImportsTable.id, id));

    // Base cleanup/repoint on POST-delete DB state (inside the lock), never on a
    // pre-delete snapshot.
    const remaining = await tx
      .select({ id: orderReviewImportsTable.id })
      .from(orderReviewImportsTable);
    if (remaining.length === 0) {
      // No uploads left: clear the merged order book and the computed dispatch
      // overlay so the system returns to a clean "no Order Review" state.
      await tx.delete(orderReviewRowsTable);
      await tx.delete(orderDispatchTable);
      await tx.delete(dispatchLedgerTable);
    } else {
      const newLatest = Math.max(...remaining.map((r) => r.id));
      // Deleting the most recent upload: the merged snapshot rows can't be rolled
      // back, so attribute them to the now-latest upload (keeps notInLatest sane).
      if (id > newLatest) {
        await tx
          .update(orderReviewRowsTable)
          .set({ importId: newLatest })
          .where(eq(orderReviewRowsTable.importId, id));
      }
    }
    return true;
  });

  if (!deleted) {
    res.status(404).json({ error: "Order Review import not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
