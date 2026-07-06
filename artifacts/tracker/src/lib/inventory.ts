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
// those contractors resolve to both sides, the structure is shown on BOTH
// sides, each badged "(mixed)" — never picked by precedence.
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

export interface InventoryStructureCard {
  project: string;
  structure: string | null;
  subType: string | null;
  weightMt: number | null;
  woOrderQtyMt: number | null;
  fileBalReleaseMt: number | null;
  inspectionMt: number | null;
  contractors: string[];
  notInLatest: boolean;
  mixed: boolean;
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
}

function toCard(
  row: InventoryBucketRow,
  map: Map<string, ContractorCategoryInfo>,
): { card: InventoryStructureCard; sides: StructureSides } {
  const sides = classifyStructureSides(row.contractors, map);
  return {
    card: {
      project: row.project,
      structure: row.structure,
      subType: row.subType,
      weightMt: row.weightMt,
      woOrderQtyMt: row.woOrderQtyMt,
      fileBalReleaseMt: row.fileBalReleaseMt,
      inspectionMt: row.inspectionMt,
      contractors: row.contractors,
      notInLatest: row.notInLatest,
      mixed: sides.mixed,
    },
    sides,
  };
}

// Split a bucket's rows into in-house/out-vendor sides, duplicating a mixed
// structure onto BOTH sides (never picked by precedence).
export function splitBySide(
  rows: { card: InventoryStructureCard; sides: StructureSides }[],
): { inHouse: InventoryStructureCard[]; outVendor: InventoryStructureCard[] } {
  const inHouse: InventoryStructureCard[] = [];
  const outVendor: InventoryStructureCard[] = [];
  for (const { card, sides } of rows) {
    if (sides.sides.has("in_house")) inHouse.push(card);
    if (sides.sides.has("out_vendor")) outVendor.push(card);
  }
  return { inHouse, outVendor };
}

// Compute Buckets B/C/D from the raw joined rows. Membership tests apply
// independently per bucket (a row can land in both B/C is impossible since
// they partition on sign, but D is independent of B/C so overlap with either
// is expected and allowed). Null-driving-field rows are excluded from that
// bucket and counted so the page can flag them.
export function computeAutoBuckets(
  rows: InventoryBucketRow[],
  map: Map<string, ContractorCategoryInfo>,
): InventoryBuckets {
  const b: { card: InventoryStructureCard; sides: StructureSides }[] = [];
  const c: { card: InventoryStructureCard; sides: StructureSides }[] = [];
  const d: { card: InventoryStructureCard; sides: StructureSides }[] = [];
  let excludedNullReleaseCount = 0;
  let excludedNullInspectionCount = 0;

  for (const row of rows) {
    const built = toCard(row, map);
    if (row.fileBalReleaseMt == null) {
      excludedNullReleaseCount++;
    } else if (row.fileBalReleaseMt > 0) {
      b.push(built);
    } else {
      c.push(built);
    }
    if (row.inspectionMt == null) {
      excludedNullInspectionCount++;
    } else if (row.inspectionMt > 0) {
      d.push(built);
    }
  }

  return {
    b: splitBySide(b),
    c: splitBySide(c),
    d: splitBySide(d),
    excludedNullReleaseCount,
    excludedNullInspectionCount,
  };
}

export interface InventoryPageData {
  available: boolean;
  asOnDate: string | null;
  isLoading: boolean;
  rawRows: InventoryBucketRow[];
  buckets: InventoryBuckets;
  manualA: InventoryManualEntry[];
  manualE: InventoryManualEntry[];
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
  const buckets = useMemo(
    () => computeAutoBuckets(rawRows, contractorMap),
    [rawRows, contractorMap],
  );

  return {
    available: bucketsData?.available ?? false,
    asOnDate: bucketsData?.asOnDate ?? null,
    isLoading: bucketsLoading || aLoading || eLoading,
    rawRows,
    buckets,
    manualA: manualA ?? [],
    manualE: manualE ?? [],
  };
}

export const BUCKET_LABELS: Record<"a" | "b" | "c" | "d" | "e", string> = {
  a: "Project to Start",
  b: "In Progress (Balance Pending)",
  c: "Balance Complete / Nil",
  d: "New Inspection Booked",
  e: "Material Ready, Not Dispatched",
};
