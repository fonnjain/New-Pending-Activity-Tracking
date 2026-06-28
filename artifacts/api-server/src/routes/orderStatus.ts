import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import {
  db,
  orderReviewImportsTable,
  orderDispatchTable,
} from "@workspace/db";
import {
  loadLatestOrderReview,
  crossCheckDispatch,
} from "../lib/dispatch";

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
  const latest = await loadLatestOrderReview();
  const dispatchRows = await db.select().from(orderDispatchTable);

  if (!latest) {
    res.json({
      available: false,
      asOnDate: null,
      fileImport: null,
      rows: [],
      reconciliation: { tolerancePct: 1, matched: 0, mismatched: 0, rows: [] },
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
      bomType: r.bomType,
      releaseMt: r.releaseMt,
      fileDespatchMt: r.fileDespatchMt,
      seedMt,
      accruedMt,
      computedDispatchMt: seedMt + accruedMt,
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
    imports,
  });
});

export default router;
