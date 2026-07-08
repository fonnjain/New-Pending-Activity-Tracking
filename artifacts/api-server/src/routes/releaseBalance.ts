import { Router, type IRouter } from "express";
import { db, releaseBalanceWipTable } from "@workspace/db";
import { loadLatestOrderReview } from "../lib/dispatch";

const router: IRouter = Router();

// GET /release-balance — per-(project, structure) Release Balance Computed from
// the latest WIP file (Not Started + Initial rows, Col Q ÷ 1000 MT), joined to
// the Order Review's stated Release Balance (fileBalReleaseMt). Full outer join:
// OR-only structures appear with null computed; WIP-only structures appear with
// null OR value. Purely additive read: never mutates any state.
router.get("/release-balance", async (_req, res): Promise<void> => {
  const [wipRows, orderReview] = await Promise.all([
    db.select().from(releaseBalanceWipTable),
    loadLatestOrderReview(),
  ]);

  // Build WIP lookup keyed by project\u0001structure.
  const wipMap = new Map<
    string,
    { project: string; structure: string; computedMt: number }
  >();
  for (const w of wipRows) {
    wipMap.set(`${w.project}\u0001${w.structure}`, {
      project: w.project,
      structure: w.structure,
      computedMt: w.releaseBalanceComputedMt,
    });
  }

  // Build OR lookup. The DB stores one row per (project, structure) after the
  // BOM-summing fix in parse-order-review.ts. We still aggregate defensively here
  // in case older data was stored before the fix: summing null+null → null,
  // null+number → number, number+number → sum.
  const orMap = new Map<
    string,
    { project: string; structure: string; releaseMt: number | null }
  >();
  if (orderReview) {
    for (const r of orderReview.rows) {
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
      rows: [],
      totals: {
        releaseBalanceComputedMt: 0,
        releaseBalanceOrderReviewMt: 0,
        rowCount: 0,
      },
    });
    return;
  }

  // Full outer join across all (project, structure) keys present in either side.
  const allKeys = new Set([...wipMap.keys(), ...orMap.keys()]);
  const rows = [...allKeys]
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
    rows,
    totals,
  });
});

export default router;
