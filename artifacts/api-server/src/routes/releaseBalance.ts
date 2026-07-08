import { Router, type IRouter } from "express";
import { db, releaseBalanceWipTable } from "@workspace/db";
import { loadLatestOrderReview } from "../lib/dispatch";

const router: IRouter = Router();

// GET /release-balance — per-(project, structure) Release Balance Computed from
// the latest WIP file (Not Started + Initial rows, Col Q ÷ 1000 MT), joined to
// the Order Review's stated Release Balance (fileBalReleaseMt). Purely additive
// read: never mutates WIP / dispatch / milestone state.
router.get("/release-balance", async (_req, res): Promise<void> => {
  const [wipRows, orderReview] = await Promise.all([
    db.select().from(releaseBalanceWipTable),
    loadLatestOrderReview(),
  ]);

  if (wipRows.length === 0) {
    res.json({
      available: false,
      orderReviewAsOnDate: null,
      rows: [],
      totals: {
        releaseBalanceComputedMt: 0,
        releaseBalanceOrderReviewMt: 0,
        diffMt: 0,
        rowCount: 0,
      },
    });
    return;
  }

  const orMap = new Map<string, number | null>();
  if (orderReview) {
    for (const r of orderReview.rows) {
      orMap.set(
        `${r.project}\u0001${r.structure}`,
        r.fileBalReleaseMt ?? null,
      );
    }
  }

  const rows = wipRows
    .map((w) => {
      const orMt = orMap.get(`${w.project}\u0001${w.structure}`) ?? null;
      return {
        project: w.project,
        structure: w.structure,
        releaseBalanceComputedMt: w.releaseBalanceComputedMt,
        releaseBalanceOrderReviewMt: orMt,
        diffMt:
          orMt == null ? null : w.releaseBalanceComputedMt - orMt,
      };
    })
    .sort((a, b) =>
      a.project !== b.project
        ? a.project.localeCompare(b.project)
        : a.structure.localeCompare(b.structure),
    );

  const totals = rows.reduce(
    (acc, r) => ({
      releaseBalanceComputedMt:
        acc.releaseBalanceComputedMt + r.releaseBalanceComputedMt,
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
    rows,
    totals,
  });
});

export default router;
