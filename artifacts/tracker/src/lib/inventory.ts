import { useMemo } from "react";
import {
  useGetInventoryBuckets,
  getGetInventoryBucketsQueryKey,
  useListInventoryManualA,
  useListInventoryManualE,
  type InventoryBucketRow,
  type InventoryManualEntry,
} from "@workspace/api-client-react";
import { normalizeContractorName } from "@workspace/domain";
import { useContractorCategoryMap, contractorCategoryFor, type ContractorCategoryInfo } from "@/lib/store";

export type InventorySide = "in_house" | "out_vendor";

// Hardcoded name overrides (spec-mandated), applied BEFORE the
// contractor_categories lookup. Matched on the same normalized key used
// everywhere else (uppercase, collapsed whitespace) so casing/spacing never
// causes a miss. These never mutate contractor_categories or any stored
// contractor string — display/classification only, same as the category
// overlay itself.
const HARDCODED_IN_HOUSE = ["UNIT-I", "UNIT-II", "DUMMY CONTRACTOR", "NO CONTRACTOR"].map(
  normalizeContractorName,
);
const HARDCODED_OUT_VENDOR = [
  "DASHMESH ENTERPRISES GP-2",
  "OUT FAB",
  "S .R . BROTHERS & CO.",
].map(normalizeContractorName);

// Resolve a single contractor name to an Inventory side. Order: hardcoded
// override -> contractor_categories (CNC/SUB_CONTRACTOR = in-house, OUT_VENDOR
// = out-vendor) -> default in-house (unmatched/UNCLASSIFIED).
export function resolveContractorSide(
  contractor: string,
  map: Map<string, ContractorCategoryInfo>,
): InventorySide {
  const key = normalizeContractorName(contractor);
  if (HARDCODED_IN_HOUSE.includes(key)) return "in_house";
  if (HARDCODED_OUT_VENDOR.includes(key)) return "out_vendor";
  const info = contractorCategoryFor(contractor, map);
  if (info.category === "OUT_VENDOR") return "out_vendor";
  return "in_house";
}

export interface StructureSides {
  sides: Set<InventorySide>;
  mixed: boolean;
}

// A structure can be touched by more than one contractor across its marks; if
// those contractors resolve to both sides, the structure is "mixed".
export function classifyStructureSides(
  contractors: string[],
  map: Map<string, ContractorCategoryInfo>,
): StructureSides {
  const sides = new Set<InventorySide>();
  for (const c of contractors) {
    if (!c) continue;
    sides.add(resolveContractorSide(c, map));
  }
  if (sides.size === 0) sides.add("in_house");
  return { sides, mixed: sides.size > 1 };
}

// Compute the in-house weight ratio r_in from the per-contractor balance
// weights sent by the server (wipWeightByContractor). Uses resolveContractorSide
// to classify each contractor key, then sums their weights:
//   r_in = inWt / (inWt + outWt)
// Defaults to 1.0 (fully in-house) when there are no marks with weight > 0.
// Blank contractor (empty-string key) defaults to in-house per spec.
function computeSideRatio(
  wipWeightByContractor: Record<string, number>,
  map: Map<string, ContractorCategoryInfo>,
): number {
  let inWt = 0;
  let outWt = 0;
  for (const [contractor, wt] of Object.entries(wipWeightByContractor)) {
    if (wt <= 0) continue;
    const side = resolveContractorSide(contractor, map);
    if (side === "in_house") inWt += wt;
    else outWt += wt;
  }
  const total = inWt + outWt;
  if (total <= 0) return 1.0;
  return inWt / total;
}

export interface InventoryStructureCard {
  project: string;
  structure: string | null;
  subType: string | null;
  weightMt: number | null;
  woOrderQtyMt: number | null;
  fileBalReleaseMt: number | null;
  inspectionMt: number | null;
  galvMt: number | null;
  balFabMt: number | null;
  balGalvMt: number | null;
  contractors: string[];
  notInLatest: boolean;
  mixed: boolean;
  /** MFC Batch letter (A/B/C/D) or "Z" (= not yet batched). Never null. */
  mfcBatch: string;
}

// Release Balance display value (Col S). Bucket B shows the raw value (always
// > 0 there); C/D/E clamp to max(0, value) so a negative balance never shows.
// The clamp is DISPLAY-ONLY — it never affects B/C bucket membership, which
// always uses the true numeric fileBalReleaseMt. Null stays null (renders "-"),
// it is never coerced to 0.
export function releaseBalanceDisplay(
  fileBalReleaseMt: number | null,
  clamp: boolean,
): number | null {
  if (fileBalReleaseMt == null) return null;
  return clamp ? Math.max(0, fileBalReleaseMt) : fileBalReleaseMt;
}

// Fab + Galva (Col T + Col U). Both null -> null (renders "-"); one null is
// treated as 0 for the sum (per spec: "a null cell contributes 0 to a sum").
export function fabPlusGalva(
  balFabMt: number | null,
  balGalvMt: number | null,
): number | null {
  if (balFabMt == null && balGalvMt == null) return null;
  return (balFabMt ?? 0) + (balGalvMt ?? 0);
}

// Sum a column across structure cards for a project rollup. Null cells
// contribute 0 to the sum (rollups are never "-" unless every contributing
// value was null, which callers can detect separately if needed).
export function sumColumn(
  rows: InventoryStructureCard[],
  pick: (r: InventoryStructureCard) => number | null,
): number {
  return rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
}

// Same null semantics as the structure level: a rollup renders "-" only when
// EVERY contributing row is null for that column; otherwise nulls contribute 0.
export function sumColumnOrNull(
  rows: InventoryStructureCard[],
  pick: (r: InventoryStructureCard) => number | null,
): number | null {
  if (rows.length === 0 || rows.every((r) => pick(r) == null)) return null;
  return sumColumn(rows, pick);
}

export interface BucketSides {
  inHouse: InventoryStructureCard[];
  outVendor: InventoryStructureCard[];
}

export interface InventoryBuckets {
  b: BucketSides;
  c: BucketSides;
  d: BucketSides;
  excludedNullReleaseCount: number;
  excludedNullInspectionCount: number;
  /** Structures excluded because they have no WIP marks (production complete). */
  excludedCompletedCount: number;
  /** Structures removed from C because a matching Bucket E entry (project+mfcBatch) exists. */
  eRemovedFromCCount: number;
  /** Structures removed from D because a matching Bucket E entry (project+mfcBatch) exists. */
  eRemovedFromDCount: number;
}

// Compute Buckets B/C/D using the hybrid in-house / out-vendor split.
//
// SPLIT RULE (per spec):
//   1. For each structure, compute r_in = inWt / (inWt + outWt) from its WIP
//      marks' Balance Wt, where inWt/outWt are summed by side classification.
//      Default r_in = 1.0 when no marks have positive weight.
//   2. Release Balance (Col S): 100% in-house. out-vendor gets 0 (not null
//      when raw is non-null, so the column is numeric not "-").
//   3. Fab (Col T), Galva (Col U), Yard (Col N): split by r_in.
//        in-house  = value * r_in
//        out-vendor = value * (1 − r_in)
//
// Each structure produces:
//   - always an in-house card (carries Release Balance + r_in fraction)
//   - an out-vendor card only when r_out > 0 (carries 0 Release Balance +
//     r_out fraction of Fab/Galva/Yard)
//
// This guarantees In-House + Out-Vendor == raw Order-Review value for every
// column, so the two side totals never overlap.
//
// eExcludeKeys: `${project}\u0001${mfcBatch}` keys from active Bucket E entries.
// When a row matches a key: it is REMOVED from C and D (NOT from B).
export function computeAutoBuckets(
  rows: InventoryBucketRow[],
  map: Map<string, ContractorCategoryInfo>,
  eExcludeKeys?: Set<string>,
): InventoryBuckets {
  const bInHouse: InventoryStructureCard[] = [];
  const bOutVendor: InventoryStructureCard[] = [];
  const cInHouse: InventoryStructureCard[] = [];
  const cOutVendor: InventoryStructureCard[] = [];
  const dInHouse: InventoryStructureCard[] = [];
  const dOutVendor: InventoryStructureCard[] = [];
  let excludedNullReleaseCount = 0;
  let excludedNullInspectionCount = 0;
  let excludedCompletedCount = 0;
  let eRemovedFromCCount = 0;
  let eRemovedFromDCount = 0;

  for (const row of rows) {
    // Exclude structures with no WIP marks — production is complete.
    if (!row.hasWipMarks) {
      excludedCompletedCount++;
      continue;
    }
    // Check if an E entry covers this (project, mfcBatch) — suppresses C & D.
    const eKey = `${row.project}\u0001${row.mfcBatch}`;
    const suppressedByE = eExcludeKeys?.has(eKey) ?? false;

    // Compute the in-house weight ratio from this structure's WIP marks.
    const r_in = computeSideRatio(row.wipWeightByContractor, map);
    const r_out = 1 - r_in;
    const mixed = r_in > 0 && r_out > 0;

    // Fields that are the same for both sides (not subject to the split).
    const base = {
      project: row.project,
      structure: row.structure,
      subType: row.subType,
      weightMt: row.weightMt,
      woOrderQtyMt: row.woOrderQtyMt,
      inspectionMt: row.inspectionMt,
      contractors: row.contractors,
      notInLatest: row.notInLatest,
      mixed,
      mfcBatch: row.mfcBatch,
    };

    // In-house card: Release Balance always goes fully to in-house; Fab/Galva/
    // Yard are scaled by r_in. Null raw values stay null (never coerced to 0).
    const inCard: InventoryStructureCard = {
      ...base,
      fileBalReleaseMt: row.fileBalReleaseMt,
      balFabMt: row.balFabMt != null ? row.balFabMt * r_in : null,
      balGalvMt: row.balGalvMt != null ? row.balGalvMt * r_in : null,
      galvMt: row.galvMt != null ? row.galvMt * r_in : null,
    };

    // Out-vendor card: Release Balance is always 0 per spec (shown as 0 not
    // null when raw is non-null, so the column stays numeric). Fab/Galva/Yard
    // carry the remaining (1 − r_in) fraction. Only created when r_out > 0.
    const outCard: InventoryStructureCard | null = r_out > 0 ? {
      ...base,
      fileBalReleaseMt: row.fileBalReleaseMt != null ? 0 : null,
      balFabMt: row.balFabMt != null ? row.balFabMt * r_out : null,
      balGalvMt: row.balGalvMt != null ? row.balGalvMt * r_out : null,
      galvMt: row.galvMt != null ? row.galvMt * r_out : null,
    } : null;

    // Bucket B: Release Balance > 0 (never suppressed by E).
    if (row.fileBalReleaseMt == null) {
      excludedNullReleaseCount++;
    } else if (row.fileBalReleaseMt > 0) {
      bInHouse.push(inCard);
      if (outCard) bOutVendor.push(outCard);
    } else {
      // fileBalReleaseMt <= 0 → eligible for C
      if (suppressedByE) {
        eRemovedFromCCount++;
      } else {
        cInHouse.push(inCard);
        if (outCard) cOutVendor.push(outCard);
      }
    }

    // Bucket D is independent of B/C membership — check inspectionMt separately.
    if (row.inspectionMt == null) {
      excludedNullInspectionCount++;
    } else if (row.inspectionMt > 0) {
      if (suppressedByE) {
        eRemovedFromDCount++;
      } else {
        dInHouse.push(inCard);
        if (outCard) dOutVendor.push(outCard);
      }
    }
  }

  return {
    b: { inHouse: bInHouse, outVendor: bOutVendor },
    c: { inHouse: cInHouse, outVendor: cOutVendor },
    d: { inHouse: dInHouse, outVendor: dOutVendor },
    excludedNullReleaseCount,
    excludedNullInspectionCount,
    excludedCompletedCount,
    eRemovedFromCCount,
    eRemovedFromDCount,
  };
}

export interface ProjectAggregate {
  releaseBalanceMt: number | null;
  fabGalvaMt: number | null;
  yardMt: number | null;
  structureCount: number;
}

// Bucket E aggregation: sum the clamped Release Balance / Fab+Galva / Yard
// data columns across the structures in the latest Order Review that belong
// to the given project (and, when mfcBatch is supplied, to that MFC Batch
// only). Not side-filtered — E aggregates regardless of which contractors
// touch a structure. Null-only columns render as null ("-"); otherwise nulls
// contribute 0 per-structure.
export function aggregateProjectColumns(
  rows: InventoryBucketRow[],
  project: string,
  mfcBatch?: string,
): ProjectAggregate {
  const projectRows = rows.filter(
    (r) => r.project === project && (mfcBatch == null || r.mfcBatch === mfcBatch),
  );
  if (projectRows.length === 0) {
    return { releaseBalanceMt: null, fabGalvaMt: null, yardMt: null, structureCount: 0 };
  }
  const allReleaseNull = projectRows.every((r) => r.fileBalReleaseMt == null);
  const allFabGalvaNull = projectRows.every(
    (r) => r.balFabMt == null && r.balGalvMt == null,
  );
  const allYardNull = projectRows.every((r) => r.galvMt == null);
  return {
    releaseBalanceMt: allReleaseNull
      ? null
      : projectRows.reduce(
          (s, r) => s + (releaseBalanceDisplay(r.fileBalReleaseMt, true) ?? 0),
          0,
        ),
    fabGalvaMt: allFabGalvaNull
      ? null
      : projectRows.reduce((s, r) => s + (fabPlusGalva(r.balFabMt, r.balGalvMt) ?? 0), 0),
    yardMt: allYardNull ? null : projectRows.reduce((s, r) => s + (r.galvMt ?? 0), 0),
    structureCount: projectRows.length,
  };
}

export interface BucketSummary {
  releaseBalanceMt: number;
  underProductionMt: number;
  yardMt: number;
  operationWeightMt: number;
  grandTotalMt: number;
}

// Per-bucket footer summary (spec-mandated 5 lines). `clampRelease` is false
// only for Bucket B (raw Col S, always > 0 there); true for C/D/E, whose
// Total Release Balance is therefore always 0 (clamped max(0, S) summed).
// Under Production = Sum(Fab + Galva); Total Yard = Sum(Col N); Operation
// Weight = Under Production + Total Yard; Grand Total = Total Release
// Balance + Operation Weight. Nulls contribute 0 (same as sumColumn).
export function computeBucketSummary(
  rows: InventoryStructureCard[],
  clampRelease: boolean,
): BucketSummary {
  const releaseBalanceMt = sumColumn(rows, (r) =>
    releaseBalanceDisplay(r.fileBalReleaseMt, clampRelease),
  );
  const underProductionMt = sumColumn(rows, (r) => fabPlusGalva(r.balFabMt, r.balGalvMt));
  const yardMt = sumColumn(rows, (r) => r.galvMt);
  const operationWeightMt = underProductionMt + yardMt;
  const grandTotalMt = releaseBalanceMt + operationWeightMt;
  return { releaseBalanceMt, underProductionMt, yardMt, operationWeightMt, grandTotalMt };
}

// Bucket E's summary sums the same five lines, but over the manually-added
// projects' AGGREGATED Order Review values (aggregateProjectColumns already
// applies the Release Balance clamp), not raw per-structure rows.
export function computeManualESummary(aggregates: ProjectAggregate[]): BucketSummary {
  const releaseBalanceMt = aggregates.reduce((s, a) => s + (a.releaseBalanceMt ?? 0), 0);
  const underProductionMt = aggregates.reduce((s, a) => s + (a.fabGalvaMt ?? 0), 0);
  const yardMt = aggregates.reduce((s, a) => s + (a.yardMt ?? 0), 0);
  const operationWeightMt = underProductionMt + yardMt;
  const grandTotalMt = releaseBalanceMt + operationWeightMt;
  return { releaseBalanceMt, underProductionMt, yardMt, operationWeightMt, grandTotalMt };
}

export interface InventoryPageData {
  available: boolean;
  asOnDate: string | null;
  isLoading: boolean;
  rawRows: InventoryBucketRow[];
  buckets: InventoryBuckets;
  manualA: InventoryManualEntry[];
  manualE: InventoryManualEntry[];
  /**
   * Per-project MFC batch options derived from the latest WIP import.
   * Only batches that actually appear in a project's WIP structures are
   * included. Sorted A/B/C/D first, then Z (= not yet batched).
   */
  projectMfcBatches: Map<string, string[]>;
}

// Shared read hook for the Inventory page: raw joined rows + the two manual
// lists, with buckets derived client-side so classification always matches
// the live contractor_categories overlay.
export function useInventoryData(): InventoryPageData {
  const { data: bucketsData, isLoading: bucketsLoading } = useGetInventoryBuckets({
    query: { queryKey: getGetInventoryBucketsQueryKey() },
  });
  const { data: manualA, isLoading: aLoading } = useListInventoryManualA();
  const { data: manualE, isLoading: eLoading } = useListInventoryManualE();
  const contractorMap = useContractorCategoryMap();

  const rawRows = bucketsData?.rows ?? [];

  // Build per-project MFC batch options from the current WIP snapshot.
  // Completed structures (no WIP marks) are excluded — they can't be "ready
  // but not dispatched". Batches are sorted A/B/C/D before Z.
  const projectMfcBatches = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of rawRows) {
      if (!r.hasWipMarks) continue;
      if (!map.has(r.project)) map.set(r.project, []);
      const batches = map.get(r.project)!;
      if (!batches.includes(r.mfcBatch)) batches.push(r.mfcBatch);
    }
    for (const [, batches] of map) {
      batches.sort((a, b) => {
        if (a === "Z") return 1;
        if (b === "Z") return -1;
        return a.localeCompare(b);
      });
    }
    return map;
  }, [rawRows]);

  // Build the exclusion key set from active E entries so computeAutoBuckets
  // can suppress matching structures from C and D (never from B).
  const eExcludeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const e of (manualE ?? [])) {
      const batch = e.mfcBatch ?? "Z";
      set.add(`${e.projectCode}\u0001${batch}`);
    }
    return set;
  }, [manualE]);

  const buckets = useMemo(
    () => computeAutoBuckets(rawRows, contractorMap, eExcludeKeys),
    [rawRows, contractorMap, eExcludeKeys],
  );

  return {
    available: bucketsData?.available ?? false,
    asOnDate: bucketsData?.asOnDate ?? null,
    isLoading: bucketsLoading || aLoading || eLoading,
    rawRows,
    buckets,
    manualA: manualA ?? [],
    manualE: manualE ?? [],
    projectMfcBatches,
  };
}

export const BUCKET_LABELS: Record<"a" | "b" | "c" | "d" | "e", string> = {
  a: "Project to Start",
  b: "Raw Material Incomplete",
  c: "RM Complete \u2013 Material Under Production",
  d: "Dispatch Clearance Recd But Production Not Complete",
  e: "Material Ready But Not Dispatched",
};
