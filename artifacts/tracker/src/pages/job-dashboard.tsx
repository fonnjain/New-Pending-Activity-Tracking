import { useState, useMemo, useEffect, Fragment, useCallback } from "react";
import { isActiveCutting } from "@/lib/ageing";
import {
  activityDisplayKey,
  compareActivity,
  sortActivities,
  processPhase,
  classifyWipCase,
  classifyNtltStage,
  PROCESS_PHASES,
  NTLT_STAGES,
  processPhasesForMode,
  type ProcessPhaseKey,
  type NtltStage,
  resolveContractorKey,
  normalizeContractorName,
} from "@workspace/domain";
import { useTracker, useContractorCategoryMap, useContractorAliasMap, useActiveJobSet, isNamedJobSetFilter, MULTI_JOBS_FILTER_VALUE, dateRangeWindow, type MfcViewMode } from "@/lib/store";
import { useProjectCompare } from "@/lib/projectSort";
import {
  buildContractorGroups,
  matchesContractorSelection,
} from "@/lib/contractorFilter";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  useGetOrderStatus,
  getGetOrderStatusQueryKey,
  useListImports,
  useGetReleaseBalance,
  getGetReleaseBalanceQueryKey,
} from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableFooter,
} from "@/components/ui/table";
import { SortControl } from "@/components/sort-control";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatWeight, formatDate } from "@/lib/utils";
import { sortRecords, type RecordSortKey } from "@/lib/sort";
import { ChevronLeft, ChevronRight, ChevronDown, Search, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, exportTimestamp, type XlsxSheet } from "@/lib/export";
import { useToast } from "@/hooks/use-toast";

const ROW_CAP = 300;

const isoDate = (s: unknown): string | null => {
  const v = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export default function JobDashboard() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <JobDashboardContent key={selectedImportId} />;
}

function JobDashboardContent() {
  const { selectedImportId, filters, mfcViewMode } = useTracker();
  const { toast } = useToast();
  // Project Wise drills down by Project (TLT) or Section (NTLT). "All" Order
  // Type shows BOTH — every row is resolved by its own category below.
  const isAll = filters.category === "ALL";
  const isNtlt = filters.category === "NTLT";
  // Phase column headers: NTLT uses its own 5-stage model; TLT/ALL use PROCESS_PHASES.
  const headerPhases = isNtlt
    ? (NTLT_STAGES as typeof PROCESS_PHASES)
    : processPhasesForMode(isAll ? "ALL" : "TLT");
  const { data: rawRecords = [] } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });

  // Order Review figures (Work Order / Release / Dispatch, all MT) aggregated per
  // project and joined to each Project Wise row by the same primary key used
  // below. The Order Review sheet is a TLT-only order book: in ALL mode the key
  // is prefixed "TLT: " to match primaryOf; in NTLT mode nothing matches so
  // those rows render "-". Dispatch uses the file value (fileDespatchMt), never
  // the WIP-computed dispatch.
  const { data: order } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });
  const orderByJob = useMemo(() => {
    const m = new Map<string, { wo: number; rel: number; disp: number; fileBalRelease: number; computedFg: number }>();
    for (const r of order?.rows ?? []) {
      const key = isAll ? `TLT: ${r.project}` : r.project;
      const agg = m.get(key) ?? { wo: 0, rel: 0, disp: 0, fileBalRelease: 0, computedFg: 0 };
      agg.wo += r.woOrderQtyMt ?? 0;
      agg.rel += r.releaseMt ?? 0;
      agg.disp += r.fileDespatchMt ?? 0;
      agg.fileBalRelease += r.fileBalReleaseMt ?? 0;
      agg.computedFg += r.fileGalvMt != null ? r.fileGalvMt - (r.fileDespatchMt ?? 0) : 0;
      m.set(key, agg);
    }
    return m;
  }, [order, isAll]);

  // Release Balance Computed (from WIP file) aggregated per project.
  // Scoped to the SAME import as all other figures so cross-import contamination
  // is impossible — the importId param was added to fix the global-singleton bug.
  const releaseBalanceParams = selectedImportId
    ? { importId: selectedImportId }
    : undefined;
  const { data: relBalData } = useGetReleaseBalance(releaseBalanceParams, {
    query: {
      queryKey: getGetReleaseBalanceQueryKey(releaseBalanceParams),
      enabled: !!selectedImportId,
    },
  });
  const relBalComputedByJob = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of relBalData?.rows ?? []) {
      const key = isAll ? `TLT: ${r.project}` : r.project;
      m.set(key, (m.get(key) ?? 0) + (r.releaseBalanceComputedMt ?? 0));
    }
    return m;
  }, [relBalData, isAll]);

  // Per-(project, mfcBatch) release balance sums — used by the batch-view to
  // attribute release balance to individual MFC batches without an OR join.
  // Keyed "rawProject::mfcBatch" (e.g. "911::A").
  const relBalByProjectBatch = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of relBalData?.batchBreakdown ?? []) {
      const key = `${r.project}::${r.mfcBatch}`;
      m.set(key, (m.get(key) ?? 0) + r.releaseBalanceComputedMt);
    }
    return m;
  }, [relBalData]);

  // Lookup helper: returns the correct release balance MT for a project-wise
  // table row, handling project-then-mfc mode where p.job is "911 / Batch A".
  const getRelBalForRow = useMemo(
    () =>
      (pJob: string): number => {
        if (!isAll && !isNtlt && mfcViewMode === "project-then-mfc") {
          const i = pJob.indexOf(" / ");
          const proj = i === -1 ? pJob : pJob.slice(0, i);
          const batch = i === -1 ? "Z" : pJob.slice(i + 3);
          return relBalByProjectBatch.get(`${proj}::${batch}`) ?? 0;
        }
        return relBalComputedByJob.get(pJob) ?? 0;
      },
    [isAll, isNtlt, mfcViewMode, relBalByProjectBatch, relBalComputedByJob],
  );

  // Finished Goods WIP per project from the WIP file's parseSummary. Keyed by
  // raw project code (no category prefix). React Query cache — no extra request.
  const { data: importList } = useListImports();
  const fgWipByJob = useMemo((): Record<string, number> => {
    const imp = importList?.find((i) => i.id === selectedImportId);
    return imp?.summary?.fgWipByJob ?? {};
  }, [importList, selectedImportId]);

  // Strip any category prefix ("TLT: " / "NTLT: ") from p.job to get the raw
  // project code used as the key in fgWipByJob.
  const fgWipForJob = (job: string): number =>
    fgWipByJob[job.replace(/^(?:TLT|NTLT): /, "")] ?? 0;

  // Scope to the current Order Type mode. The toggle drives both the primary
  // dimension (Project for TLT, Section for NTLT) and the grouping below.
  const records = useMemo(
    () =>
      rawRecords.filter(
        (r) =>
          (isAll || (r.category || "TLT") === filters.category) &&
          r.active !== false,
      ),
    [rawRecords, filters.category, isAll],
  );

  // Resolve a row's primary key (Project in TLT, Section group_key in NTLT) and
  // its secondary key (Structure in TLT, Sub-category in NTLT).
  const rowIsNtlt = (r: { category: string | null }) => (r.category || "TLT") === "NTLT";
  // Per-row resolution lets "All" mix both categories. In All mode keys are
  // category-prefixed so a TLT project and an NTLT section never merge.
  // MFC batch (WO Batch No.) is a TLT-only sub-level between Project and
  // Structure. Blank-origin batches resolve to "Z" so they sort/group last.
  const mfcOf = (r: { mfcBatch?: string | null }) => r.mfcBatch || "Z";

  const primaryOf = (r: { job: string | null; groupKey: string | null; category: string | null; mfcBatch?: string | null }) => {
    // MFC modes apply only to TLT rows in single-category (non-All) mode.
    if (!isAll && !rowIsNtlt(r)) {
      if (mfcViewMode === "view-by-mfc") return mfcOf(r);
      if (mfcViewMode === "project-then-mfc")
        return `${r.job || "Unknown"} / ${mfcOf(r)}`;
    }
    const base = (rowIsNtlt(r) ? r.groupKey : r.job) || "Unknown";
    return isAll ? `${rowIsNtlt(r) ? "NTLT" : "TLT"}: ${base}` : base;
  };
  const secondaryOf = (r: { structure: string | null; ntltSubtype: string | null; category: string | null }) =>
    rowIsNtlt(r) ? r.ntltSubtype : r.structure;

  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  // Global sort — driven by the header "Sort" control (see FilterBar).
  const compareProjects = useProjectCompare();

  const primaryLabel = isAll ? "Group" : isNtlt ? "Section"
    : mfcViewMode === "view-by-mfc" ? "MFC"
    : mfcViewMode === "project-then-mfc" ? "Project / MFC"
    : "Project";

  // Clear drill-down when the global Order Type changes.
  useEffect(() => { setSelectedJob(null); }, [filters.category]);

  const activeJobSet = useActiveJobSet();

  // Pre-filter: apply global job/section + MFC selections.
  const preFiltered = useMemo(
    () =>
      records.filter((r) => {
        if (isNtlt) {
          if (filters.section && r.groupKey !== filters.section) return false;
        } else {
          if (isNamedJobSetFilter(filters.job)) {
            // activeJobSet may contain combo keys ("821 - Z") or plain codes
            const comboKey = r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : null;
            if (!activeJobSet.has(r.job ?? "") && !(comboKey && activeJobSet.has(comboKey))) return false;
          } else if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) {
            if (r.job !== filters.job) return false;
          }
          // Multi-select job codes filter — independent of combo picker.
          if (filters.selectedJobCodes.length > 0) {
            if (!r.job || !filters.selectedJobCodes.includes(r.job)) return false;
          }
          // Combo filter (Job/Batch picker) — independent of plain job filter.
          // selectedJobs holds "job - batch" combo keys (e.g. "920 - C"); match
          // both the plain job code (for backward compat) and the combo key.
          if (filters.selectedJobs.length > 0) {
            const comboKey = r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : null;
            if (!filters.selectedJobs.includes(r.job ?? "") && !(comboKey && filters.selectedJobs.includes(comboKey))) return false;
          }
        }
        if (!isNtlt && filters.mfcBatch && mfcOf(r) !== filters.mfcBatch) return false;
        return true;
      }),
    [records, isNtlt, filters.job, filters.selectedJobCodes, filters.selectedJobs, filters.section, filters.mfcBatch, activeJobSet, mfcViewMode],
  );

  // Date window from the global date-range preset/custom filter.
  const dateWindow = useMemo(
    () => (filters.dateRange ? dateRangeWindow(filters.dateRange) : null),
    [filters.dateRange],
  );
  const dateFrom = dateWindow?.start ? dateWindow.start.toISOString().slice(0, 10) : "";
  const dateTo = dateWindow?.end ? dateWindow.end.toISOString().slice(0, 10) : "";

  const categoryMap = useContractorCategoryMap();
  const aliasMap = useContractorAliasMap();

  // Final filter: apply global activity + contractor + date range.
  const filtered = useMemo(
    () =>
      preFiltered.filter((r) => {
        if (filters.activity && r.activity !== filters.activity) return false;
        if (!matchesContractorSelection(r.contractor, filters.contractor ?? null, categoryMap, aliasMap)) return false;
        if (dateFrom && r.assignDate != null && String(r.assignDate) < dateFrom) return false;
        if (dateTo && r.assignDate != null && String(r.assignDate) > dateTo) return false;
        return true;
      }),
    [preFiltered, filters.activity, filters.contractor, dateFrom, dateTo, categoryMap, aliasMap],
  );

  const { totalProjects, totalMarks, totalQty, totalWt, avgAgeing, byProject, byActivity } =
    useMemo(() => {
      const withAge = filtered.filter((r) => r.ageingDays !== null);
      const avg = (recs: typeof filtered) => {
        const a = recs.filter((r) => r.ageingDays !== null);
        return a.length
          ? Math.round(a.reduce((s, r) => s + (r.ageingDays || 0), 0) / a.length)
          : null;
      };

      const projGroups = new Map<string, typeof filtered>();
      filtered.forEach((r) => {
        const key = primaryOf(r);
        if (!projGroups.has(key)) projGroups.set(key, []);
        projGroups.get(key)!.push(r);
      });

      const emptyPhases = () =>
        Object.fromEntries(
          PROCESS_PHASES.map((p) => [p.key, { marks: 0, weight: 0 }]),
        ) as Record<ProcessPhaseKey, { marks: number; weight: number }>;

      const emptyNtltStages = () =>
        Object.fromEntries(
          NTLT_STAGES.map((s) => [s.key, { marks: 0, weight: 0 }]),
        ) as Record<NtltStage, { marks: number; weight: number }>;

      const byProject = Array.from(projGroups.entries()).map(([job, recs]) => {
        const phases = emptyPhases();
        const ntltStages = emptyNtltStages();
        for (const r of recs) {
          // TLT phase classification — Use classifyWipCase to apply the Type guard:
          //   CUTTING / AWAITING_ASSIGNMENT → Cutting bucket (pre-production, JCNS+Authorized)
          //   IN_PRODUCTION  → quality/galvanising by activity (Type="Job Card WIP")
          //   FINISHED_GOODS → dispatch bucket (regardless of activity code)
          //   NOT_RELEASED   → skip (counted as Release Balance, not here)
          const wipCase = classifyWipCase(r);
          if (wipCase === "AWAITING_ASSIGNMENT") {
            phases.awaitingAssignment.marks += 1;
            phases.awaitingAssignment.weight += r.balanceWt;
          } else if (wipCase === "CUTTING") {
            phases.cutting.marks += 1;
            phases.cutting.weight += r.balanceWt;
          } else if (wipCase === "IN_PRODUCTION") {
            const key = processPhase(r.activity);
            if (key === "quality" || key === "galvanising") {
              phases[key].marks += 1;
              phases[key].weight += r.balanceWt;
            }
            // Unknown activity code: safely dropped (no silent miscounting).
          } else if (wipCase === "FINISHED_GOODS") {
            // FG Pending For Dispatch — covers TLT + NTLT regardless of
            // whether r.activity is blank or holds a scheduled activity code.
            phases.dispatch.marks += 1;
            phases.dispatch.weight += r.balanceWt;
          }
          // NTLT stage classification — applies the Type guard via classifyNtltStage
          // (built on classifyWipCase). Only populated for NTLT records.
          if ((r.category || "TLT") === "NTLT") {
            const stg = classifyNtltStage(r);
            ntltStages[stg].marks += 1;
            ntltStages[stg].weight += r.balanceWt;
          }
        }
        return {
        job,
        structures: new Set(recs.map((r) => secondaryOf(r)).filter(Boolean)).size,
        marks: recs.length,
        qty: recs.reduce((s, r) => s + r.balanceQty, 0),
        weight: recs.reduce((s, r) => s + r.balanceWt, 0),
        phases,
        ntltStages,
        avgAge: avg(recs),
        firstAssign: recs.reduce<string | null>((min, r) => {
          const d = isoDate(r.assignDate);
          if (!d) return min;
          return min === null || d < min ? d : min;
        }, null),
        c0to30: recs.filter((r) => r.ageingDays !== null && r.ageingDays <= 30).length,
        c31to60: recs.filter(
          (r) => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60,
        ).length,
        c60Plus: recs.filter((r) => r.ageingDays !== null && r.ageingDays > 60).length,
        };
      });

      const actGroups = new Map<string, typeof filtered>();
      filtered.forEach((r) => {
        const key = activityDisplayKey(r.activity, r.category);
        if (!actGroups.has(key)) actGroups.set(key, []);
        actGroups.get(key)!.push(r);
      });

      const byActivity = Array.from(actGroups.entries())
        .map(([activity, recs]) => ({
          activity,
          marks: recs.length,
          qty: recs.reduce((s, r) => s + r.balanceQty, 0),
          weight: recs.reduce((s, r) => s + r.balanceWt, 0),
          avgAge: avg(recs),
        }))
        .sort((a, b) => compareActivity(a.activity, b.activity));

      return {
        totalProjects: projGroups.size,
        totalMarks: filtered.length,
        totalQty: filtered.reduce((s, r) => s + r.balanceQty, 0),
        totalWt: filtered.reduce((s, r) => s + r.balanceWt, 0),
        avgAgeing: withAge.length
          ? Math.round(withAge.reduce((s, r) => s + (r.ageingDays || 0), 0) / withAge.length)
          : 0,
        byProject,
        byActivity,
      };
    }, [filtered, mfcViewMode]);

  const sortedProjects = useMemo(() => {
    const arr = [...byProject];
    // View-by-MFC mode: keys are MFC-primary ("Batch A / 911") — keep the
    // alphabetical batch grouping; the global project sort doesn't apply.
    if (!isAll && !isNtlt && mfcViewMode === "view-by-mfc") {
      arr.sort((a, b) => a.job.localeCompare(b.job));
      return arr;
    }
    // Project-then-MFC mode: keys encode the batch ("911 / Batch A"). Apply
    // the global sort to the project part, then batch alphabetical (Z last)
    // so all batches of a project stay consecutive.
    if (!isAll && !isNtlt && mfcViewMode === "project-then-mfc") {
      const parts = (key: string): [string, string] => {
        const i = key.indexOf(" / ");
        return i === -1 ? [key, ""] : [key.slice(0, i), key.slice(i + 3)];
      };
      arr.sort((a, b) => {
        const [pa, ba] = parts(a.job);
        const [pb, bb] = parts(b.job);
        return compareProjects(pa, pb) || ba.localeCompare(bb);
      });
      return arr;
    }
    const stats = new Map(arr.map((p) => [p.job, p]));
    const extras = {
      avgAge: (job: string) => stats.get(job)?.avgAge,
      firstAssign: (job: string) => stats.get(job)?.firstAssign ?? null,
    };
    arr.sort((a, b) => compareProjects(a.job, b.job, extras));
    return arr;
  }, [byProject, isAll, isNtlt, mfcViewMode, compareProjects]);

  const orderTotals = useMemo(() => {
    return byProject.reduce(
      (acc, p) => {
        const o = orderByJob.get(p.job);
        if (o) {
          acc.wo += o.wo;
          acc.rel += o.rel;
          acc.disp += o.disp;
          acc.fileBalRelease += o.fileBalRelease;
          acc.computedFg += o.computedFg;
        }
        return acc;
      },
      { wo: 0, rel: 0, disp: 0, fileBalRelease: 0, computedFg: 0 },
    );
  }, [byProject, orderByJob]);

  // Global structure→batch OR aggregation used by both the flat table and the
  // export in project-then-mfc mode. Same rule as ProjectDetailPanel.orderByMfc:
  //   1 real batch → that batch; 0 or 2+ → Z; no WIP marks → __NP__.
  // __NP__ is kept as its own key so the flat table can show a "No pending
  // balance" row and the export can emit it as a separate row. Projects that
  // have only unbatched marks (no Z row) would silently drop NP structures if
  // we folded __NP__ into Z — that caused a 142 MT shortfall.
  // Keyed "rawProject::resolvedBatch" (e.g. "903::A", "903::Z", "903::__NP__").
  const orByProjectBatch = useMemo(() => {
    type OrAgg = { wo: number; disp: number; fg: number };
    if (!order?.rows?.length) return new Map<string, OrAgg>();
    // Collect real batches per (project, structure) from all job-scoped WIP
    // records. Intentionally uses preFiltered (job/section/mfcBatch scope) NOT
    // filtered (activity/contractor/date narrow view) — NP membership is
    // determined by absence from the current import, not absence from the
    // current display filter. A structure with Fabrication marks but no Cutting
    // marks must NOT appear as NP just because an activity=C filter is active.
    const structRealBatches = new Map<string, Set<string>>();
    const structInWip = new Set<string>();
    for (const r of preFiltered) {
      if (!r.job || !r.structure) continue;
      const k = `${r.job}\x01${r.structure}`;
      structInWip.add(k);
      if (!structRealBatches.has(k)) structRealBatches.set(k, new Set());
      if (r.mfcBatch && r.mfcBatch !== "Z") structRealBatches.get(k)!.add(r.mfcBatch);
    }
    const resolve = (proj: string, struct: string): string => {
      const k = `${proj}\x01${struct}`;
      if (!structInWip.has(k)) return "__NP__"; // no WIP marks → No Pending Balance row
      const real = structRealBatches.get(k) ?? new Set<string>();
      return real.size === 1 ? [...real][0] : "Z";
    };
    const m = new Map<string, OrAgg>();
    for (const r of order.rows) {
      if (!r.project) continue;
      const batchKey = resolve(r.project, r.structure);
      const mapKey = `${r.project}::${batchKey}`;
      const agg = m.get(mapKey) ?? { wo: 0, disp: 0, fg: 0 };
      agg.wo += r.woOrderQtyMt ?? 0;
      agg.disp += r.fileDespatchMt ?? 0;
      agg.fg += r.fileGalvMt != null ? r.fileGalvMt - (r.fileDespatchMt ?? 0) : 0;
      m.set(mapKey, agg);
    }
    return m;
  }, [order?.rows, filtered]);

  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const groupLabel = isAll ? "Group" : isNtlt ? "Section" : "Project";
      // Stage columns vary by mode: NTLT uses its own 5-stage model; TLT/ALL use PROCESS_PHASES.
      const stageExportColumns = isNtlt
        ? NTLT_STAGES.flatMap((s) => [
            { label: `${s.label} Wt (MT)`,    field: `ntlt_${s.key}_wt`,    numeric: true, decimals: 3, total: true },
            { label: `${s.label} Marks`,       field: `ntlt_${s.key}_marks`, numeric: true, decimals: 0, total: true },
          ])
        : [
            { label: "Awaiting Assignment Wt (MT)", field: "awaitingAssignmentWt",    numeric: true, decimals: 3, total: true },
            { label: "Awaiting Assignment Marks",    field: "awaitingAssignmentMarks", numeric: true, decimals: 0, total: true },
            { label: "Cutting Wt (MT)",              field: "cuttingWt",              numeric: true, decimals: 3, total: true },
            { label: "Cutting Marks",                field: "cuttingMarks",           numeric: true, decimals: 0, total: true },
            { label: "Quality Check Wt (MT)",        field: "qualityWt",              numeric: true, decimals: 3, total: true },
            { label: "Quality Check Marks",          field: "qualityMarks",           numeric: true, decimals: 0, total: true },
            { label: "Galvanising Wt (MT)",          field: "galvanisingWt",          numeric: true, decimals: 3, total: true },
            { label: "Galvanising Marks",            field: "galvanisingMarks",       numeric: true, decimals: 0, total: true },
            { label: "FG (WIP file) (MT)",           field: "fgWipWt",                numeric: true, decimals: 3, total: true },
          ] as Array<{ label: string; field: string; numeric: boolean; decimals: number; total: boolean }>;

      const sheets: XlsxSheet[] = [
        {
          name: `By ${groupLabel}`,
          columns: [
            { label: groupLabel, field: "job" },
            { label: "Work Order (MT)", field: "workOrderMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch (MT)", field: "dispatchMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch Balance (MT)", field: "dispatchBalanceMt", numeric: true, decimals: 3, total: true },
            { label: "FG (Order Review) (MT)", field: "fgOverviewComputedMt", numeric: true, decimals: 3, total: true },
            { label: "Release Balance Computed (MT)", field: "releaseBalanceComputedMt", numeric: true, decimals: 3, total: true },
            ...stageExportColumns,
            { label: "Total Wt (MT)", field: "totalWt", numeric: true, decimals: 3, total: true },
            { label: "Total Marks", field: "marks", numeric: true, decimals: 0, total: true },
            { label: "Avg Ageing (d)", field: "avgAge", numeric: true, decimals: 0 },
            { label: "First Assign", field: "firstAssign" },
            { label: "Structures", field: "structures", numeric: true, decimals: 0 },
            { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
            { label: "0-30d", field: "c0to30", numeric: true, decimals: 0 },
            { label: "31-60d", field: "c31to60", numeric: true, decimals: 0 },
            { label: "60d+", field: "c60Plus", numeric: true, decimals: 0 },
          ],
          rows: sortedProjects.flatMap((p, idx) => {
            const ntltStageCols = isNtlt
              ? Object.fromEntries(
                  NTLT_STAGES.flatMap((s) => [
                    [`ntlt_${s.key}_wt`,    p.ntltStages[s.key].weight / 1000],
                    [`ntlt_${s.key}_marks`, p.ntltStages[s.key].marks],
                  ]),
                )
              : {
                  awaitingAssignmentWt:    p.phases.awaitingAssignment.weight / 1000,
                  awaitingAssignmentMarks: p.phases.awaitingAssignment.marks,
                  cuttingWt:               p.phases.cutting.weight / 1000,
                  cuttingMarks:            p.phases.cutting.marks,
                  qualityWt:               p.phases.quality.weight / 1000,
                  qualityMarks:            p.phases.quality.marks,
                  galvanisingWt:           p.phases.galvanising.weight / 1000,
                  galvanisingMarks:        p.phases.galvanising.marks,
                  fgWipWt:                 (!isAll && !isNtlt && mfcViewMode === "project-then-mfc") ? p.phases.dispatch.weight / 1000 : fgWipForJob(p.job) / 1000,
                };
            const isBatchRow = !isAll && !isNtlt && mfcViewMode === "project-then-mfc";
            // For batch rows, look up OR figures from the global structure→batch map.
            // p.job is "924 / A" format; parse out project and batch.
            const batchOr = (() => {
              if (!isBatchRow) return null;
              const sep = p.job.lastIndexOf(" / ");
              if (sep === -1) return null;
              return orByProjectBatch.get(`${p.job.slice(0, sep)}::${p.job.slice(sep + 3)}`);
            })();
            const mainExportRow = {
              job: p.job,
              workOrderMt: isBatchRow ? (batchOr?.wo ?? 0) : orderByJob.get(p.job)?.wo ?? 0,
              dispatchMt: isBatchRow ? (batchOr?.disp ?? 0) : orderByJob.get(p.job)?.disp ?? 0,
              dispatchBalanceMt: isBatchRow ? ((batchOr?.wo ?? 0) - (batchOr?.disp ?? 0)) : (orderByJob.get(p.job)?.wo ?? 0) - (orderByJob.get(p.job)?.disp ?? 0),
              fgOverviewComputedMt: isBatchRow ? (batchOr?.fg ?? 0) : orderByJob.get(p.job)?.computedFg ?? 0,
              releaseBalanceComputedMt: getRelBalForRow(p.job),
              ...ntltStageCols,
              totalWt: p.weight / 1000,
              marks: p.marks,
              qty: p.qty,
              avgAge: p.avgAge,
              firstAssign: p.firstAssign ?? "",
              structures: p.structures,
              c0to30: p.c0to30,
              c31to60: p.c31to60,
              c60Plus: p.c60Plus,
            };
            // Emit a "No marks in WIP" row after the last batch row for each
            // project. These are OR structures with no WIP marks — silently dropped
            // when __NP__ was folded into Z (23 projects have no Z row at all).
            const npExportRow = (() => {
              if (!isBatchRow) return null;
              const sep = p.job.lastIndexOf(" / ");
              const proj = sep === -1 ? p.job : p.job.slice(0, sep);
              const nextP = sortedProjects[idx + 1];
              const nextSep = nextP ? nextP.job.lastIndexOf(" / ") : -1;
              const nextProj = nextP ? (nextSep === -1 ? nextP.job : nextP.job.slice(0, nextSep)) : null;
              if (proj === nextProj) return null; // more batch rows follow
              const np = orByProjectBatch.get(`${proj}::__NP__`);
              if (!np) return null;
              return {
                job: `${proj} / No marks in WIP`,
                workOrderMt: np.wo,
                dispatchMt: np.disp,
                dispatchBalanceMt: np.wo - np.disp,
                fgOverviewComputedMt: np.fg,
                releaseBalanceComputedMt: null,
                awaitingAssignmentWt: null, awaitingAssignmentMarks: null,
                cuttingWt: null, cuttingMarks: null,
                qualityWt: null, qualityMarks: null,
                galvanisingWt: null, galvanisingMarks: null,
                fgWipWt: null,
                totalWt: null, marks: null, qty: null,
                avgAge: null, firstAssign: "", structures: null,
                c0to30: null, c31to60: null, c60Plus: null,
              };
            })();
            return npExportRow ? [mainExportRow, npExportRow] : [mainExportRow];
          }),
        },
        {
          name: "By Activity",
          columns: [
            { label: "Activity", field: "activity" },
            { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
            { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
            { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
            { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
          ],
          rows: byActivity.map((a) => ({
            activity: a.activity,
            marks: a.marks,
            qty: a.qty,
            weight: a.weight,
            avgAge: a.avgAge,
          })),
        },
      ];
      await exportToXlsxSheets(
        `project_wise_${exportTimestamp()}.xlsx`,
        sheets,
      );
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unknown error — check browser console for details.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }, [exporting, isAll, isNtlt, mfcViewMode, sortedProjects, orderByJob, orByProjectBatch, relBalComputedByJob, relBalByProjectBatch, getRelBalForRow, byActivity, toast]);

  // Reconciliation guard: all marks must be accounted for in exactly one bucket.
  // bucketTotal = sum of all phase weights (including phases.dispatch for FG)
  //             + release balance (Initial Cutting marks, in kg).
  // Must equal totalWt (every record_pool row's balance weight × copies).
  // A persistent shortfall > 1 MT means some marks have no phase mapping;
  // a negative shortfall means phases double-counted a mark.
  // IMPORTANT: this hook must stay BEFORE the selectedJob early-return below to
  // satisfy React's Rules of Hooks (hooks must run on every render unconditionally).
  const reconciliationWarning = useMemo(() => {
    // NTLT uses its own 5-stage model; TLT-phase reconciliation does not apply.
    if (isNtlt) return null;
    if (byProject.length === 0 || !relBalData?.rows) return null;
    const allPhasesWt = byProject.reduce(
      (s, p) =>
        s +
        Object.values(p.phases).reduce((ps, ph) => ps + ph.weight, 0),
      0,
    );
    const relBalKg = byProject.reduce(
      (s, p) => s + getRelBalForRow(p.job) * 1000,
      0,
    );
    const bucketTotal = allPhasesWt + relBalKg;
    const shortfall = totalWt - bucketTotal;
    const absMt = Math.abs(shortfall) / 1000;
    // Only warn when shortfall is > 1 MT and > 0.5% of total — small gaps are
    // rounding / unknown-activity marks, not a scoping regression.
    if (absMt < 1 || totalWt === 0 || absMt / (totalWt / 1000) < 0.005) return null;
    return {
      shortfallMt: shortfall / 1000,
      bucketTotalMt: bucketTotal / 1000,
      totalMt: totalWt / 1000,
    };
  }, [byProject, relBalComputedByJob, relBalData, totalWt]);

  if (selectedJob) {
    const rawJob = selectedJob.replace(/^(?:TLT|NTLT): /, "");
    return (
      <JobDetail
        job={selectedJob}
        label={primaryLabel}
        records={filtered.filter((r) => primaryOf(r) === selectedJob)}
        onBack={() => setSelectedJob(null)}
        headerPhases={headerPhases}
        orderEntry={orderByJob.get(selectedJob)}
        orderRows={order?.rows?.filter((r) => r.project === rawJob) ?? []}
        mfcViewMode={mfcViewMode}
        relBalByProjectBatch={relBalByProjectBatch}
      />
    );
  }

  return (
    <div className="space-y-6">
      {reconciliationWarning && (
        <div className="rounded-md border border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 dark:border-yellow-600 px-4 py-3 text-sm">
          <p className="font-semibold text-yellow-800 dark:text-yellow-300">
            Bucket reconciliation mismatch
          </p>
          <p className="mt-1 text-yellow-700 dark:text-yellow-400">
            Phase buckets total{" "}
            <span className="font-mono">{reconciliationWarning.bucketTotalMt.toFixed(3)} MT</span>{" "}
            but Total Balance is{" "}
            <span className="font-mono">{reconciliationWarning.totalMt.toFixed(3)} MT</span>{" "}
            — difference{" "}
            <span className="font-mono">{Math.abs(reconciliationWarning.shortfallMt).toFixed(3)} MT</span>.{" "}
            {reconciliationWarning.shortfallMt > 0
              ? "Some marks are counted in Total Balance but not in any phase bucket."
              : "Phase buckets exceed Total Balance."}
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiTile title={`${primaryLabel}s`} value={totalProjects} />
        <KpiTile title="Pending Marks" value={totalMarks} />
        <KpiTile title="Balance Qty" value={totalQty.toLocaleString()} />
        <KpiTile title="Balance Wt" value={formatWeight(totalWt)} />
        <KpiTile title="Avg Ageing (d)" value={avgAgeing} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-end gap-3 space-y-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            onClick={() => { void handleExport(); }}
            disabled={byProject.length === 0 || exporting}
          >
            <FileSpreadsheet className="h-4 w-4" /> {exporting ? "Exporting..." : "Export Excel"}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
                <TableRow>
                  <TableHead>{primaryLabel}</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Work Order Qty</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Qty</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Balance</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">FG (Order Review)</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Release Balance Computed</TableHead>
                  {headerPhases.map((ph) => (
                    <TableHead key={ph.key} className="text-right align-bottom">
                      <span className="block whitespace-normal leading-tight">{ph.label}</span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case leading-tight max-w-[180px] ml-auto">
                        {ph.subLabel
                          ? `(${ph.subLabel})`
                          : ph.activities.length
                            ? `(${ph.activities.join(", ")})`
                            : "-"}
                      </span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                        wt / marks
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right align-bottom">
                    <span className="block whitespace-nowrap">Total</span>
                    <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                      wt / marks
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProjects.flatMap((p, idx) => {
                  // In project-then-mfc mode, orderByJob is keyed by raw project
                  // ("924") but p.job is "924 / A" — they never match. Use
                  // orByProjectBatch (keyed "project::batch") instead.
                  const isBatchRow2 = !isAll && !isNtlt && mfcViewMode === "project-then-mfc";
                  const o = (() => {
                    if (!isBatchRow2) return orderByJob.get(p.job);
                    const sep = p.job.lastIndexOf(" / ");
                    if (sep === -1) return orderByJob.get(p.job);
                    const bOr = orByProjectBatch.get(`${p.job.slice(0, sep)}::${p.job.slice(sep + 3)}`);
                    return bOr !== undefined ? { wo: bOr.wo, disp: bOr.disp, computedFg: bOr.fg } : undefined;
                  })();
                  // Zero shown as "0.0t" to match the drill-down; undefined → "—".
                  const fmtOr = (v: number | undefined): React.ReactNode =>
                    v === undefined
                      ? <span className="text-muted-foreground">-</span>
                      : v === 0 ? <span>0.0t</span>
                      : <span>{formatWeight(v * 1000)}</span>;
                  const mainRow = (
                  <TableRow
                    key={p.job}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelectedJob(p.job)}
                  >
                    <TableCell className="font-bold text-primary">{p.job}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtOr(o?.wo)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtOr(o?.disp)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o !== undefined ? fmtOr(o.wo - o.disp) : fmtOr(undefined)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtOr(o?.computedFg)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(() => { const v = getRelBalForRow(p.job); return v > 0 ? formatWeight(v * 1000) : <span className="text-muted-foreground">-</span>; })()}
                    </TableCell>
                    {isNtlt
                      ? NTLT_STAGES.map((stg) => {
                          const cell = p.ntltStages[stg.key];
                          return (
                            <TableCell key={stg.key} className="text-right tabular-nums">
                              {cell.marks > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(cell.weight)}</span>
                                  <span className="block text-xs text-muted-foreground">{cell.marks} marks</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          );
                        })
                      : PROCESS_PHASES.map((ph) => {
                          if (ph.key === "dispatch") {
                            // In project-then-mfc mode the key is "911 / Batch A" which has
                            // no entry in fgWipByJob (JSONB-keyed by raw project). Use the
                            // pool-derived phases.dispatch.weight instead — it carries the
                            // correct per-batch FG weight from record_pool for all imports.
                            const wt = (!isAll && !isNtlt && mfcViewMode === "project-then-mfc")
                              ? p.phases.dispatch.weight
                              : fgWipForJob(p.job);
                            return (
                              <TableCell key={ph.key} className="text-right tabular-nums">
                                {wt > 0 ? (
                                  <span className="font-bold">{formatWeight(wt)}</span>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                            );
                          }
                          const cell = p.phases[ph.key];
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              {cell.marks > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(cell.weight)}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {cell.marks} marks
                                  </span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          );
                        })}
                    <TableCell className="text-right tabular-nums bg-muted/30">
                      <span className="font-bold">{formatWeight(p.weight)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {p.marks} marks
                      </span>
                    </TableCell>
                    <TableCell
                      className={`text-right font-bold tabular-nums ${getAgeingColor(p.avgAge)}`}
                    >
                      {p.avgAge !== null ? `${p.avgAge}d` : "-"}
                    </TableCell>
                  </TableRow>
                  );
                  // After the last batch row for each project, inject a "No pending
                  // balance" row for OR structures that have no WIP marks this import.
                  const npRow = (() => {
                    if (!isBatchRow2) return null;
                    const sep = p.job.lastIndexOf(" / ");
                    const proj = sep === -1 ? p.job : p.job.slice(0, sep);
                    const nextP = sortedProjects[idx + 1];
                    const nextSep = nextP ? nextP.job.lastIndexOf(" / ") : -1;
                    const nextProj = nextP ? (nextSep === -1 ? nextP.job : nextP.job.slice(0, nextSep)) : null;
                    if (proj === nextProj) return null; // more batch rows follow
                    const np = orByProjectBatch.get(`${proj}::__NP__`);
                    if (!np) return null;
                    const fmtNp = (v: number) => v === 0 ? "0.0t" : formatWeight(v * 1000);
                    return (
                      <TableRow key={`${p.job}::np`} className="italic text-muted-foreground">
                        <TableCell className="pl-6 text-xs" title="Order Review structures with no marks in this WIP import. MFC batch is recorded only on WIP mark rows, so these structures carry no batch.">No marks in WIP</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNp(np.wo)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNp(np.disp)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNp(np.wo - np.disp)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNp(np.fg)}</TableCell>
                        <TableCell />
                        {PROCESS_PHASES.map((ph) => <TableCell key={ph.key} />)}
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    );
                  })();
                  return npRow ? [mainRow, npRow] : [mainRow];
                })}
                {byProject.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={(isNtlt ? NTLT_STAGES.length : PROCESS_PHASES.length) + 6} className="text-center py-4 text-muted-foreground">
                      No data for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {byProject.length > 0 && (
                <TableFooter>
                  {/* Column labels repeated as footer so they're visible at the bottom of long lists */}
                  <TableRow className="border-b text-xs text-muted-foreground font-semibold uppercase tracking-wide bg-card">
                    <TableHead className="py-1">{primaryLabel}</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight py-1">Work Order Qty</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight py-1">Dispatch Qty</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight py-1">Dispatch Balance</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight py-1">FG (Order Review)</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight py-1">Release Balance Computed</TableHead>
                    {headerPhases.map((ph) => (
                      <TableHead key={ph.key} className="text-right align-bottom py-1">
                        <span className="block whitespace-normal leading-tight">{ph.label}</span>
                        <span className="block text-[10px] font-normal normal-case leading-tight max-w-[180px] ml-auto">
                          {ph.subLabel
                            ? `(${ph.subLabel})`
                            : ph.activities.length
                              ? `(${ph.activities.join(", ")})`
                              : "-"}
                        </span>
                        <span className="block text-[10px] font-normal normal-case">wt / marks</span>
                      </TableHead>
                    ))}
                    <TableHead className="text-right align-bottom py-1">
                      <span className="block whitespace-nowrap">Total</span>
                      <span className="block text-[10px] font-normal normal-case">wt / marks</span>
                    </TableHead>
                    <TableHead className="text-right py-1">Avg Ageing</TableHead>
                  </TableRow>
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.wo * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.disp * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight((orderTotals.wo - orderTotals.disp) * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.computedFg * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(byProject.reduce((s, p) => s + getRelBalForRow(p.job), 0) * 1000)}</TableCell>
                    {isNtlt
                      ? NTLT_STAGES.map((stg) => {
                          const marks = byProject.reduce((s, p) => s + p.ntltStages[stg.key].marks, 0);
                          const weight = byProject.reduce((s, p) => s + p.ntltStages[stg.key].weight, 0);
                          return (
                            <TableCell key={stg.key} className="text-right tabular-nums">
                              {marks > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(weight)}</span>
                                  <span className="block text-xs text-muted-foreground">{marks} marks</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          );
                        })
                      : PROCESS_PHASES.map((ph) => {
                          if (ph.key === "dispatch") {
                            const totalFgWt = (!isAll && !isNtlt && mfcViewMode === "project-then-mfc")
                              ? byProject.reduce((s, p) => s + p.phases.dispatch.weight, 0)
                              : byProject.reduce((s, p) => s + fgWipForJob(p.job), 0);
                            return (
                              <TableCell key={ph.key} className="text-right tabular-nums">
                                {totalFgWt > 0 ? (
                                  <span className="font-bold">{formatWeight(totalFgWt)}</span>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                            );
                          }
                          const marks = byProject.reduce((s, p) => s + p.phases[ph.key].marks, 0);
                          const weight = byProject.reduce((s, p) => s + p.phases[ph.key].weight, 0);
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              {marks > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(weight)}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {marks} marks
                                  </span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          );
                        })}
                    <TableCell className="text-right tabular-nums bg-muted/50">
                      <span className="font-bold">{formatWeight(totalWt)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {totalMarks} marks
                      </span>
                    </TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(avgAgeing)}`}>
                      {avgAgeing}d
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            By Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[600px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                <TableRow>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byActivity.map((a) => (
                  <TableRow key={a.activity}>
                    <TableCell className="font-medium">{a.activity}</TableCell>
                    <TableCell className="text-right">{a.marks}</TableCell>
                    <TableCell className="text-right">{a.qty}</TableCell>
                    <TableCell className="text-right">{formatWeight(a.weight)}</TableCell>
                    <TableCell
                      className={`text-right font-bold tabular-nums ${getAgeingColor(a.avgAge)}`}
                    >
                      {a.avgAge !== null ? `${a.avgAge}d` : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {byActivity.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                      No data for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {byActivity.length > 0 && (
                <TableFooter className="sticky bottom-0 bg-card z-10">
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{totalMarks}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{totalQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{formatWeight(totalWt)}</TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(avgAgeing)}`}>
                      {avgAgeing}d
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function JobDetail({
  job,
  label,
  records,
  onBack,
  headerPhases = PROCESS_PHASES,
  orderEntry,
  orderRows = [],
  mfcViewMode = "project-with-mfc",
  relBalByProjectBatch = new Map(),
}: {
  job: string;
  label: string;
  records: any[];
  onBack: () => void;
  headerPhases?: typeof PROCESS_PHASES;
  orderEntry?: { wo: number; rel: number; disp: number; fileBalRelease: number };
  orderRows?: Array<{ structure: string; weightMt: number | null; woOrderQtyMt: number | null; releaseMt: number | null; fileDespatchMt: number | null; fileBalReleaseMt: number | null; fileGalvMt?: number | null }>;
  mfcViewMode?: MfcViewMode;
  /** Per-(project, mfcBatch) release balance MT map, keyed "rawProject::batch". */
  relBalByProjectBatch?: Map<string, number>;
}) {
  const jobIsNtlt = records.some((r) => (r.category || "TLT") === "NTLT");
  const isNtlt = jobIsNtlt;
  const mfcVal = (r: { mfcBatch?: string | null }) => r.mfcBatch || "Z";

  // Per-MFC order figures: map structure → mfcBatch using WIP records, then
  // aggregate the four OR columns (WO, Dispatch, DispBal, FG) per batch.
  //
  // Mapping rule (spec-exact):
  //   • Structure has exactly 1 distinct real batch letter (not null/'Z') → that batch
  //   • Structure has 0 or 2+ real batch letters (all-blank or ambiguous) → 'Z'
  //   • Structure absent from WIP entirely → '__NP__' (No Pending Balance row)
  //
  // 'Z' is this app's sentinel for a blank Batch No. in the WIP file; it is
  // NOT a real batch letter. Only A, B, C, D etc. are real.
  const orderByMfc = useMemo(() => {
    type OrAgg = { wo: number; rel: number; disp: number; fileBalRelease: number; fg: number };
    const empty = (): OrAgg => ({ wo: 0, rel: 0, disp: 0, fileBalRelease: 0, fg: 0 });
    if (!orderRows.length) return new Map<string, OrAgg>();

    // Step 1: collect all real batch letters per structure from WIP records.
    const structRealBatches = new Map<string, Set<string>>();
    const structInWip = new Set<string>();
    for (const r of records) {
      if (!r.structure) continue;
      structInWip.add(r.structure);
      if (!structRealBatches.has(r.structure)) structRealBatches.set(r.structure, new Set());
      if (r.mfcBatch && r.mfcBatch !== "Z") structRealBatches.get(r.structure)!.add(r.mfcBatch);
    }

    // Step 2: resolve each structure to a single batch key.
    const resolve = (struct: string): string => {
      if (!structInWip.has(struct)) return "__NP__";
      const real = structRealBatches.get(struct) ?? new Set<string>();
      return real.size === 1 ? [...real][0] : "Z";
    };

    // Step 3: aggregate OR figures per resolved batch.
    const m = new Map<string, OrAgg>();
    for (const r of orderRows) {
      const key = resolve(r.structure);
      const agg = m.get(key) ?? empty();
      agg.wo += r.woOrderQtyMt ?? 0;
      agg.rel += r.releaseMt ?? 0;
      agg.disp += r.fileDespatchMt ?? 0;
      agg.fileBalRelease += r.fileBalReleaseMt ?? 0;
      agg.fg += r.fileGalvMt != null ? r.fileGalvMt - (r.fileDespatchMt ?? 0) : 0;
      m.set(key, agg);
    }
    return m;
  }, [orderRows, records]);

  // Drill-down state. TLT: Project -> MFC (only) -> Structure (collapsible
  // marks). NTLT has no MFC concept, so it goes straight to Structure level.
  // view-by-mfc mode: Batch (already selected) -> Project -> Structure.
  const [selectedMfc, setSelectedMfc] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const atMfcListLevel = !isNtlt && selectedMfc === null && mfcViewMode !== "view-by-mfc";

  const emptyPhases = () =>
    Object.fromEntries(
      PROCESS_PHASES.map((p) => [p.key, { marks: 0, weight: 0 }]),
    ) as Record<ProcessPhaseKey, { marks: number; weight: number }>;

  // Step 1 (TLT only): MFC batch rollups for the whole project. No filters,
  // no marks table -- deliberately just the MFC list per the requested UX.
  const byMfc = useMemo(() => {
    if (isNtlt) return [];
    const groups = new Map<string, any[]>();
    for (const r of records) {
      const k = mfcVal(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return Array.from(groups.entries())
      .map(([batch, recs]) => {
        const aged = recs.filter((r) => r.ageingDays !== null);
        const phases = emptyPhases();
        for (const r of recs) {
          const wipCase = classifyWipCase(r);
          if (wipCase === "AWAITING_ASSIGNMENT") {
            phases.awaitingAssignment.marks += 1;
            phases.awaitingAssignment.weight += r.balanceWt;
          } else if (wipCase === "CUTTING") {
            phases.cutting.marks += 1;
            phases.cutting.weight += r.balanceWt;
          } else if (wipCase === "IN_PRODUCTION") {
            const key = processPhase(r.activity);
            if (key === "quality" || key === "galvanising") {
              phases[key].marks += 1;
              phases[key].weight += r.balanceWt;
            }
          } else if (wipCase === "FINISHED_GOODS") {
            phases.dispatch.marks += 1;
            phases.dispatch.weight += r.balanceWt;
          }
        }
        // Strip category prefix so the batch key matches the relBalByProjectBatch map.
        const rawJob = job.replace(/^(?:TLT|NTLT): /, "");
        return {
          batch,
          structures: new Set(recs.map((r) => r.structure).filter(Boolean)).size,
          marks: recs.length,
          qty: recs.reduce((s, r) => s + r.balanceQty, 0),
          weight: recs.reduce((s, r) => s + r.balanceWt, 0),
          phases,
          avgAge: aged.length
            ? Math.round(aged.reduce((s, r) => s + (r.ageingDays || 0), 0) / aged.length)
            : null,
          // Release balance for this specific batch — sourced from the DB table
          // that groups JCNS+Initial records by (import, project, structure, batch).
          releaseBalanceMt: relBalByProjectBatch.get(`${rawJob}::${batch}`) ?? 0,
        };
      })
      .sort((a, b) => a.batch.localeCompare(b.batch));
  }, [records, isNtlt, job, relBalByProjectBatch]);

  // Footer totals across all MFC rows.
  const mfcTotals = useMemo(() => {
    const phases = emptyPhases();
    let marks = 0, weight = 0;
    for (const m of byMfc) {
      marks += m.marks;
      weight += m.weight;
      for (const ph of PROCESS_PHASES) {
        phases[ph.key].marks += m.phases[ph.key].marks;
        phases[ph.key].weight += m.phases[ph.key].weight;
      }
    }
    return { marks, weight, phases };
  }, [byMfc]);

  // view-by-mfc: project rollups within the selected batch.
  const byProjectForBatch = useMemo(() => {
    if (mfcViewMode !== "view-by-mfc") return [];
    const groups = new Map<string, any[]>();
    for (const r of records) {
      const k = r.job || "(Unassigned)";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return Array.from(groups.entries())
      .map(([proj, recs]) => {
        const aged = recs.filter((r) => r.ageingDays !== null);
        const phases = emptyPhases();
        for (const r of recs) {
          const wipCase = classifyWipCase(r);
          if (wipCase === "AWAITING_ASSIGNMENT") {
            phases.awaitingAssignment.marks += 1;
            phases.awaitingAssignment.weight += r.balanceWt;
          } else if (wipCase === "CUTTING") {
            phases.cutting.marks += 1;
            phases.cutting.weight += r.balanceWt;
          } else if (wipCase === "IN_PRODUCTION") {
            const key = processPhase(r.activity);
            if (key === "quality" || key === "galvanising") {
              phases[key].marks += 1;
              phases[key].weight += r.balanceWt;
            }
          } else if (wipCase === "FINISHED_GOODS") {
            phases.dispatch.marks += 1;
            phases.dispatch.weight += r.balanceWt;
          }
        }
        return {
          proj,
          structures: new Set(recs.map((r) => r.structure).filter(Boolean)).size,
          marks: recs.length,
          qty: recs.reduce((s, r) => s + r.balanceQty, 0),
          weight: recs.reduce((s, r) => s + r.balanceWt, 0),
          phases,
          avgAge: aged.length
            ? Math.round(aged.reduce((s, r) => s + (r.ageingDays || 0), 0) / aged.length)
            : null,
        };
      })
      .sort((a, b) => a.proj.localeCompare(b.proj));
  }, [records, mfcViewMode]);

  // view-by-mfc — Project list level (batch already selected, pick a project).
  if (mfcViewMode === "view-by-mfc" && selectedProject === null) {
    const totalCols = 2 + headerPhases.length + 3;
    const totWt = byProjectForBatch.reduce((s, p) => s + p.weight, 0);
    const totMk = byProjectForBatch.reduce((s, p) => s + p.marks, 0);
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>
          <h2 className="text-xl font-bold tracking-tight truncate">{job}</h2>
        </div>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Select a project
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Structures</TableHead>
                    {headerPhases.map((ph) => (
                      <TableHead key={ph.key} className="text-right align-bottom">
                        <span className="block whitespace-normal leading-tight">{ph.label}</span>
                        <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                          wt / marks
                        </span>
                      </TableHead>
                    ))}
                    <TableHead className="text-right align-bottom">
                      <span className="block">Total</span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">wt / marks</span>
                    </TableHead>
                    <TableHead className="text-right">Avg Ageing</TableHead>
                    <TableHead className="w-6" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byProjectForBatch.map((p) => (
                    <TableRow
                      key={p.proj}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelectedProject(p.proj)}
                    >
                      <TableCell className="font-medium">{p.proj}</TableCell>
                      <TableCell className="text-right">{p.structures}</TableCell>
                      {headerPhases.map((ph) => {
                        if (ph.key === "dispatch") return <TableCell key={ph.key} className="text-right"><span className="text-muted-foreground">-</span></TableCell>;
                        const cell = p.phases[ph.key];
                        return (
                          <TableCell key={ph.key} className="text-right tabular-nums">
                            {cell.marks > 0 ? (
                              <>
                                <span className="font-bold">{formatWeight(cell.weight)}</span>
                                <span className="block text-xs text-muted-foreground">{cell.marks} marks</span>
                              </>
                            ) : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums bg-muted/30">
                        <span className="font-bold">{formatWeight(p.weight)}</span>
                        <span className="block text-xs text-muted-foreground">{p.marks} marks</span>
                      </TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(p.avgAge)}`}>
                        {p.avgAge !== null ? `${p.avgAge}d` : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground"><ChevronRight className="w-4 h-4" /></TableCell>
                    </TableRow>
                  ))}
                  {byProjectForBatch.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={totalCols} className="text-center py-4 text-muted-foreground">
                        No projects found for this batch.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                {byProjectForBatch.length > 0 && (
                  <TableFooter>
                    <TableRow className="border-t-2">
                      <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                      <TableCell />
                      {headerPhases.map((ph) => {
                        if (ph.key === "dispatch") return <TableCell key={ph.key}><span className="text-muted-foreground">-</span></TableCell>;
                        const wt = byProjectForBatch.reduce((s, p) => s + p.phases[ph.key].weight, 0);
                        const mk = byProjectForBatch.reduce((s, p) => s + p.phases[ph.key].marks, 0);
                        return (
                          <TableCell key={ph.key} className="text-right tabular-nums">
                            {mk > 0 ? <><span className="font-bold">{formatWeight(wt)}</span><span className="block text-xs text-muted-foreground">{mk} marks</span></> : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums bg-muted/50">
                        <span className="font-bold">{formatWeight(totWt)}</span>
                        <span className="block text-xs text-muted-foreground">{totMk} marks</span>
                      </TableCell>
                      <TableCell /><TableCell />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // view-by-mfc — drill into the selected project's structures.
  if (mfcViewMode === "view-by-mfc" && selectedProject !== null) {
    return (
      <StructureDrilldown
        job={selectedProject}
        label="Project"
        records={records.filter((r) => (r.job || "(Unassigned)") === selectedProject)}
        isNtlt={false}
        mfc={job}
        onBack={() => setSelectedProject(null)}
      />
    );
  }

  if (atMfcListLevel) {
    const totalCols = 4 + (orderEntry ? 4 : 0) + headerPhases.length + 3; // Release Balance + 4 OR cols + phases + Total/Age/Chevron
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>
          <h2 className="text-xl font-bold tracking-tight truncate">{label} {job}</h2>
        </div>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Select an MFC batch
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>MFC</TableHead>
                    <TableHead className="text-right">Structures</TableHead>
                    <TableHead className="text-right align-bottom whitespace-normal max-w-[5rem] leading-tight">Release Balance</TableHead>
                    {orderEntry && (
                      <>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Work Order Qty</TableHead>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Qty</TableHead>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Balance</TableHead>
                      </>
                    )}
                    {headerPhases.map((ph) => (
                      <TableHead key={ph.key} className="text-right align-bottom">
                        <span className="block whitespace-normal leading-tight">{ph.label}</span>
                        <span className="block text-[10px] font-normal text-muted-foreground normal-case leading-tight max-w-[180px] ml-auto">
                          {ph.subLabel
                            ? `(${ph.subLabel})`
                            : ph.activities.length
                              ? `(${ph.activities.join(", ")})`
                              : "-"}
                        </span>
                        <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                          wt / marks
                        </span>
                      </TableHead>
                    ))}
                    <TableHead className="text-right align-bottom">
                      <span className="block whitespace-nowrap">Total</span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                        wt / marks
                      </span>
                    </TableHead>
                    <TableHead className="text-right">Avg Ageing</TableHead>
                    <TableHead className="w-6" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byMfc.map((m) => {
                    const moe = orderByMfc.get(m.batch);
                    return (
                    <TableRow
                      key={m.batch}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelectedMfc(m.batch)}
                    >
                      <TableCell className="font-mono font-medium">{m.batch}</TableCell>
                      <TableCell className="text-right">{m.structures}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.releaseBalanceMt > 0
                          ? formatWeight(m.releaseBalanceMt * 1000)
                          : <span>{m.releaseBalanceMt.toFixed(3)}</span>}
                      </TableCell>
                      {orderEntry && (() => {
                        // OR figures split by batch using the structure→batch map.
                        // Zero shown as "0.0t" to distinguish from "—" (N/A).
                        const orD = orderByMfc.get(m.batch);
                        const fmtOr = (v: number | undefined): React.ReactNode =>
                          v === undefined
                            ? <span className="text-muted-foreground">—</span>
                            : v === 0
                              ? <span>0.0t</span>
                              : <span>{formatWeight(v * 1000)}</span>;
                        return (
                          <>
                            <TableCell className="text-right tabular-nums">{fmtOr(orD?.wo)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtOr(orD?.disp)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {orD !== undefined ? fmtOr((orD.wo ?? 0) - (orD.disp ?? 0)) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmtOr(orD?.fg)}</TableCell>
                          </>
                        );
                      })()}
                      {PROCESS_PHASES.map((ph) => {
                        if (ph.key === "dispatch") {
                          // FG WIP (Finished Goods) is pool-derived per batch —
                          // phases.dispatch is populated by classifyWipCase = FINISHED_GOODS.
                          const fgWt = m.phases.dispatch.weight;
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              {fgWt > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(fgWt)}</span>
                                  <span className="block text-xs text-muted-foreground">{m.phases.dispatch.marks} marks</span>
                                </>
                              ) : (
                                <span>{(fgWt / 1000).toFixed(3)}</span>
                              )}
                            </TableCell>
                          );
                        }
                        const cell = m.phases[ph.key];
                        return (
                          <TableCell key={ph.key} className="text-right tabular-nums">
                            {cell.marks > 0 ? (
                              <>
                                <span className="font-bold">{formatWeight(cell.weight)}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {cell.marks} marks
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums bg-muted/30">
                        <span className="font-bold">{formatWeight(m.weight)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {m.marks} marks
                        </span>
                      </TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(m.avgAge)}`}>
                        {m.avgAge !== null ? `${m.avgAge}d` : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <ChevronRight className="w-4 h-4" />
                      </TableCell>
                    </TableRow>
                  ); })}
                  {/* No marks in WIP row — OR structures with no WIP marks in this import.
                      WIP columns are blank by definition; only the four OR columns are filled. */}
                  {orderEntry && orderByMfc.has("__NP__") && (() => {
                    const np = orderByMfc.get("__NP__")!;
                    const fmtOr = (v: number): React.ReactNode =>
                      v === 0 ? <span>0.0t</span> : <span>{formatWeight(v * 1000)}</span>;
                    return (
                      <TableRow className="text-muted-foreground italic">
                        <TableCell className="font-mono text-xs" title="Order Review structures with no marks in this WIP import. MFC batch is recorded only on WIP mark rows, so these structures carry no batch.">No marks in WIP</TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell className="text-right tabular-nums">{fmtOr(np.wo)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtOr(np.disp)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtOr(np.wo - np.disp)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtOr(np.fg)}</TableCell>
                        {PROCESS_PHASES.map((ph) => <TableCell key={ph.key} />)}
                        <TableCell />
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    );
                  })()}
                  {byMfc.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={totalCols} className="text-center py-4 text-muted-foreground">
                        No MFC batches found for this {label.toLowerCase()}.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                {byMfc.length > 0 && (
                  <TableFooter>
                    <TableRow className="border-t-2">
                      <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                      <TableCell />
                      <TableCell className="text-right tabular-nums font-bold">
                        {formatWeight(byMfc.reduce((s, m) => s + m.releaseBalanceMt, 0) * 1000)}
                      </TableCell>
                      {orderEntry && (() => {
                        // Footer OR totals: sum all batches including __NP__ so the
                        // total row equals the project row in the project-level view.
                        let totalWo = 0, totalDisp = 0, totalFg = 0;
                        for (const agg of orderByMfc.values()) {
                          totalWo += agg.wo;
                          totalDisp += agg.disp;
                          totalFg += agg.fg;
                        }
                        const fmtOr = (v: number): React.ReactNode =>
                          v === 0 ? <span>0.0t</span> : <span className="font-bold">{formatWeight(v * 1000)}</span>;
                        return (
                          <>
                            <TableCell className="text-right tabular-nums">{fmtOr(totalWo)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtOr(totalDisp)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtOr(totalWo - totalDisp)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtOr(totalFg)}</TableCell>
                          </>
                        );
                      })()}
                      {PROCESS_PHASES.map((ph) => {
                        if (ph.key === "dispatch") {
                          const fgWt = mfcTotals.phases.dispatch.weight;
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              {fgWt > 0 ? (
                                <>
                                  <span className="font-bold">{formatWeight(fgWt)}</span>
                                  <span className="block text-xs text-muted-foreground">{mfcTotals.phases.dispatch.marks} marks</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          );
                        }
                        const marks = mfcTotals.phases[ph.key].marks;
                        const weight = mfcTotals.phases[ph.key].weight;
                        return (
                          <TableCell key={ph.key} className="text-right tabular-nums">
                            {marks > 0 ? (
                              <>
                                <span className="font-bold">{formatWeight(weight)}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {marks} marks
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums bg-muted/50">
                        <span className="font-bold">{formatWeight(mfcTotals.weight)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {mfcTotals.marks} marks
                        </span>
                      </TableCell>
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <StructureDrilldown
      job={job}
      label={label}
      records={isNtlt ? records : records.filter((r) => mfcVal(r) === selectedMfc)}
      isNtlt={isNtlt}
      mfc={selectedMfc}
      onBack={() => (isNtlt ? onBack() : setSelectedMfc(null))}
    />
  );
}

// Step 2: Structure-level rollups (scoped to the selected MFC for TLT, or the
// whole project for NTLT which has no MFC level). Rows are collapsible --
// clicking a structure expands its individual marks inline.
function StructureDrilldown({
  job,
  label,
  records,
  isNtlt,
  mfc,
  onBack,
}: {
  job: string;
  label: string;
  records: any[];
  isNtlt: boolean;
  mfc: string | null;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const [contractor, setContractor] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<RecordSortKey>("activity");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const activityOptions = useMemo(
    () =>
      sortActivities(Array.from(new Set(records.map((r) => r.activity).filter(Boolean)))),
    [records],
  );
  const categoryMap = useContractorCategoryMap();
  const aliasMap = useContractorAliasMap();
  // Alias-aware dedup: variants that resolve to the same canonical key collapse
  // into one option (representative = canonical spelling when present in data).
  const contractorGroups = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of records) {
      const c = r.contractor;
      if (!c) continue;
      const key = resolveContractorKey(c, aliasMap);
      const existing = byKey.get(key);
      if (
        existing === undefined ||
        (normalizeContractorName(c) === key && normalizeContractorName(existing) !== key)
      ) {
        byKey.set(key, c);
      }
    }
    return buildContractorGroups(Array.from(byKey.values()).sort());
  }, [records, aliasMap]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (activity && r.activity !== activity) return false;
      if (!matchesContractorSelection(r.contractor, contractor, categoryMap, aliasMap)) return false;
      if (
        q &&
        ![r.structure, r.markId, r.activity, r.section].some((v) =>
          String(v ?? "").toLowerCase().includes(q),
        )
      )
        return false;
      return true;
    });
  }, [records, search, activity, contractor, categoryMap]);

  const secondaryNoun = isNtlt ? "sub-categories" : "structures";
  const totalQty = useMemo(() => filtered.reduce((s, r) => s + r.balanceQty, 0), [filtered]);
  const totalWt = useMemo(() => filtered.reduce((s, r) => s + r.balanceWt, 0), [filtered]);

  // Group into structure rollups; each holds its own sorted mark list for
  // inline expansion.
  const byStructure = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const r of filtered) {
      const k = r.structure || "-";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return Array.from(groups.entries())
      .map(([structure, recs]) => {
        const aged = recs.filter((r) => r.ageingDays !== null);
        return {
          structure,
          marks: recs,
          count: recs.length,
          qty: recs.reduce((s, r) => s + r.balanceQty, 0),
          weight: recs.reduce((s, r) => s + r.balanceWt, 0),
          avgAge: aged.length
            ? Math.round(aged.reduce((s, r) => s + (r.ageingDays || 0), 0) / aged.length)
            : null,
        };
      })
      .sort((a, b) => a.structure.localeCompare(b.structure));
  }, [filtered]);

  const toggleExpanded = (structure: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(structure)) next.delete(structure);
      else next.add(structure);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight truncate">
            {label} {job}
            {mfc && <span className="text-muted-foreground font-medium"> &middot; MFC {mfc}</span>}
          </h2>
          <p className="text-xs text-muted-foreground">
            {byStructure.length} {secondaryNoun} • {filtered.length.toLocaleString()} marks •{" "}
            {totalQty.toLocaleString()} pcs • <span className="font-bold text-foreground">{formatWeight(totalWt)}</span>
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search structure, mark, activity, section..."
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Activity
            </label>
            <SearchableSelect
              value={activity}
              onChange={setActivity}
              options={activityOptions}
              allLabel="All Activities"
              searchPlaceholder="Search activities..."
              disabled={activityOptions.length === 0}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Contractor
            </label>
            <SearchableSelect
              value={contractor}
              onChange={setContractor}
              groups={contractorGroups}
              allLabel="All Contractors"
              searchPlaceholder="Search contractors or types..."
            />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-end px-4 py-3 border-b">
            <SortControl value={sortBy} onChange={setSortBy} />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{isNtlt ? "Sub-category" : "Structure"}</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                  <TableHead className="w-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {byStructure.map((s) => {
                  const isOpen = expanded.has(s.structure);
                  const sortedMarks = sortRecords(s.marks, sortBy);
                  return (
                    <Fragment key={s.structure}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => toggleExpanded(s.structure)}
                      >
                        <TableCell className="font-medium whitespace-nowrap">{s.structure}</TableCell>
                        <TableCell className="text-right">{s.count}</TableCell>
                        <TableCell className="text-right">{s.qty.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{formatWeight(s.weight)}</TableCell>
                        <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(s.avgAge)}`}>
                          {s.avgAge !== null ? `${s.avgAge}d` : "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${s.structure}-detail`} className="bg-muted/20">
                          <TableCell colSpan={6} className="p-0">
                            <div className="overflow-x-auto">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="pl-8">Mark</TableHead>
                                    <TableHead>Activity</TableHead>
                                    <TableHead>Section</TableHead>
                                    <TableHead className="text-right">Qty</TableHead>
                                    <TableHead className="text-right">Wt</TableHead>
                                    <TableHead>Contractor</TableHead>
                                    <TableHead>Date</TableHead>
                                    <TableHead className="text-right">Ageing</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {sortedMarks.map((r) => (
                                    <TableRow key={r.id}>
                                      <TableCell className="pl-8 font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                                      <TableCell className="whitespace-nowrap">{r.activity || "-"}</TableCell>
                                      <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || "-"}</TableCell>
                                      <TableCell className="text-right">{r.balanceQty}</TableCell>
                                      <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                                      <TableCell className="text-xs whitespace-nowrap">{r.contractor || "-"}</TableCell>
                                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(r.assignDate)}</TableCell>
                                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                                        {ageingCell(r)}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {byStructure.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                      No marks found for this {label.toLowerCase()}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiTile({ title, value }: { title: string; value: string | number }) {
  return (
    <Card className="shadow-sm border-border">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 line-clamp-1">
          {title}
        </p>
        <p className="text-sm sm:text-base font-medium tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
