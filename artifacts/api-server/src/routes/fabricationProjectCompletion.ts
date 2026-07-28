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

// Individual fab activities tracked between Cutting and Quality Check.
// Order mirrors the TLT process sequence: C → HG → RFI → NH → B → HAB → W → Q → TS
// Quality Check = Q + TS only (the final quality/test step).
const FAB_MID_ACTS = ["HG", "RFI", "NH", "B", "HAB", "W", "Q", "TS"] as const;
type FabMidAct = (typeof FAB_MID_ACTS)[number];

// BOM label canonical display order for sorting.
const BOM_ORDER = ["Proto", "Mass", "Pre", "Mixed", "Unknown"];

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
      hgBalanceMt: 0,
      rfiBalanceMt: 0,
      nhBalanceMt: 0,
      bBalanceMt: 0,
      habBalanceMt: 0,
      wBalanceMt: 0,
      qualityCheckBalanceMt: 0, // Q + TS only
    };

    // 1. Find the latest WIP import.
    const [latestImport] = await db
      .select({ id: importsTable.id })
      .from(importsTable)
      .orderBy(desc(importsTable.id))
      .limit(1);

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
      releaseRows,
      assignmentRows,
      orderReview,
    ] = await Promise.all([
      // TLT (project, structure) pairs + dominant tower sub type for the latest import.
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          towerSubType:
            sql<string | null>`max(${recordPoolTable.towerSubType})`,
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
        .groupBy(recordPoolTable.job, recordPoolTable.structure),

      // Cutting balance (activity = C, excluding Initial marks).
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
            eq(recordPoolTable.isInitialCutting, false),
          ),
        )
        .groupBy(recordPoolTable.job, recordPoolTable.structure),

      // Per-activity balance for HG, RFI, NH, B, HAB, W, Q, TS — one row per
      // (project, structure, activity). Split into individual maps after.
      db
        .select({
          project: recordPoolTable.job,
          structure: recordPoolTable.structure,
          activity: sql<string>`upper(${recordPoolTable.activity})`,
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
            fabMidFilter,
          ),
        )
        .groupBy(
          recordPoolTable.job,
          recordPoolTable.structure,
          sql`upper(${recordPoolTable.activity})`,
        ),

      // Release balance (JCNS + Initial) — scoped to this import.
      db
        .select()
        .from(releaseBalanceWipTable)
        .where(eq(releaseBalanceWipTable.importId, latestImport.id)),

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
    // Per-activity maps for HG, RFI, NH, B, HAB, W, Q, TS.
    const actMaps = new Map<FabMidAct, Map<string, number>>(
      FAB_MID_ACTS.map((a) => [a, new Map<string, number>()]),
    );
    for (const r of fabMidAgg) {
      const act = r.activity as FabMidAct;
      if (actMaps.has(act)) {
        actMaps.get(act)!.set(structureKey(r.project, r.structure), r.balanceMt);
      }
    }
    const actMap = (a: FabMidAct, key: string) => actMaps.get(a)?.get(key) ?? 0;

    // 4. Build BOM label map from Order Review rows.
    // For each (project, structure), collect the set of distinct non-null bomType
    // values. Exactly one → that label; 0 → "Unknown"; 2+ → "Mixed".
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
      if (!types || types.size === 0) return "Unknown";
      if (types.size === 1) return [...types][0]!;
      return "Mixed";
    }

    // 5. Group by (bomLabel, subTypeGroup, project), summing all measures.
    // Also track Unknown structures per project for cause classification.
    const grouped = new Map<
      string,
      {
        project: string;
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
        qualityCheckBalanceMt: number; // Q + TS only
      }
    >();
    // unknownByProject: project → deduplicated list of WIP structure codes with no OR match
    const unknownByProject = new Map<string, Set<string>>();

    for (const { project, structure, towerSubType } of tltStructures) {
      const bomLabel = getBomLabel(project, structure);
      const subTypeGroup = classifySubType(towerSubType);
      const gKey = `${project}\u0001${bomLabel}\u0001${subTypeGroup}`;

      const key = structureKey(project, structure);
      const relMt    = releaseMap.get(key) ?? 0;
      const assignMt = assignmentMap.get(key) ?? 0;
      const cutMt    = cuttingMap.get(key) ?? 0;
      const hgMt     = actMap("HG",  key);
      const rfiMt    = actMap("RFI", key);
      const nhMt     = actMap("NH",  key);
      const bMt      = actMap("B",   key);
      const habMt    = actMap("HAB", key);
      const wMt      = actMap("W",   key);
      const qcMt     = actMap("Q",   key) + actMap("TS", key); // Quality Check = Q + TS

      const existing = grouped.get(gKey);
      if (!existing) {
        grouped.set(gKey, {
          project, bomLabel, subTypeGroup,
          releaseBalanceCalcMt: relMt,
          assignmentBalanceCalcMt: assignMt,
          cuttingBalanceMt: cutMt,
          hgBalanceMt: hgMt,
          rfiBalanceMt: rfiMt,
          nhBalanceMt: nhMt,
          bBalanceMt: bMt,
          habBalanceMt: habMt,
          wBalanceMt: wMt,
          qualityCheckBalanceMt: qcMt,
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
        existing.qualityCheckBalanceMt += qcMt;
      }

      if (bomLabel === "Unknown") {
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
        qualityCheckBalanceMt:  acc.qualityCheckBalanceMt  + r.qualityCheckBalanceMt,
      }),
      ZERO_TOTALS,
    );

    // 8. Build unknownCauses: for each project with Unknown structures, classify
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
