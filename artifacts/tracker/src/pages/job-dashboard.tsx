import { useState, useMemo, useEffect, Fragment, useCallback } from "react";
import { isActiveCutting } from "@/lib/ageing";
import {
  activityDisplayKey,
  compareActivity,
  sortActivities,
  processPhase,
  classifyWipCase,
  PROCESS_PHASES,
  processPhasesForMode,
  type ProcessPhaseKey,
} from "@workspace/domain";
import { useTracker, useContractorCategoryMap, useActiveJobSet, isNamedJobSetFilter, MULTI_JOBS_FILTER_VALUE, dateRangeWindow, type MfcViewMode } from "@/lib/store";
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatWeight, formatDate } from "@/lib/utils";
import { sortRecords, type RecordSortKey } from "@/lib/sort";
import { ChevronLeft, ChevronRight, ChevronDown, Search, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";
import { useToast } from "@/hooks/use-toast";

const ROW_CAP = 300;

type ProjectSortKey = "assignDate" | "project" | "weight" | "marks" | "ageing";

const PROJECT_SORT_OPTIONS: { id: ProjectSortKey; name: string }[] = [
  { id: "assignDate", name: "First Assign Date" },
  { id: "project", name: "Project wise" },
  { id: "weight", name: "Weight" },
  { id: "marks", name: "Marks" },
  { id: "ageing", name: "Avg Ageing" },
];

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
  // Phase column headers list mode-specific activity codes (TLT vs NTLT vs both).
  const headerPhases = processPhasesForMode(
    isAll ? "ALL" : isNtlt ? "NTLT" : "TLT",
  );
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
        return `${r.job || "Unknown"} / Batch ${mfcOf(r)}`;
    }
    const base = (rowIsNtlt(r) ? r.groupKey : r.job) || "Unknown";
    return isAll ? `${rowIsNtlt(r) ? "NTLT" : "TLT"}: ${base}` : base;
  };
  const secondaryOf = (r: { structure: string | null; ntltSubtype: string | null; category: string | null }) =>
    rowIsNtlt(r) ? r.ntltSubtype : r.structure;

  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [projectSort, setProjectSort] = useState<ProjectSortKey>("assignDate");

  const primaryLabel = isAll ? "Group" : isNtlt ? "Section"
    : mfcViewMode === "view-by-mfc" ? "MFC Batch"
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
            if (!activeJobSet.has(r.job ?? "")) return false;
          } else if (filters.job === MULTI_JOBS_FILTER_VALUE) {
            if (filters.selectedJobs.length > 0 && !filters.selectedJobs.includes(r.job ?? "")) return false;
          } else if (filters.job) {
            if (r.job !== filters.job) return false;
          }
        }
        if (!isNtlt && filters.mfcBatch && mfcOf(r) !== filters.mfcBatch) return false;
        return true;
      }),
    [records, isNtlt, filters.job, filters.selectedJobs, filters.section, filters.mfcBatch, activeJobSet, mfcViewMode],
  );

  // Date window from the global date-range preset/custom filter.
  const dateWindow = useMemo(
    () => (filters.dateRange ? dateRangeWindow(filters.dateRange) : null),
    [filters.dateRange],
  );
  const dateFrom = dateWindow?.start ? dateWindow.start.toISOString().slice(0, 10) : "";
  const dateTo = dateWindow?.end ? dateWindow.end.toISOString().slice(0, 10) : "";

  const categoryMap = useContractorCategoryMap();

  // Final filter: apply global activity + contractor + date range.
  const filtered = useMemo(
    () =>
      preFiltered.filter((r) => {
        if (filters.activity && r.activity !== filters.activity) return false;
        if (!matchesContractorSelection(r.contractor, filters.contractor ?? null, categoryMap)) return false;
        if (dateFrom && r.assignDate != null && String(r.assignDate) < dateFrom) return false;
        if (dateTo && r.assignDate != null && String(r.assignDate) > dateTo) return false;
        return true;
      }),
    [preFiltered, filters.activity, filters.contractor, dateFrom, dateTo, categoryMap],
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

      const byProject = Array.from(projGroups.entries()).map(([job, recs]) => {
        const phases = emptyPhases();
        for (const r of recs) {
          // Use classifyWipCase to apply the Type guard:
          //   CUTTING / AWAITING_ASSIGNMENT → Cutting bucket (pre-production, JCNS+Authorized)
          //   IN_PRODUCTION  → quality/galvanising by activity (Type="Job Card WIP")
          //   FINISHED_GOODS → dispatch bucket (regardless of activity code)
          //   NOT_RELEASED   → skip (counted as Release Balance, not here)
          // AWAITING_ASSIGNMENT → separate peer bucket (no contractor yet).
          // CUTTING            → contractor-assigned JCNS+Authorized work.
          // Each gets its own phase so Project Wise shows them as distinct columns.
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
            // Populates phases.dispatch so allPhasesWt reconciliation matches
            // totalWt; the UI FG column still reads fgWipForJob() from
            // parseSummary.
            phases.dispatch.marks += 1;
            phases.dispatch.weight += r.balanceWt;
          }
        }
        return {
        job,
        structures: new Set(recs.map((r) => secondaryOf(r)).filter(Boolean)).size,
        marks: recs.length,
        qty: recs.reduce((s, r) => s + r.balanceQty, 0),
        weight: recs.reduce((s, r) => s + r.balanceWt, 0),
        phases,
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
    // In project-then-mfc / view-by-mfc modes the primary key encodes the batch
    // (e.g. "911 / Batch A"). Alphabetical sort naturally keeps all batches of
    // the same project consecutive AND sorts batches A→B→C→Z within each project.
    if (!isAll && !isNtlt && mfcViewMode !== "project-with-mfc") {
      arr.sort((a, b) => a.job.localeCompare(b.job));
      return arr;
    }
    switch (projectSort) {
      case "project":
        arr.sort((a, b) => a.job.localeCompare(b.job));
        break;
      case "weight":
        arr.sort((a, b) => b.weight - a.weight);
        break;
      case "marks":
        arr.sort((a, b) => b.marks - a.marks);
        break;
      case "ageing":
        arr.sort((a, b) => (b.avgAge ?? -1) - (a.avgAge ?? -1));
        break;
      case "assignDate":
      default:
        // Earliest first assign date first; projects with no date sort last.
        arr.sort((a, b) => {
          if (a.firstAssign && b.firstAssign)
            return a.firstAssign < b.firstAssign
              ? -1
              : a.firstAssign > b.firstAssign
                ? 1
                : a.job.localeCompare(b.job);
          if (a.firstAssign) return -1;
          if (b.firstAssign) return 1;
          return a.job.localeCompare(b.job);
        });
        break;
    }
    return arr;
  }, [byProject, projectSort, isAll, isNtlt, mfcViewMode]);

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

  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const groupLabel = isAll ? "Group" : isNtlt ? "Section" : "Project";
      const sheets: XlsxSheet[] = [
        {
          name: `By ${groupLabel}`,
          columns: [
            { label: groupLabel, field: "job" },
            { label: "Work Order (MT)", field: "workOrderMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch (MT)", field: "dispatchMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch Balance (MT)", field: "dispatchBalanceMt", numeric: true, decimals: 3, total: true },
            { label: "Release Balance (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
            { label: "Release Balance Computed (MT)", field: "releaseBalanceComputedMt", numeric: true, decimals: 3, total: true },
            { label: "FG (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
            { label: "Awaiting Assignment Wt (MT)", field: "awaitingAssignmentWt", numeric: true, decimals: 3, total: true },
            { label: "Awaiting Assignment Marks", field: "awaitingAssignmentMarks", numeric: true, decimals: 0, total: true },
            { label: "Cutting Wt (MT)", field: "cuttingWt", numeric: true, decimals: 3, total: true },
            { label: "Cutting Marks", field: "cuttingMarks", numeric: true, decimals: 0, total: true },
            { label: "Quality Check Wt (MT)", field: "qualityWt", numeric: true, decimals: 3, total: true },
            { label: "Quality Check Marks", field: "qualityMarks", numeric: true, decimals: 0, total: true },
            { label: "Galvanising Wt (MT)", field: "galvanisingWt", numeric: true, decimals: 3, total: true },
            { label: "Galvanising Marks", field: "galvanisingMarks", numeric: true, decimals: 0, total: true },
            { label: "FG WIP Wt (MT)", field: "fgWipWt", numeric: true, decimals: 3, total: true },
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
          rows: sortedProjects.map((p) => ({
            job: p.job,
            workOrderMt: orderByJob.get(p.job)?.wo ?? 0,
            dispatchMt: orderByJob.get(p.job)?.disp ?? 0,
            dispatchBalanceMt: (orderByJob.get(p.job)?.wo ?? 0) - (orderByJob.get(p.job)?.disp ?? 0),
            releaseBalanceMt: orderByJob.get(p.job)?.fileBalRelease ?? 0,
            releaseBalanceComputedMt: relBalComputedByJob.get(p.job) ?? 0,
            computedFgMt: fgWipForJob(p.job) / 1000,
            awaitingAssignmentWt: p.phases.awaitingAssignment.weight / 1000,
            awaitingAssignmentMarks: p.phases.awaitingAssignment.marks,
            cuttingWt: p.phases.cutting.weight / 1000,
            cuttingMarks: p.phases.cutting.marks,
            qualityWt: p.phases.quality.weight / 1000,
            qualityMarks: p.phases.quality.marks,
            galvanisingWt: p.phases.galvanising.weight / 1000,
            galvanisingMarks: p.phases.galvanising.marks,
            fgWipWt: fgWipForJob(p.job) / 1000,
            totalWt: p.weight / 1000,
            marks: p.marks,
            qty: p.qty,
            avgAge: p.avgAge,
            firstAssign: p.firstAssign ?? "",
            structures: p.structures,
            c0to30: p.c0to30,
            c31to60: p.c31to60,
            c60Plus: p.c60Plus,
          })),
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
        `project_wise_${new Date().toISOString().slice(0, 10)}.xlsx`,
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
  }, [exporting, isAll, isNtlt, sortedProjects, orderByJob, relBalComputedByJob, byActivity, toast]);

  // Reconciliation guard: all marks must be accounted for in exactly one bucket.
  // bucketTotal = sum of all phase weights (including phases.dispatch for FG)
  //             + release balance (Initial Cutting marks, in kg).
  // Must equal totalWt (every record_pool row's balance weight × copies).
  // A persistent shortfall > 1 MT means some marks have no phase mapping;
  // a negative shortfall means phases double-counted a mark.
  // IMPORTANT: this hook must stay BEFORE the selectedJob early-return below to
  // satisfy React's Rules of Hooks (hooks must run on every render unconditionally).
  const reconciliationWarning = useMemo(() => {
    if (byProject.length === 0 || !relBalData?.rows) return null;
    const allPhasesWt = byProject.reduce(
      (s, p) =>
        s +
        Object.values(p.phases).reduce((ps, ph) => ps + ph.weight, 0),
      0,
    );
    const relBalKg = byProject.reduce(
      (s, p) => s + (relBalComputedByJob.get(p.job) ?? 0) * 1000,
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
        records={records.filter((r) => primaryOf(r) === selectedJob)}
        onBack={() => setSelectedJob(null)}
        headerPhases={headerPhases}
        orderEntry={orderByJob.get(selectedJob)}
        orderRows={order?.rows?.filter((r) => r.project === rawJob) ?? []}
        mfcViewMode={mfcViewMode}
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
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase whitespace-nowrap">
              Sort by
            </label>
            <Select
              value={projectSort}
              onValueChange={(v) => setProjectSort(v as ProjectSortKey)}
            >
              <SelectTrigger className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Release Balance</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Release Balance Computed</TableHead>
                  <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">FG (MT)</TableHead>
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
                {sortedProjects.map((p) => {
                  const o = orderByJob.get(p.job);
                  return (
                  <TableRow
                    key={p.job}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelectedJob(p.job)}
                  >
                    <TableCell className="font-bold text-primary">{p.job}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o ? formatWeight(o.wo * 1000) : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o ? formatWeight(o.disp * 1000) : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o ? formatWeight((o.wo - o.disp) * 1000) : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o ? formatWeight(o.fileBalRelease * 1000) : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(() => { const v = relBalComputedByJob.get(p.job); return v ? formatWeight(v * 1000) : <span className="text-muted-foreground">-</span>; })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(() => { const v = o?.computedFg; return v != null && v !== 0 ? formatWeight(v * 1000) : <span className="text-muted-foreground">-</span>; })()}
                    </TableCell>
                    {PROCESS_PHASES.map((ph) => {
                      if (ph.key === "dispatch") {
                        const wt = fgWipForJob(p.job);
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
                })}
                {byProject.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={PROCESS_PHASES.length + 8} className="text-center py-4 text-muted-foreground">
                      No data for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {byProject.length > 0 && (
                <TableFooter>
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.wo * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.disp * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight((orderTotals.wo - orderTotals.disp) * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderTotals.fileBalRelease * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{formatWeight(byProject.reduce((s, p) => s + (relBalComputedByJob.get(p.job) ?? 0), 0) * 1000)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{orderTotals.computedFg !== 0 ? formatWeight(orderTotals.computedFg * 1000) : <span className="text-muted-foreground">-</span>}</TableCell>
                    {PROCESS_PHASES.map((ph) => {
                      if (ph.key === "dispatch") {
                        const totalFgWt = byProject.reduce((s, p) => s + fgWipForJob(p.job), 0);
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
}: {
  job: string;
  label: string;
  records: any[];
  onBack: () => void;
  headerPhases?: typeof PROCESS_PHASES;
  orderEntry?: { wo: number; rel: number; disp: number; fileBalRelease: number };
  orderRows?: Array<{ structure: string; weightMt: number | null; woOrderQtyMt: number | null; releaseMt: number | null; fileDespatchMt: number | null; fileBalReleaseMt: number | null }>;
  mfcViewMode?: MfcViewMode;
}) {
  const jobIsNtlt = records.some((r) => (r.category || "TLT") === "NTLT");
  const isNtlt = jobIsNtlt;
  const mfcVal = (r: { mfcBatch?: string | null }) => r.mfcBatch || "Z";

  // Per-MFC order figures: map structure → mfcBatch using WIP records, then
  // sum woOrderQtyMt / releaseMt / fileDespatchMt per mfc batch.
  const orderByMfc = useMemo(() => {
    if (!orderRows.length) return new Map<string, { wo: number; rel: number; disp: number; fileBalRelease: number }>();
    const structToMfc = new Map<string, string>();
    for (const r of records) {
      if (r.structure && !structToMfc.has(r.structure)) {
        structToMfc.set(r.structure, mfcVal(r));
      }
    }
    const m = new Map<string, { wo: number; rel: number; disp: number; fileBalRelease: number }>();
    for (const r of orderRows) {
      const mfc = structToMfc.get(r.structure) ?? "Z";
      const agg = m.get(mfc) ?? { wo: 0, rel: 0, disp: 0, fileBalRelease: 0 };
      agg.wo += r.woOrderQtyMt ?? 0;
      agg.rel += r.releaseMt ?? 0;
      agg.disp += r.fileDespatchMt ?? 0;
      agg.fileBalRelease += r.fileBalReleaseMt ?? 0;
      m.set(mfc, agg);
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
        };
      })
      .sort((a, b) => a.batch.localeCompare(b.batch));
  }, [records, isNtlt]);

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
          <h2 className="text-xl font-bold tracking-tight truncate">Batch {job}</h2>
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
    const totalCols = 3 + (orderEntry ? 4 : 0) + headerPhases.length + 3;
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
                    {orderEntry && (
                      <>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Work Order Qty</TableHead>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Qty</TableHead>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Dispatch Balance</TableHead>
                        <TableHead className="text-right align-bottom whitespace-normal max-w-[4.5rem] leading-tight">Release Balance</TableHead>
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
                      {orderEntry && (
                        <>
                          <TableCell className="text-right tabular-nums">{formatWeight((moe?.wo ?? 0) * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatWeight((moe?.disp ?? 0) * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatWeight(((moe?.wo ?? 0) - (moe?.disp ?? 0)) * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatWeight((moe?.fileBalRelease ?? 0) * 1000)}</TableCell>
                        </>
                      )}
                      {PROCESS_PHASES.map((ph) => {
                        if (ph.key === "dispatch") {
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              <span className="text-muted-foreground">-</span>
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
                      {orderEntry && (
                        <>
                          <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderEntry.wo * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderEntry.disp * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums font-bold">{formatWeight((orderEntry.wo - orderEntry.disp) * 1000)}</TableCell>
                          <TableCell className="text-right tabular-nums font-bold">{formatWeight(orderEntry.fileBalRelease * 1000)}</TableCell>
                        </>
                      )}
                      {PROCESS_PHASES.map((ph) => {
                        if (ph.key === "dispatch") {
                          return (
                            <TableCell key={ph.key} className="text-right tabular-nums">
                              <span className="text-muted-foreground">-</span>
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
  const contractorGroups = useMemo(
    () =>
      buildContractorGroups(
        Array.from(
          new Set(records.map((r) => r.contractor).filter(Boolean)),
        ).sort(),
      ),
    [records],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (activity && r.activity !== activity) return false;
      if (!matchesContractorSelection(r.contractor, contractor, categoryMap)) return false;
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
