import { Router, type IRouter } from "express";
import {
  db,
  releaseBalanceWipTable,
  assignmentBalanceWipTable,
  importRowsTable,
  recordPoolTable,
  importsTable,
} from "@workspace/db";
import { desc, eq, and, sql, or } from "drizzle-orm";
import { bundleActivitySet } from "@workspace/domain";
import { loadLatestOrderReview } from "../lib/dispatch";

// Quality Check activities = TLT_FAB_PENDING_QUALITY bundle (RFI…TS).
// This is the sub-bundle that EXCLUDES the cutting-prep steps C and HG.
// TLT_FABRICATION = slice(0,GALV) = C+HG+RFI…TS; TLT_FAB_PENDING_QUALITY = slice(RFI,GALV).
// Reuses the canonical bundle definition — do NOT redefine a local list.
const QC_ACTS = [...(bundleActivitySet("TLT_FAB_PENDING_QUALITY") ?? [])]; // uppercased

// BOM label canonical display order for sorting.
const BOM_ORDER = ["Proto", "Mass", "Pre", "Mixed", "Unknown"];

function bomSortIndex(label: string): number {
  const i = BOM_ORDER.indexOf(label);
  return i === -1 ? BOM_ORDER.length : i;
}

function structureKey(project: string, structure: string): string {
  return `${project}\u0001${structure}`;
}

const router: IRouter = Router();

// GET /reports/fabrication-project-completion-tlt
// Fabrication Report – Project Completion (TLT only).
// Grouped by (project × BOM Label). TLT marks only.
// Measures: Release Balance Calc, Assignment Balance Calc, Cutting Balance, Quality Check Balance.
// All weights in MT (kg ÷ 1000).
router.get(
  "/reports/fabrication-project-completion-tlt",
  async (_req, res): Promise<void> => {
    const ZERO_TOTALS = {
      releaseBalanceCalcMt: 0,
      assignmentBalanceCalcMt: 0,
      cuttingBalanceMt: 0,
      qualityCheckBalanceMt: 0,
    };

    // 1. Find the latest WIP import.
    const [latestImport] = await db
      .select({ id: importsTable.id })
      .from(importsTable)
      .orderBy(desc(importsTable.id))
      .limit(1);

    if (!latestImport) {
      res.json({ available: false, rows: [], totals: ZERO_TOTALS });
      return;
    }

    // 2. Run all data queries in parallel.
    const qualityFilter = or(
      ...QC_ACTS.map((a) => eq(sql`upper(${recordPoolTable.activity})`, a)),
    );

    const [
      tltStructures,
      cuttingAgg,
      qualityAgg,
      releaseRows,
      assignmentRows,
      orderReview,
    ] = await Promise.all([
      // All distinct TLT (project, structure) pairs for the latest import.
      db
        .selectDistinct({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
        })
        .from(importRowsTable)
        .innerJoin(
          recordPoolTable,
          eq(importRowsTable.poolId, recordPoolTable.id),
        )
        .where(
          and(
            eq(importRowsTable.importId, latestImport.id),
            eq(recordPoolTable.category, "TLT"),
          ),
        ),

      // Cutting balance (activity = C) per (project, structure).
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt}) / 1000.0, 0)`,
        })
        .from(importRowsTable)
        .innerJoin(
          recordPoolTable,
          eq(importRowsTable.poolId, recordPoolTable.id),
        )
        .where(
          and(
            eq(importRowsTable.importId, latestImport.id),
            eq(recordPoolTable.category, "TLT"),
            eq(sql`upper(${recordPoolTable.activity})`, "C"),
          ),
        )
        .groupBy(recordPoolTable.job, recordPoolTable.structure),

      // Quality check balance (RFI,NH,B,HAB,W,Q,TS) per (project, structure).
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt}) / 1000.0, 0)`,
        })
        .from(importRowsTable)
        .innerJoin(
          recordPoolTable,
          eq(importRowsTable.poolId, recordPoolTable.id),
        )
        .where(
          and(
            eq(importRowsTable.importId, latestImport.id),
            eq(recordPoolTable.category, "TLT"),
            qualityFilter,
          ),
        )
        .groupBy(recordPoolTable.job, recordPoolTable.structure),

      // Release balance (JCNS + Initial) — pre-computed, whole-file.
      db.select().from(releaseBalanceWipTable),

      // Assignment balance (JCNS + blank contractor) — pre-computed, whole-file.
      db.select().from(assignmentBalanceWipTable),

      // Order Review for BOM labels.
      loadLatestOrderReview(),
    ]);

    // 3. Build lookup maps keyed by "project\x01structure".
    const releaseMap = new Map<string, number>(
      releaseRows.map((r) => [
        structureKey(r.project, r.structure),
        r.releaseBalanceComputedMt,
      ]),
    );
    const assignmentMap = new Map<string, number>(
      assignmentRows.map((r) => [
        structureKey(r.project, r.structure),
        r.assignmentBalanceComputedMt,
      ]),
    );
    const cuttingMap = new Map<string, number>(
      cuttingAgg.map((r) => [
        structureKey(r.project, r.structure),
        r.balanceMt,
      ]),
    );
    const qualityMap = new Map<string, number>(
      qualityAgg.map((r) => [
        structureKey(r.project, r.structure),
        r.balanceMt,
      ]),
    );

    // 4. Build BOM label map from Order Review rows.
    // For each (project, structure), collect the set of distinct non-null bomType
    // values. Exactly one → that label; 0 → "Unknown"; 2+ → "Mixed".
    const bomDistinct = new Map<string, Set<string>>();
    if (orderReview) {
      for (const r of orderReview.rows) {
        const k = structureKey(r.project, r.structure);
        if (!bomDistinct.has(k)) bomDistinct.set(k, new Set());
        if (r.bomType) bomDistinct.get(k)!.add(r.bomType);
      }
    }

    function getBomLabel(project: string, structure: string): string {
      const types = bomDistinct.get(structureKey(project, structure));
      if (!types || types.size === 0) return "Unknown";
      if (types.size === 1) return [...types][0]!;
      return "Mixed";
    }

    // 5. Group by (project, bomLabel), summing all 4 measures.
    const grouped = new Map<
      string,
      {
        project: string;
        bomLabel: string;
        releaseBalanceCalcMt: number;
        assignmentBalanceCalcMt: number;
        cuttingBalanceMt: number;
        qualityCheckBalanceMt: number;
      }
    >();

    for (const { project, structure } of tltStructures) {
      const bomLabel = getBomLabel(project, structure);
      const gKey = structureKey(project, bomLabel);

      const relMt =
        releaseMap.get(structureKey(project, structure)) ?? 0;
      const assignMt =
        assignmentMap.get(structureKey(project, structure)) ?? 0;
      const cutMt =
        cuttingMap.get(structureKey(project, structure)) ?? 0;
      const qcMt =
        qualityMap.get(structureKey(project, structure)) ?? 0;

      const existing = grouped.get(gKey);
      if (!existing) {
        grouped.set(gKey, {
          project,
          bomLabel,
          releaseBalanceCalcMt: relMt,
          assignmentBalanceCalcMt: assignMt,
          cuttingBalanceMt: cutMt,
          qualityCheckBalanceMt: qcMt,
        });
      } else {
        existing.releaseBalanceCalcMt += relMt;
        existing.assignmentBalanceCalcMt += assignMt;
        existing.cuttingBalanceMt += cutMt;
        existing.qualityCheckBalanceMt += qcMt;
      }
    }

    // 6. Sort: project ascending, then BOM label in canonical order.
    const rows = [...grouped.values()].sort((a, b) => {
      const pc = a.project.localeCompare(b.project);
      if (pc !== 0) return pc;
      return bomSortIndex(a.bomLabel) - bomSortIndex(b.bomLabel);
    });

    // 7. Compute grand totals.
    const totals = rows.reduce(
      (acc, r) => ({
        releaseBalanceCalcMt: acc.releaseBalanceCalcMt + r.releaseBalanceCalcMt,
        assignmentBalanceCalcMt:
          acc.assignmentBalanceCalcMt + r.assignmentBalanceCalcMt,
        cuttingBalanceMt: acc.cuttingBalanceMt + r.cuttingBalanceMt,
        qualityCheckBalanceMt:
          acc.qualityCheckBalanceMt + r.qualityCheckBalanceMt,
      }),
      ZERO_TOTALS,
    );

    res.json({ available: true, rows, totals });
  },
);

export default router;
