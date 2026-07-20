import { useMemo } from "react";
import {
  useGetInventoryBuckets,
  getGetInventoryBucketsQueryKey,
  useListInventoryManualE,
  type InventoryBucketRow,
  type InventoryManualEntry,
} from "@workspace/api-client-react";

export type InventorySide = "in_house" | "out_vendor";

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
  mfcBatch: string;
}

export function releaseBalanceDisplay(
  fileBalReleaseMt: number | null,
  clamp: boolean,
): number | null {
  if (fileBalReleaseMt == null) return null;
  return clamp ? Math.max(0, fileBalReleaseMt) : fileBalReleaseMt;
}

export function fabPlusGalva(
  balFabMt: number | null,
  balGalvMt: number | null,
): number | null {
  if (balFabMt == null && balGalvMt == null) return null;
  return (balFabMt ?? 0) + (balGalvMt ?? 0);
}

export function sumColumn(
  rows: InventoryStructureCard[],
  pick: (r: InventoryStructureCard) => number | null,
): number {
  return rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
}

export function sumColumnOrNull(
  rows: InventoryStructureCard[],
  pick: (r: InventoryStructureCard) => number | null,
): number | null {
  if (rows.length === 0 || rows.every((r) => pick(r) == null)) return null;
  return sumColumn(rows, pick);
}

export interface InventoryBuckets {
  /** Bucket A: structures with woOrderQtyMt ≈ 0 AND releaseMt ≈ 0 (tolerance 0.001). */
  a: InventoryStructureCard[];
  /** Bucket B: Release Balance > 0 (raw Col S). */
  b: InventoryStructureCard[];
  /** Bucket C: Release Balance <= 0. Suppressed when a matching E entry exists. */
  c: InventoryStructureCard[];
  /** Bucket D: inspectionMt > 0. Suppressed when a matching E entry exists. */
  d: InventoryStructureCard[];
  excludedNullReleaseCount: number;
  excludedNullInspectionCount: number;
  excludedCompletedCount: number;
  eRemovedFromCCount: number;
  eRemovedFromDCount: number;
}

const BUCKET_A_TOLE = 0.001;

// Compute Buckets A/B/C/D (flat — no in-house/out-vendor split).
//
// Bucket A: woOrderQtyMt ≈ 0 AND releaseMt ≈ 0. Structures not yet assigned
//   to a work order; included regardless of hasWipMarks.
// Bucket B: Release Balance (Col S) > 0. Never suppressed by E.
// Bucket C: Release Balance <= 0. Suppressed by matching E entry.
// Bucket D: inspectionMt > 0 (independent of B/C). Suppressed by matching E.
//
// eExcludeKeys: `${project}\u0001${mfcBatch}` from active Bucket E entries.
export function computeAutoBuckets(
  rows: InventoryBucketRow[],
  eExcludeKeys?: Set<string>,
): InventoryBuckets {
  const a: InventoryStructureCard[] = [];
  const b: InventoryStructureCard[] = [];
  const c: InventoryStructureCard[] = [];
  const d: InventoryStructureCard[] = [];
  let excludedNullReleaseCount = 0;
  let excludedNullInspectionCount = 0;
  let excludedCompletedCount = 0;
  let eRemovedFromCCount = 0;
  let eRemovedFromDCount = 0;

  for (const row of rows) {
    const card: InventoryStructureCard = {
      project: row.project,
      structure: row.structure,
      subType: row.subType,
      weightMt: row.weightMt,
      woOrderQtyMt: row.woOrderQtyMt,
      fileBalReleaseMt: row.fileBalReleaseMt,
      inspectionMt: row.inspectionMt,
      galvMt: row.galvMt,
      balFabMt: row.balFabMt,
      balGalvMt: row.balGalvMt,
      mfcBatch: row.mfcBatch,
    };

    // Bucket A: not-yet-started (WO qty ≈ 0 AND release ≈ 0).
    // Included regardless of hasWipMarks — project may have pre-production
    // marks at activity C with no work order assigned yet.
    if (
      Math.abs(row.woOrderQtyMt ?? 0) < BUCKET_A_TOLE &&
      Math.abs(row.releaseMt ?? 0) < BUCKET_A_TOLE
    ) {
      a.push(card);
    }

    // Buckets B/C/D: only structures still in WIP (production not complete).
    if (!row.hasWipMarks) {
      excludedCompletedCount++;
      continue;
    }

    const eKey = `${row.project}\u0001${row.mfcBatch}`;
    const suppressedByE = eExcludeKeys?.has(eKey) ?? false;

    if (row.fileBalReleaseMt == null) {
      excludedNullReleaseCount++;
    } else if (row.fileBalReleaseMt > 0) {
      b.push(card);
    } else {
      if (suppressedByE) {
        eRemovedFromCCount++;
      } else {
        c.push(card);
      }
    }

    if (row.inspectionMt == null) {
      excludedNullInspectionCount++;
    } else if (row.inspectionMt > 0) {
      if (suppressedByE) {
        eRemovedFromDCount++;
      } else {
        d.push(card);
      }
    }
  }

  return {
    a,
    b,
    c,
    d,
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
  manualE: InventoryManualEntry[];
  projectMfcBatches: Map<string, string[]>;
}

export function useInventoryData(): InventoryPageData {
  const { data: bucketsData, isLoading: bucketsLoading } = useGetInventoryBuckets({
    query: { queryKey: getGetInventoryBucketsQueryKey() },
  });
  const { data: manualE, isLoading: eLoading } = useListInventoryManualE();

  const rawRows = bucketsData?.rows ?? [];

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

  const eExcludeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const e of (manualE ?? [])) {
      const batch = e.mfcBatch ?? "Z";
      set.add(`${e.projectCode}\u0001${batch}`);
    }
    return set;
  }, [manualE]);

  const buckets = useMemo(
    () => computeAutoBuckets(rawRows, eExcludeKeys),
    [rawRows, eExcludeKeys],
  );

  return {
    available: bucketsData?.available ?? false,
    asOnDate: bucketsData?.asOnDate ?? null,
    isLoading: bucketsLoading || eLoading,
    rawRows,
    buckets,
    manualE: manualE ?? [],
    projectMfcBatches,
  };
}

export const BUCKET_LABELS: Record<"a" | "preB" | "b" | "c" | "d" | "e", string> = {
  a: "Project to Start",
  preB: "Awaiting Colour Assignment",
  b: "Raw Material Incomplete",
  c: "RM Complete \u2013 Material Under Production",
  d: "Dispatch Clearance Recd But Production Not Complete",
  e: "Material Ready But Not Dispatched",
};
