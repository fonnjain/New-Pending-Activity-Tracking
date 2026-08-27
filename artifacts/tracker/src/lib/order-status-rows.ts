import type { OrderStatusRow, Record as WipRecord } from "@workspace/api-client-react";
import { bundleActivitySet } from "@workspace/domain";
import { isNamedJobSetFilter, type Filters } from "@/lib/store";

const GALV_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();
const KEY_SEP = "\u0001";

function keyOf(project: string, structure: string): string {
  return `${project}${KEY_SEP}${structure}`;
}

interface ComputedBuckets {
  fabMt: number;
  galvMt: number;
}

export interface OrderStatusDisplayRow {
  project: string;
  structure: string;
  subType: string | null;
  bomType: string | null;
  sets: number | null;
  weightMt: number | null;
  woOrderQtyMt: number | null;
  releaseMt: number | null;
  fileDespatchMt: number | null;
  releaseBalanceMt: number | null;
  dispatchBalanceMt: number | null;
  fabMt: number | null;
  galvMt: number | null;
  inFile: boolean;
  inWip: boolean;
  outOfScope: boolean;
  noWipData: boolean;
  notInLatest: boolean;
}

/**
 * Builds the Order Status table and workbook rows from the same WIP snapshot
 * and global filters. Keeping this pure lets the page and Data-tab ZIP export
 * use byte-for-byte equivalent report figures.
 */
export function buildOrderStatusRows({
  records,
  orderRows,
  filters,
  activeJobSet,
  compareProjects,
}: {
  records: WipRecord[];
  orderRows: OrderStatusRow[];
  filters: Filters;
  activeJobSet: ReadonlySet<string>;
  compareProjects: (a: string, b: string) => number;
}): OrderStatusDisplayRow[] {
  const isAll = filters.category === "ALL";
  const scopedRecords = records.filter((r) => {
    if (r.active === false) return false;
    if (!isAll && (r.category || "TLT") !== filters.category) return false;
    if (isNamedJobSetFilter(filters.job)) {
      const comboKey = r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : null;
      if (!activeJobSet.has(r.job ?? "") && !(comboKey && activeJobSet.has(comboKey))) return false;
    } else if (filters.job && r.job !== filters.job) {
      return false;
    }
    if (filters.selectedJobs.length > 0) {
      const comboKey = r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : null;
      if (!filters.selectedJobs.includes(r.job ?? "") && !(comboKey && filters.selectedJobs.includes(comboKey))) return false;
    }
    return !filters.structure || r.structure === filters.structure;
  });

  const computedByKey = new Map<string, ComputedBuckets>();
  const ntltKeys = new Set<string>();
  for (const r of scopedRecords) {
    const key = keyOf(r.job, r.structure);
    if ((r.category || "TLT").toUpperCase() === "NTLT") {
      ntltKeys.add(key);
      continue;
    }
    const aggregate = computedByKey.get(key) ?? { fabMt: 0, galvMt: 0 };
    computedByKey.set(key, aggregate);
    const tonnes = (r.balanceWt || 0) / 1000;
    if (GALV_SET.has((r.activity || "").toUpperCase())) aggregate.galvMt += tonnes;
    else aggregate.fabMt += tonnes;
  }

  const wipKeys = new Set<string>();
  for (const r of records) {
    if (r.active === false) continue;
    if (filters.job && r.job !== filters.job) continue;
    if (filters.structure && r.structure !== filters.structure) continue;
    wipKeys.add(keyOf(r.job, r.structure));
  }

  const fileByKey = new Map<string, OrderStatusRow>();
  for (const row of orderRows) fileByKey.set(keyOf(row.project, row.structure), row);

  const keys = new Set<string>([...fileByKey.keys(), ...computedByKey.keys(), ...ntltKeys]);
  const output: OrderStatusDisplayRow[] = [];
  for (const key of keys) {
    const file = fileByKey.get(key);
    const computed = computedByKey.get(key);
    const [project, structure] = key.split(KEY_SEP);
    if (filters.job && project !== filters.job) continue;
    if (filters.structure && structure !== filters.structure) continue;
    const outOfScope = ntltKeys.has(key) && !computed;
    const inWipReport = wipKeys.has(key);
    const noWipData = !outOfScope && !inWipReport;
    output.push({
      project,
      structure,
      subType: file?.subType ?? null,
      bomType: file?.bomType ?? null,
      sets: file?.sets ?? null,
      weightMt: file?.weightMt ?? null,
      woOrderQtyMt: file?.woOrderQtyMt ?? null,
      releaseMt: file?.releaseMt ?? null,
      fileDespatchMt: file?.fileDespatchMt ?? null,
      releaseBalanceMt: file?.releaseBalanceMt ?? null,
      dispatchBalanceMt: file?.dispatchBalanceMt ?? null,
      fabMt: outOfScope ? null : computed ? computed.fabMt : inWipReport ? 0 : null,
      galvMt: outOfScope ? null : computed ? computed.galvMt : inWipReport ? 0 : null,
      inFile: !!file,
      inWip: !!computed,
      outOfScope,
      noWipData,
      notInLatest: file?.notInLatest ?? false,
    });
  }
  return output.sort((a, b) => compareProjects(a.project, b.project) || a.structure.localeCompare(b.structure));
}