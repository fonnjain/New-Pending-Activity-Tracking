import { Router, type IRouter } from "express";
import { requireAuth } from "./auth";
import { recomputeMilestones } from "../lib/milestones";
import { recomputeDispatch } from "../lib/dispatch";
import { recomputeContractorMovement } from "../lib/contractorMovement";
import {
  backfillClassification,
  backfillHoleOperation,
  backfillJobCardType,
  backfillInitialCutting,
} from "../lib/backfill";
import { backfillReleaseBalanceFromPool } from "../lib/parseWipReleaseBalance";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Manual, on-demand trigger for every deterministic recompute/backfill pass the
// app otherwise runs automatically (best-effort after upload/delete/settings
// changes, or once at boot). Nothing here is authoritative or destructive —
// every pass is a pure re-derivation from permanent append-only history/raw
// columns, so running it repeatedly is always safe and idempotent. This exists
// purely as a manual fallback (e.g. a prior automatic pass failed silently, or
// the server restarted mid-backfill) — normal operation never requires it.
router.post("/admin/recompute", requireAuth, async (_req, res): Promise<void> => {
  try {
    const [
      classificationBackfilled,
      holeOperationBackfilled,
      milestones,
      contractorMovement,
      releaseBalanceBackfilled,
      jobCardTypeBackfilled,
      initialCuttingBackfilled,
    ] = await Promise.all([
      backfillClassification(),
      backfillHoleOperation(),
      recomputeMilestones(),
      recomputeContractorMovement(),
      backfillReleaseBalanceFromPool(),
      backfillJobCardType(),
      backfillInitialCutting(),
    ]);
    await recomputeDispatch();

    res.json({
      classificationBackfilled,
      holeOperationBackfilled,
      milestonesCount: milestones.length,
      contractorMovementEntries: contractorMovement.length,
      releaseBalanceBackfilled,
      jobCardTypeBackfilled,
      initialCuttingBackfilled,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ err, stack }, "Admin recompute failed");
    res.status(500).json({ error: "Recompute failed", message });
  }
});

export default router;
