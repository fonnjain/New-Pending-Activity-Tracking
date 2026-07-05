import { computeRoute } from "./parse";
import { buildIdentityBridge, identityRawKey, type IdentityRow } from "./identityBridge";

// Minimal view of a pool row needed for diffing.
export interface PoolRowLite {
  hash: string;
  job: string;
  structure: string;
  markTail: string;
  markId: string;
  jobCardNo: string | null;
  contractor: string | null;
  section: string | null;
  assignDate: string | null;
  lastProductionDate: string | null;
  activity: string | null;
  operation: string | null;
  balanceQty: number;
  balanceWt: number;
}

export interface MembershipRow {
  row: PoolRowLite;
  copies: number;
}

export interface ChangeItem {
  markId: string;
  job: string;
  structure: string;
  markTail: string;
  contractor: string | null;
  activityFrom: string | null;
  activityTo: string | null;
  qtyFrom: number | null;
  qtyTo: number | null;
  wtFrom: number | null;
  wtTo: number | null;
}

export interface ChangeSet {
  fromImportId: number | null;
  toImportId: number;
  fromLabel: string | null;
  toLabel: string | null;
  counts: {
    addedRows: number;
    unchangedRows: number;
    movedActivity: number;
    qtyChanged: number;
    newMarks: number;
    completed: number;
  };
  netPendingQtyChange: number;
  netPendingWtChange: number;
  movedActivity: ChangeItem[];
  qtyChanged: ChangeItem[];
  newMarks: ChangeItem[];
  completed: ChangeItem[];
  flags: string[];
}

interface Agg {
  job: string;
  structure: string;
  markTail: string;
  markId: string;
  contractor: string | null;
  qty: number;
  wt: number;
  activities: Set<string>;
  furthestStep: number;
}

function identityKey(r: PoolRowLite): string {
  // markId is the canonical mark key (= mark_number) and already encodes
  // job / suffix / alias / mNo, so it subsumes the old job+structure+markTail.
  return identityRawKey(r.markId, r.jobCardNo);
}

function aggregate(
  membership: MembershipRow[],
  keyOf: (row: PoolRowLite) => string = identityKey,
): Map<string, Agg> {
  const map = new Map<string, Agg>();
  for (const { row, copies } of membership) {
    const key = keyOf(row);
    let a = map.get(key);
    if (!a) {
      a = {
        job: row.job,
        structure: row.structure,
        markTail: row.markTail,
        markId: row.markId,
        contractor: row.contractor,
        qty: 0,
        wt: 0,
        activities: new Set<string>(),
        furthestStep: -1,
      };
      map.set(key, a);
    }
    a.qty += row.balanceQty * copies;
    a.wt += row.balanceWt * copies;
    if (row.activity) a.activities.add(row.activity);
    const { currentStepIndex } = computeRoute(row.operation, row.activity);
    if (currentStepIndex !== null && currentStepIndex > a.furthestStep) {
      a.furthestStep = currentStepIndex;
    }
  }
  return map;
}

function activitiesLabel(a: Agg): string | null {
  if (a.activities.size === 0) return null;
  return Array.from(a.activities).sort().join(", ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function multisetCounts(prev: MembershipRow[], next: MembershipRow[]) {
  const prevByHash = new Map<string, number>();
  for (const m of prev)
    prevByHash.set(m.row.hash, (prevByHash.get(m.row.hash) ?? 0) + m.copies);
  let addedRows = 0;
  let unchangedRows = 0;
  let removedRows = 0;
  const seen = new Set<string>();
  for (const m of next) {
    const p = prevByHash.get(m.row.hash) ?? 0;
    unchangedRows += Math.min(m.copies, p);
    addedRows += Math.max(0, m.copies - p);
    seen.add(m.row.hash);
  }
  for (const [hash, p] of prevByHash) {
    if (!seen.has(hash)) removedRows += p;
  }
  return { addedRows, unchangedRows, removedRows };
}

export function buildChangeSet(
  prev: MembershipRow[],
  next: MembershipRow[],
  from: { id: number; label: string | null } | null,
  to: { id: number; label: string | null },
): ChangeSet {
  const { addedRows, unchangedRows } = multisetCounts(prev, next);

  const prevRows: IdentityRow[] = prev.map((m) => ({
    markId: m.row.markId,
    jobCardNo: m.row.jobCardNo,
  }));
  const nextRows: IdentityRow[] = next.map((m) => ({
    markId: m.row.markId,
    jobCardNo: m.row.jobCardNo,
  }));
  // Bridges unambiguous job-card reissues (same mark, real activity
  // progress) so they land as a "moved activity" instead of a false
  // completed+new-mark pair. See identityBridge.ts.
  const [, nextBridge] = buildIdentityBridge([prevRows, nextRows]);
  const bridgedKeyOf = (row: PoolRowLite): string =>
    nextBridge.get(identityRawKey(row.markId, row.jobCardNo)) ??
    identityRawKey(row.markId, row.jobCardNo);

  const prevAgg = aggregate(prev);
  const nextAgg = aggregate(next, bridgedKeyOf);

  const movedActivity: ChangeItem[] = [];
  const qtyChanged: ChangeItem[] = [];
  const newMarks: ChangeItem[] = [];
  const completed: ChangeItem[] = [];

  let backwardMoves = 0;
  let qtyIncreases = 0;
  let contractorReassigned = 0;
  let commonCount = 0;

  for (const [key, n] of nextAgg) {
    const p = prevAgg.get(key);
    if (!p) {
      newMarks.push({
        markId: n.markId,
        job: n.job,
        structure: n.structure,
        markTail: n.markTail,
        contractor: n.contractor,
        activityFrom: null,
        activityTo: activitiesLabel(n),
        qtyFrom: null,
        qtyTo: round2(n.qty),
        wtFrom: null,
        wtTo: round2(n.wt),
      });
      continue;
    }
    commonCount++;
    const fromAct = activitiesLabel(p);
    const toAct = activitiesLabel(n);
    if (fromAct !== toAct) {
      movedActivity.push({
        markId: n.markId,
        job: n.job,
        structure: n.structure,
        markTail: n.markTail,
        contractor: n.contractor,
        activityFrom: fromAct,
        activityTo: toAct,
        qtyFrom: round2(p.qty),
        qtyTo: round2(n.qty),
        wtFrom: round2(p.wt),
        wtTo: round2(n.wt),
      });
      if (n.furthestStep >= 0 && p.furthestStep >= 0 && n.furthestStep < p.furthestStep) {
        backwardMoves++;
      }
    }
    if (round2(p.qty) !== round2(n.qty) || round2(p.wt) !== round2(n.wt)) {
      qtyChanged.push({
        markId: n.markId,
        job: n.job,
        structure: n.structure,
        markTail: n.markTail,
        contractor: n.contractor,
        activityFrom: fromAct,
        activityTo: toAct,
        qtyFrom: round2(p.qty),
        qtyTo: round2(n.qty),
        wtFrom: round2(p.wt),
        wtTo: round2(n.wt),
      });
      if (n.qty > p.qty) qtyIncreases++;
    }
    if ((p.contractor ?? "") !== (n.contractor ?? "")) contractorReassigned++;
  }

  for (const [key, p] of prevAgg) {
    if (nextAgg.has(key)) continue;
    completed.push({
      markId: p.markId,
      job: p.job,
      structure: p.structure,
      markTail: p.markTail,
      contractor: p.contractor,
      activityFrom: activitiesLabel(p),
      activityTo: null,
      qtyFrom: round2(p.qty),
      qtyTo: null,
      wtFrom: round2(p.wt),
      wtTo: null,
    });
  }

  let prevQty = 0;
  let prevWt = 0;
  for (const a of prevAgg.values()) {
    prevQty += a.qty;
    prevWt += a.wt;
  }
  let nextQty = 0;
  let nextWt = 0;
  for (const a of nextAgg.values()) {
    nextQty += a.qty;
    nextWt += a.wt;
  }

  const flags: string[] = [];
  if (backwardMoves > 0) {
    flags.push(
      `${backwardMoves} mark${backwardMoves === 1 ? "" : "s"} moved backward in their activity route`,
    );
  }
  if (qtyIncreases > 0) {
    flags.push(
      `${qtyIncreases} mark${qtyIncreases === 1 ? "" : "s"} increased in balance quantity`,
    );
  }
  if (commonCount >= 10 && contractorReassigned / commonCount > 0.2) {
    flags.push(
      `${contractorReassigned} of ${commonCount} carried-over marks were reassigned to a different contractor`,
    );
  }

  const sortItems = (a: ChangeItem, b: ChangeItem) =>
    a.markId.localeCompare(b.markId);
  movedActivity.sort(sortItems);
  qtyChanged.sort(sortItems);
  newMarks.sort(sortItems);
  completed.sort(sortItems);

  return {
    fromImportId: from?.id ?? null,
    toImportId: to.id,
    fromLabel: from?.label ?? null,
    toLabel: to.label,
    counts: {
      addedRows,
      unchangedRows,
      movedActivity: movedActivity.length,
      qtyChanged: qtyChanged.length,
      newMarks: newMarks.length,
      completed: completed.length,
    },
    netPendingQtyChange: round2(nextQty - prevQty),
    netPendingWtChange: round2(nextWt - prevWt),
    movedActivity,
    qtyChanged,
    newMarks,
    completed,
    flags,
  };
}
