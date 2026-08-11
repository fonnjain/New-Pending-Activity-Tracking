import { Router, type IRouter } from "express";
import {
  db,
  importRowsTable,
  recordPoolTable,
  importsTable,
} from "@workspace/db";
import { desc, eq, and, sql, or } from "drizzle-orm";
import { loadLatestOrderReview, loadLatestWipImport } from "../lib/dispatch";

// Individual fab activities tracked between Cutting and Quality Check.
// Order mirrors the TLT process sequence: C → HG → RFI → NH → B → HAB → W → Q → TS
// Quality Check = Q + TS only (the final quality/test step).
const FAB_MID_ACTS = ["HG", "RFI", "NH", "B", "HAB", "W", "Q", "TS"] as const;
type FabMidAct = (typeof FAB_MID_ACTS)[number];

// BOM label canonical display order for sorting.
const BOM_ORDER = ["Proto", "Mass", "Pre", "Mixed", "No BOM match"];

function bomSortIndex(label: string): number {
  const i = BOM_ORDER.indexOf(label);
  return i === -1 ? BOM_ORDER.length : i;
}

// Sub-type group order for sorting within a BOM label.
const SUBTYPE_ORDER = ["STUB", "SST", "Other"];

function subTypeSortIndex(g: string): number {
  const i = SUBTYPE_ORDER.indexOf(g);
  return i === -1 ? SUBTYPE_ORDER.length : i;
}

// Classify a raw WIP Tower Sub Type (Col I) into STUB | SST | Other.
// Normalise: uppercase, strip dots/spaces/hyphens, then compare.
function classifySubType(raw: string | null): "STUB" | "SST" | "Other" {
  if (!raw) return "Other";
  const norm = raw.trim().toUpperCase().replace(/[.\s-]/g, "");
  if (norm === "STUB") return "STUB";
  if (norm === "SST") return "SST";
  return "Other";
}

function structureKey(project: string, structure: string): string {
  return `${project}\u0001${structure}`;
}

// Per-mark batch key: (project, structure, mfcBatch) → unique lookup key so each
// mark's weight is attributed to the batch it actually carries, not the dominant
// batch of the whole structure.  mfcBatch null/empty → sentinel "".
function batchKey(project: string, structure: string, mfcBatch: string | null): string {
  return `${project}\u0001${structure}\u0001${mfcBatch ?? ""}`;
}

// ---------------------------------------------------------------------------
// Unknown-cause classification
// ---------------------------------------------------------------------------
// Classifies a WIP structure code that has no OR match into:
//   "mismatch"  — an OR structure exists under a slightly different code
//                 (differs by a leading numeric prefix, trailing -X suffix, or leading dash)
//   "absent"    — no plausible OR counterpart found
//
// Rules (applied to OR structures, both directions):
//   R1: OR has leading digit(s), WIP doesn't → strip OR's leading digits and compare
//   R2: WIP has leading digit(s), OR doesn't → strip WIP's leading digits and compare
//   R3: OR has trailing "-word" suffix, WIP doesn't → strip OR's suffix and compare
//   R4: OR has a leading dash, WIP doesn't → strip OR's leading dash and compare
//
// If 0 candidates → "absent".  1 candidate → "mismatch" (not ambiguous).  2+ → "mismatch" (ambiguous).
// This is for the footnote ONLY; it does NOT auto-fix any matching.
function classifyCause(
  wip: string,
  orStructures: string[],
): { cause: "mismatch" | "absent"; candidates: string[]; ambiguous: boolean } {
  const candidates: string[] = [];

  for (const orStr of orStructures) {
    let matched = false;

    // R1: OR has leading digits, WIP doesn't (e.g. OR "1DS3", WIP "DS3")
    if (!matched) {
      const stripped = orStr.replace(/^\d+/, "");
      if (stripped !== orStr && stripped === wip) matched = true;
    }

    // R2: WIP has leading digits, OR doesn't (e.g. WIP "2OC3", OR "OC3")
    if (!matched) {
      const stripped = wip.replace(/^\d+/, "");
      if (stripped !== wip && stripped === orStr) matched = true;
    }

    // R3: OR has trailing "-word" suffix, WIP doesn't (e.g. OR "1BUS-I", WIP "1BUS")
    if (!matched) {
      const stripped = orStr.replace(/-[\w]+$/, "");
      if (stripped !== orStr && stripped === wip) matched = true;
    }

    // R4: OR has a leading dash, WIP doesn't (e.g. OR "-ABC", WIP "ABC")
    if (!matched && orStr.startsWith("-") && orStr.slice(1) === wip) matched = true;

    if (matched) candidates.push(orStr);
  }

  if (candidates.length === 0) return { cause: "absent", candidates: [], ambiguous: false };
  return { cause: "mismatch", candidates, ambiguous: candidates.length > 1 };
}

const router: IRouter = Router();

// GET /reports/fabrication-project-completion-tlt
// Fabrication Report – Project Completion (TLT only).
// Grouped by (project × BOM Label × Sub-type × MFC Batch). TLT marks only.
// Measures: Release Balance Calc, Assignment Balance Calc, Cutting Balance, individual
// fab activities (HG, RFI, NH, B, HAB, W), Quality Check Balance (Q+TS).
// All weights in MT (kg ÷ 1000).
//
// Per-mark batch attribution: each mark's weight is credited to the mfc_batch it
// carries, not the dominant batch of its structure.  Structures with marks in two
// distinct batches produce two rows with independent measure columns.
router.get(
  "/reports/fabrication-project-completion-tlt",
  async (_req, res): Promise<void> => {
    const ZERO_TOTALS = {
      releaseBalanceCalcMt: 0,
      assignmentBalanceCalcMt: 0,
      cuttingBalanceMt: 0,
      hgBalanceMt: 0,
      rfiBalanceMt: 0,
      nhBalanceMt: 0,
      bBalanceMt: 0,
      habBalanceMt: 0,
      wBalanceMt: 0,
      qBalanceMt: 0,  // Quality Check — Q only
      tsBalanceMt: 0, // Test/Sign-off — TS only (shown separately, excluded from Total)
    };

    // 1. Find the latest WIP import.
    const latestImport = await loadLatestWipImport();

    if (!latestImport) {
      res.json({ available: false, rows: [], totals: ZERO_TOTALS, unknownCauses: [] });
      return;
    }

    // 2. Run all data queries in parallel.
    // Per-activity balance for HG, RFI, NH, B, HAB, W, Q, TS (one query, grouped by activity).
    const fabMidFilter = or(
      ...FAB_MID_ACTS.map((a) => eq(sql`upper(${recordPoolTable.activity})`, a)),
    );

    const [
      tltStructures,
      cuttingAgg,
      fabMidAgg,
      releaseByBatch,
      assignmentByBatch,
      orderReview,
    ] = await Promise.all([
      // TLT (project, structure, mfcBatch) triplets for the latest import.
      // Group by mfc_batch directly — no MAX — so each mark's weight stays
      // in the batch it carries.  One row per (project, structure, mfcBatch).
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          towerSubType:
            sql<string | null>`max(${recordPoolTable.towerSubType})`,
          mfcBatch: recordPoolTable.mfcBatch,
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
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          recordPoolTable.mfcBatch,
        ),

      // Cutting balance = "Job Card Not Started" + "Authorized" + non-blank contractor.
      // The contractor condition is what differentiates Cutting from Awaiting Assignment:
      //   Cutting            = JCNS + Authorized + contractor NOT blank  (work actively being cut)
      //   Awaiting Assignment = JCNS + Authorized + contractor blank     (released, not yet assigned)
      // Primary: job_card_type = 'Job Card Not Started' AND job_card_status = 'Authorized'
      //   (new-format files that store Col A; TLT and NTLT alike).
      // Fallback: upper(activity) = 'C' AND is_initial_cutting IS NOT TRUE
      //   (old-format files without job_card_type; correct for TLT by rule T1;
      //    no old NTLT files have this gap).
      // is_initial_cutting IS NOT TRUE in both branches to exclude NOT_RELEASED rows.
      // Using IS NOT TRUE (not = false) so any NULL flag doesn't incorrectly include
      // Initial marks during the window before the boot backfill completes.
      // Grouped by (project, structure, mfcBatch) for per-mark batch attribution.
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          mfcBatch: recordPoolTable.mfcBatch,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
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
            // Exclude Initial marks — use per-import status when available.
            sql`NOT COALESCE(upper(${importRowsTable.jobCardStatus}) = 'INITIAL', ${recordPoolTable.isInitialCutting}, false)`,
            // Contractor must be non-blank — blank contractor = Awaiting Assignment, not Cutting.
            sql`(${recordPoolTable.contractor} IS NOT NULL AND trim(${recordPoolTable.contractor}) != '')`,
            sql`(
              (COALESCE(${importRowsTable.jobCardType}, ${recordPoolTable.jobCardType}) = 'Job Card Not Started'
               AND COALESCE(${importRowsTable.jobCardStatus}, ${recordPoolTable.jobCardStatus}) = 'AUTHORIZED')
              OR
              (COALESCE(${importRowsTable.jobCardType}, ${recordPoolTable.jobCardType}) IS NULL
               AND upper(${recordPoolTable.activity}) = 'C')
            )`,
          ),
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          recordPoolTable.mfcBatch,
        ),

      // Per-activity balance for HG, RFI, NH, B, HAB, W, Q, TS — one row per
      // (project, structure, mfcBatch, activity). Split into individual maps after.
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          mfcBatch: recordPoolTable.mfcBatch,
          activity: sql<string>`upper(${recordPoolTable.activity})`,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
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
            fabMidFilter,
          ),
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          recordPoolTable.mfcBatch,
          sql`upper(${recordPoolTable.activity})`,
        ),

      // Release balance (JCNS + Initial rows) — computed inline from the pool,
      // grouped by (project, structure, mfcBatch) for per-mark batch attribution.
      // is_initial_cutting = true correctly identifies Initial marks (set during
      // parse from job_card_status = 'INITIAL').
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          mfcBatch: recordPoolTable.mfcBatch,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
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
            // Use per-import status when available; fall back to pool flag.
            sql`COALESCE(upper(${importRowsTable.jobCardStatus}) = 'INITIAL', ${recordPoolTable.isInitialCutting}, false)`,
          ),
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          recordPoolTable.mfcBatch,
        ),

      // Assignment balance (JCNS + Authorized + blank contractor) — computed inline,
      // grouped by (project, structure, mfcBatch).
      // Per-import job_card_status = 'AUTHORIZED' already excludes Initial marks.
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          mfcBatch: recordPoolTable.mfcBatch,
          balanceMt:
            sql<number>`coalesce(sum(${recordPoolTable.balanceWt} * ${importRowsTable.copies}) / 1000.0, 0)`,
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
            sql`COALESCE(${importRowsTable.jobCardType}, ${recordPoolTable.jobCardType}) = 'Job Card Not Started'`,
            sql`COALESCE(${importRowsTable.jobCardStatus}, ${recordPoolTable.jobCardStatus}) = 'AUTHORIZED'`,
            sql`(${recordPoolTable.contractor} IS NULL OR trim(${recordPoolTable.contractor}) = '')`,
          ),
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          recordPoolTable.mfcBatch,
        ),

      // Order Review for BOM labels.
      loadLatestOrderReview(),
    ]);

    // 3. Build lookup maps keyed by batchKey(project, structure, mfcBatch).
    //    Each measure is now per (project, structure, mfcBatch) so a structure whose
    //    marks span two batches gets two independent entries.
    const releaseMap = new Map<string, number>(
      releaseByBatch.map((r) => [
        batchKey(r.project, r.structure, r.mfcBatch),
        r.balanceMt,
      ]),
    );
    const assignmentMap = new Map<string, number>(
      assignmentByBatch.map((r) => [
        batchKey(r.project, r.structure, r.mfcBatch),
        r.balanceMt,
      ]),
    );
    const cuttingMap = new Map<string, number>(
      cuttingAgg.map((r) => [
        batchKey(r.project, r.structure, r.mfcBatch),
        r.balanceMt,
      ]),
    );
    // Per-activity maps for HG, RFI, NH, B, HAB, W, Q, TS.
    const actMaps = new Map<FabMidAct, Map<string, number>>(
      FAB_MID_ACTS.map((a) => [a, new Map<string, number>()]),
    );
    for (const r of fabMidAgg) {
      const act = r.activity as FabMidAct;
      if (actMaps.has(act)) {
        actMaps.get(act)!.set(batchKey(r.project, r.structure, r.mfcBatch), r.balanceMt);
      }
    }
    const actMap = (a: FabMidAct, bkey: string) => actMaps.get(a)?.get(bkey) ?? 0;

    // 4. Build BOM label map from Order Review rows.
    // For each (project, structure), collect the set of distinct non-null bomType
    // values. Exactly one → that label; 0 → "No BOM match"; 2+ → "Mixed".
    const bomDistinct = new Map<string, Set<string>>();
    // Also build per-project OR structure list for cause classification.
    const orByProject = new Map<string, string[]>();
    if (orderReview) {
      for (const r of orderReview.rows) {
        const k = structureKey(r.project, r.structure);
        if (!bomDistinct.has(k)) bomDistinct.set(k, new Set());
        if (r.bomType) bomDistinct.get(k)!.add(r.bomType);

        const list = orByProject.get(r.project) ?? [];
        list.push(r.structure);
        orByProject.set(r.project, list);
      }
    }

    function getBomLabel(project: string, structure: string): string {
      const types = bomDistinct.get(structureKey(project, structure));
      if (!types || types.size === 0) return "No BOM match";
      if (types.size === 1) return [...types][0]!;
      return "Mixed";
    }

    // 5. Group by (project × bomLabel × subTypeGroup × mfcBatch), summing all measures.
    // Also track No-BOM-match structures per project for cause classification.
    const grouped = new Map<
      string,
      {
        project: string;
        mfcBatch: string | null;
        bomLabel: string;
        subTypeGroup: string;
        releaseBalanceCalcMt: number;
        assignmentBalanceCalcMt: number;
        cuttingBalanceMt: number;
        hgBalanceMt: number;
        rfiBalanceMt: number;
        nhBalanceMt: number;
        bBalanceMt: number;
        habBalanceMt: number;
        wBalanceMt: number;
        qBalanceMt: number;  // Q only
        tsBalanceMt: number; // TS only (shown separately, excluded from total)
      }
    >();
    // unknownByProject: project → deduplicated list of WIP structure codes with no OR match
    const unknownByProject = new Map<string, Set<string>>();

    for (const { project, structure, towerSubType, mfcBatch } of tltStructures) {
      const bomLabel = getBomLabel(project, structure);
      const subTypeGroup = classifySubType(towerSubType);
      const gKey = `${project}\u0001${bomLabel}\u0001${subTypeGroup}\u0001${mfcBatch ?? ""}`;

      const bkey = batchKey(project, structure, mfcBatch);
      const relMt    = releaseMap.get(bkey) ?? 0;
      const assignMt = assignmentMap.get(bkey) ?? 0;
      const cutMt    = cuttingMap.get(bkey) ?? 0;
      const hgMt     = actMap("HG",  bkey);
      const rfiMt    = actMap("RFI", bkey);
      const nhMt     = actMap("NH",  bkey);
      const bMt      = actMap("B",   bkey);
      const habMt    = actMap("HAB", bkey);
      const wMt      = actMap("W",   bkey);
      const qMt      = actMap("Q",  bkey); // Quality Check = Q only
      const tsMt     = actMap("TS", bkey); // Test/Sign-off = TS only (shown separately, NOT in total)

      const existing = grouped.get(gKey);
      if (!existing) {
        grouped.set(gKey, {
          project, mfcBatch: mfcBatch ?? null, bomLabel, subTypeGroup,
          releaseBalanceCalcMt: relMt,
          assignmentBalanceCalcMt: assignMt,
          cuttingBalanceMt: cutMt,
          hgBalanceMt: hgMt,
          rfiBalanceMt: rfiMt,
          nhBalanceMt: nhMt,
          bBalanceMt: bMt,
          habBalanceMt: habMt,
          wBalanceMt: wMt,
          qBalanceMt: qMt,
          tsBalanceMt: tsMt,
        });
      } else {
        existing.releaseBalanceCalcMt += relMt;
        existing.assignmentBalanceCalcMt += assignMt;
        existing.cuttingBalanceMt += cutMt;
        existing.hgBalanceMt += hgMt;
        existing.rfiBalanceMt += rfiMt;
        existing.nhBalanceMt += nhMt;
        existing.bBalanceMt += bMt;
        existing.habBalanceMt += habMt;
        existing.wBalanceMt += wMt;
        existing.qBalanceMt += qMt;
        existing.tsBalanceMt += tsMt;
      }

      if (bomLabel === "No BOM match") {
        const set = unknownByProject.get(project) ?? new Set<string>();
        set.add(structure);
        unknownByProject.set(project, set);
      }
    }

    // 6. Sort: BOM label canonical → sub-type canonical → project ascending.
    const rows = [...grouped.values()].sort((a, b) => {
      const bc = bomSortIndex(a.bomLabel) - bomSortIndex(b.bomLabel);
      if (bc !== 0) return bc;
      const sc = subTypeSortIndex(a.subTypeGroup) - subTypeSortIndex(b.subTypeGroup);
      if (sc !== 0) return sc;
      return a.project.localeCompare(b.project);
    });

    // 7. Compute grand totals.
    const totals = rows.reduce(
      (acc, r) => ({
        releaseBalanceCalcMt:   acc.releaseBalanceCalcMt   + r.releaseBalanceCalcMt,
        assignmentBalanceCalcMt:acc.assignmentBalanceCalcMt+ r.assignmentBalanceCalcMt,
        cuttingBalanceMt:       acc.cuttingBalanceMt       + r.cuttingBalanceMt,
        hgBalanceMt:            acc.hgBalanceMt            + r.hgBalanceMt,
        rfiBalanceMt:           acc.rfiBalanceMt           + r.rfiBalanceMt,
        nhBalanceMt:            acc.nhBalanceMt            + r.nhBalanceMt,
        bBalanceMt:             acc.bBalanceMt             + r.bBalanceMt,
        habBalanceMt:           acc.habBalanceMt           + r.habBalanceMt,
        wBalanceMt:             acc.wBalanceMt             + r.wBalanceMt,
        qBalanceMt:             acc.qBalanceMt             + r.qBalanceMt,
        tsBalanceMt:            acc.tsBalanceMt            + r.tsBalanceMt,
      }),
      ZERO_TOTALS,
    );

    // 8. Build unknownCauses: for each project with No-BOM-match structures, classify
    //    each structure as "mismatch" or "absent" using affix rules.
    const unknownCauses = [...unknownByProject.entries()].map(
      ([project, structureSet]) => ({
        project,
        structures: [...structureSet].sort().map((wip) => {
          const orStructures = orByProject.get(project) ?? [];
          const { cause, candidates, ambiguous } = classifyCause(wip, orStructures);
          return { wip, cause, candidates, ambiguous };
        }),
      }),
    );

    res.json({ available: true, rows, totals, unknownCauses });
  },
);

export default router;
