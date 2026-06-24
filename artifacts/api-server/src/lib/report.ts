// Deterministic "analytics pack" builder for the AI turnaround report.
//
// The pack is a compact set of aggregates and top-N lists computed entirely
// server-side from an import's membership rows (ageing = today - assignDate).
// The raw rows are NEVER sent to the model; only this pack is. Everything here
// is deterministic and reproducible so the model only analyzes, never computes.

import type { MembershipRow } from "./diff";
import type { ChangeSet } from "./diff";
import { computeAgeing, computeRoute } from "./parse";

import { sortActivities } from "@workspace/domain";

const STALE_N = 25;
const TOP_GROUPS = 10;
const MIN_CONTRACTOR_MARKS = 20;

function tons(kg: number): number {
  return Math.round((kg / 1000) * 10) / 10;
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

function ageingBucket(age: number): string {
  if (age <= 30) return "0-30";
  if (age <= 60) return "31-60";
  if (age <= 90) return "60-90";
  if (age <= 180) return "90-180";
  return "180+";
}

const BUCKET_ORDER = ["0-30", "31-60", "60-90", "90-180", "180+"];

interface Agg {
  marks: number;
  qty: number;
  weightKg: number;
  ageSum: number;
  ageCount: number;
  oldest: number;
  items90: number;
}

function emptyAgg(): Agg {
  return { marks: 0, qty: 0, weightKg: 0, ageSum: 0, ageCount: 0, oldest: 0, items90: 0 };
}

function addToAgg(agg: Agg, copies: number, qty: number, wt: number, age: number | null): void {
  agg.marks += copies;
  agg.qty += qty * copies;
  agg.weightKg += wt * copies;
  if (age !== null) {
    agg.ageSum += age * copies;
    agg.ageCount += copies;
    if (age > agg.oldest) agg.oldest = age;
    if (age >= 90) agg.items90 += copies;
  }
}

function avg(agg: Agg): number | null {
  return agg.ageCount > 0 ? Math.round(agg.ageSum / agg.ageCount) : null;
}

export interface AnalyticsPack {
  scope: {
    importId: number;
    importLabel: string | null;
    filtered: boolean;
    pendingMarks: number;
    distinctRows: number;
  };
  totals: {
    pendingMarks: number;
    totalQty: number;
    totalWeightT: number;
    avgAgeing: number | null;
    medianAgeing: number | null;
    datedItems: number;
    undatedItems: number;
  };
  ageingBuckets: { bucket: string; marks: number; qty: number; weightT: number }[];
  byActivity: {
    activity: string;
    marks: number;
    qty: number;
    weightT: number;
    avgAgeing: number | null;
    pctWeight: number;
    oldestAge: number;
  }[];
  contractorsByWeight: {
    contractor: string;
    marks: number;
    weightT: number;
    avgAgeing: number | null;
    items90plus: number;
  }[];
  contractorsWorstAgeing: {
    contractor: string;
    marks: number;
    weightT: number;
    avgAgeing: number | null;
    items90plus: number;
  }[];
  byJob: { job: string; weightT: number; avgAgeing: number | null }[];
  byStructure: { structure: string; weightT: number; avgAgeing: number | null }[];
  wipConcentration: {
    top3ActivitiesWeightPct: number;
    top3ContractorsWeightPct: number;
    weightPct90plus: number;
  };
  staleItems: {
    markId: string;
    structure: string;
    activity: string | null;
    contractor: string | null;
    ageing: number;
    copies: number;
    qty: number;
    weightT: number;
  }[];
  dataQuality: {
    nullContractor: number;
    nullDate: number;
    activityNotInRoute: number;
    activityNotInRouteSample: { markId: string; activity: string; operation: string }[];
  };
  throughput: {
    prevImportId: number | null;
    prevImportLabel: string | null;
    completed: number;
    newMarks: number;
    movedActivity: number;
    qtyChanged: number;
    netPendingQtyChange: number;
    netPendingWtChangeT: number;
    flags: string[];
  } | null;
}

export function buildAnalyticsPack(
  membership: MembershipRow[],
  scope: { importId: number; importLabel: string | null; filtered: boolean },
  changeSet: ChangeSet | null,
  fromImport: { id: number; label: string | null } | null,
): AnalyticsPack {
  const total = emptyAgg();
  const buckets = new Map<string, Agg>();
  const byActivity = new Map<string, Agg>();
  const byContractor = new Map<string, Agg>();
  const byJob = new Map<string, Agg>();
  const byStructure = new Map<string, Agg>();
  const ageValues: number[] = [];
  const distinct = new Set<string>();

  let nullContractor = 0;
  let nullDate = 0;
  let undatedItems = 0;
  let notInRouteCount = 0;
  const notInRoute: { markId: string; activity: string; operation: string }[] = [];

  const get = (m: Map<string, Agg>, k: string): Agg => {
    let a = m.get(k);
    if (!a) {
      a = emptyAgg();
      m.set(k, a);
    }
    return a;
  };

  const stale: AnalyticsPack["staleItems"] = [];

  for (const { row, copies } of membership) {
    distinct.add(row.hash);
    const age = computeAgeing(row.activity, row.assignDate, row.lastProductionDate);
    const qty = row.balanceQty;
    const wt = row.balanceWt;

    addToAgg(total, copies, qty, wt, age);

    if (age !== null) {
      for (let i = 0; i < copies; i++) ageValues.push(age);
      addToAgg(get(buckets, ageingBucket(age)), copies, qty, wt, age);
    } else {
      undatedItems += copies;
    }

    if (row.contractor == null) nullContractor += copies;
    else addToAgg(get(byContractor, row.contractor), copies, qty, wt, age);

    if (row.assignDate == null) nullDate += copies;

    const activityKey = row.activity ?? "(none)";
    addToAgg(get(byActivity, activityKey), copies, qty, wt, age);
    addToAgg(get(byJob, row.job), copies, qty, wt, age);
    addToAgg(get(byStructure, row.structure), copies, qty, wt, age);

    if (row.activity) {
      const { routeSteps, currentStepIndex } = computeRoute(row.operation, row.activity);
      if (routeSteps.length > 0 && currentStepIndex === null) {
        notInRouteCount += copies;
        if (notInRoute.length < 25) {
          notInRoute.push({
            markId: row.markId,
            activity: row.activity,
            operation: row.operation ?? "",
          });
        }
      }
    }

    if (age !== null) {
      stale.push({
        markId: row.markId,
        structure: row.structure,
        activity: row.activity,
        contractor: row.contractor,
        ageing: age,
        copies,
        qty: row.balanceQty * copies,
        weightT: tons(row.balanceWt * copies),
      });
    }
  }

  const totalWeightKg = total.weightKg;

  const ageingBuckets = BUCKET_ORDER.map((bucket) => {
    const a = buckets.get(bucket) ?? emptyAgg();
    return { bucket, marks: a.marks, qty: Math.round(a.qty), weightT: tons(a.weightKg) };
  });

  const activityList = sortActivities(Array.from(byActivity.keys())).map((activity) => {
    const a = byActivity.get(activity)!;
    return {
      activity,
      marks: a.marks,
      qty: Math.round(a.qty),
      weightT: tons(a.weightKg),
      avgAgeing: avg(a),
      pctWeight: totalWeightKg > 0 ? round((a.weightKg / totalWeightKg) * 100) : 0,
      oldestAge: a.oldest,
    };
  });

  const allContractors = Array.from(byContractor.entries()).map(([contractor, a]) => ({
    contractor,
    marks: a.marks,
    weightT: tons(a.weightKg),
    avgAgeing: avg(a),
    items90plus: a.items90,
    _weightKg: a.weightKg,
    _avg: avg(a) ?? -1,
  }));

  const contractorsByWeight = [...allContractors]
    .sort((x, y) => y._weightKg - x._weightKg)
    .slice(0, TOP_GROUPS)
    .map(({ _weightKg, _avg, ...rest }) => rest);

  const contractorsWorstAgeing = allContractors
    .filter((c) => c.marks >= MIN_CONTRACTOR_MARKS)
    .sort((x, y) => y._avg - x._avg)
    .slice(0, TOP_GROUPS)
    .map(({ _weightKg, _avg, ...rest }) => rest);

  const jobList = Array.from(byJob.entries())
    .map(([job, a]) => ({ job, weightT: tons(a.weightKg), avgAgeing: avg(a), _weightKg: a.weightKg }))
    .sort((x, y) => y._weightKg - x._weightKg)
    .slice(0, TOP_GROUPS)
    .map(({ _weightKg, ...rest }) => rest);

  const structureList = Array.from(byStructure.entries())
    .map(([structure, a]) => ({
      structure,
      weightT: tons(a.weightKg),
      avgAgeing: avg(a),
      _weightKg: a.weightKg,
    }))
    .sort((x, y) => y._weightKg - x._weightKg)
    .slice(0, TOP_GROUPS)
    .map(({ _weightKg, ...rest }) => rest);

  // WIP concentration.
  const sortedActWeights = activityList.map((a) => a.weightT).sort((x, y) => y - x);
  const sortedContractorWeights = allContractors
    .map((c) => c.weightT)
    .sort((x, y) => y - x);
  const totalWeightT = tons(totalWeightKg);
  const top3Act = sortedActWeights.slice(0, 3).reduce((s, n) => s + n, 0);
  const top3Con = sortedContractorWeights.slice(0, 3).reduce((s, n) => s + n, 0);
  const weight90Kg = membership.reduce((s, { row, copies }) => {
    const age = computeAgeing(row.activity, row.assignDate, row.lastProductionDate);
    return age !== null && age >= 90 ? s + row.balanceWt * copies : s;
  }, 0);

  const wipConcentration = {
    top3ActivitiesWeightPct: totalWeightT > 0 ? round((top3Act / totalWeightT) * 100) : 0,
    top3ContractorsWeightPct: totalWeightT > 0 ? round((top3Con / totalWeightT) * 100) : 0,
    weightPct90plus: totalWeightKg > 0 ? round((weight90Kg / totalWeightKg) * 100) : 0,
  };

  stale.sort((a, b) => b.ageing - a.ageing);

  return {
    scope: {
      importId: scope.importId,
      importLabel: scope.importLabel,
      filtered: scope.filtered,
      pendingMarks: total.marks,
      distinctRows: distinct.size,
    },
    totals: {
      pendingMarks: total.marks,
      totalQty: Math.round(total.qty),
      totalWeightT,
      avgAgeing: avg(total),
      medianAgeing: median(ageValues),
      datedItems: total.ageCount,
      undatedItems,
    },
    ageingBuckets,
    byActivity: activityList,
    contractorsByWeight,
    contractorsWorstAgeing,
    byJob: jobList,
    byStructure: structureList,
    wipConcentration,
    staleItems: stale.slice(0, STALE_N),
    dataQuality: {
      nullContractor,
      nullDate,
      activityNotInRoute: notInRouteCount,
      activityNotInRouteSample: notInRoute.slice(0, 10),
    },
    throughput:
      changeSet && fromImport
        ? {
            prevImportId: fromImport.id,
            prevImportLabel: fromImport.label,
            completed: changeSet.counts.completed,
            newMarks: changeSet.counts.newMarks,
            movedActivity: changeSet.counts.movedActivity,
            qtyChanged: changeSet.counts.qtyChanged,
            netPendingQtyChange: changeSet.netPendingQtyChange,
            netPendingWtChangeT: tons(changeSet.netPendingWtChange),
            flags: changeSet.flags,
          }
        : null,
  };
}
