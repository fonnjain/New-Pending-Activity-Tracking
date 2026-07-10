import { Router, type IRouter } from "express";
import { requireAuth } from "./auth";
import { recomputeMilestones } from "../lib/milestones";
import { recomputeDispatch } from "../lib/dispatch";
import { recomputeContractorMovement } from "../lib/contractorMovement";
import { backfillClassification, backfillHoleOperation } from "../lib/backfill";

const router: IRouter = Router();

// Manual, on-demand trigger for every deterministic recompute/backfill pass the
// app otherwise runs automatically (best-effort after upload/delete/settings
// changes, or once at boot). Nothing here is authoritative or destructive —
// every pass is a pure re-derivation from permanent append-only history/raw
// columns, so running it repeatedly is always safe and idempotent. This exists
// purely as a manual fallback (e.g. a prior automatic pass failed silently, or
// the server restarted mid-backfill) — normal operation never requires it.
router.post("/admin/recompute", requireAuth, async (_req, res): Promise<void> => {
  const [
    classificationBackfilled,
    holeOperationBackfilled,
    milestones,
    contractorMovement,
  ] = await Promise.all([
    backfillClassification(),
    backfillHoleOperation(),
    recomputeMilestones(),
    recomputeContractorMovement(),
  ]);
  await recomputeDispatch();

  res.json({
    classificationBackfilled,
    holeOperationBackfilled,
    milestonesCount: milestones.length,
    contractorMovementEntries: contractorMovement.length,
    generatedAt: new Date().toISOString(),
  });
});

export default router;
