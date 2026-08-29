import React, { useMemo, useState, Fragment, useEffect } from "react";
import { useListImports, useGetImportRecords, useDeleteImport, useDeleteAllImports, useDeleteOrderImport, getListImportsQueryKey, getGetImportRecordsQueryKey, useGetOrderStatus, getGetOrderStatusQueryKey, getGetMilestonesQueryKey, useAdminRecompute, useGetReleaseBalance, getGetReleaseBalanceQueryKey, useGetAuthStatus, useListUsers, useCreateUser, useResetUserPassword, useUpdateUserRole, useDeleteUser, useGetUserActivity, useListDeletionLog, getGetAuthStatusQueryKey, getListUsersQueryKey, getGetUserActivityQueryKey, useListInventoryMfcBatchColors, getListInventoryMfcBatchColorsQueryKey, useUpsertInventoryMfcBatchColor, useDeleteInventoryMfcBatchColor, useGetInventoryBuckets, getGetInventoryBucketsQueryKey, useGetImportProductionMovement, getGetImportProductionMovementQueryKey, useGetContractorMovement, useGetFabricationProjectCompletionTlt, getGetFabricationProjectCompletionTltQueryKey, useListOrderReviewAnomalies, getListOrderReviewAnomaliesQueryKey, useUpdateOrderReviewAnomaly, type InventoryMfcBatchColor, type CommitResult, type DispatchReconciliationRow, type BalanceReconciliationRow, type AppUser, type UserSessionEntry, type OrderStatusRow, type Record as WipRecord, type ReleaseBalanceResponse, type OrderReviewAnomaly, type FabricationProjectCompletionRow } from "@workspace/api-client-react";

// ERP rules types are not part of the generated API contract (the endpoint is
// not in the OpenAPI spec); define them locally to avoid import errors.
type ErpRuleSampleRow = { project: string; structure: string; markNo: string; fields: Record<string, string | number | null> };
type ErpRuleResult = { id: string; label: string; pass: boolean; scope: "UNIVERSAL" | "TLT"; violatingRowCount: number; violatingWeightMt: number; sampleRows: ErpRuleSampleRow[]; notApplicable?: boolean };
type ErpRulesResponse = { rules: ErpRuleResult[]; asOnDate?: string | null; typeColumnMissing?: boolean };
import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor, useActiveJobSet, isNamedJobSetFilter, MULTI_JOBS_FILTER_VALUE, dateRangeWindow, type Filters } from "@/lib/store";
import { useProjectCompare } from "@/lib/projectSort";
import { buildOrderStatusRows } from "@/lib/order-status-rows";
import { useSettings } from "@/lib/settings";
import { useFgRows, type FgComputedRow } from "@/lib/fg";
import { activityDisplayKey, activityDisplayKeyForRecord, activityRank, bundleActivitySet, classifyWipCase, compareActivity, FAB_LOAD_SECTIONS, fabLoadColumnsForSection, lifecycleStatus, migrateTurnaroundSettings, normalizeActivity, routeIncludesOp, scopeFor, sequenceFor, contractorCategoryLabel, QC_ACTIVITY_SET, GALV_ACTIVITY_SET, PROCESS_SEQUENCE } from "@workspace/domain";
import { isActiveCutting, isAwaitingAssignment, isCutting } from "@/lib/ageing";
import { useVelocityInfo, velocityKey, VELOCITY_LABELS } from "@/lib/velocity";
import { useStalledInfo } from "@/lib/movement";
import { LIFECYCLE_LABELS } from "@/lib/turnaround";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileDown, CheckCircle2, Trash2, FileSpreadsheet, AlertTriangle, RefreshCw, PlusCircle, ChevronDown, ChevronRight, UserPlus, RotateCcw, ShieldCheck, Shield, History, CircleCheck, CircleX, Info, Pencil, Archive } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { createXlsxBlockGridFile, createXlsxFile, createXlsxSheetsFile, downloadZip, exportToXlsx, exportToJson, exportGenOrXlsx, exportTimestamp, exportToXlsxSheets, type DownloadableFile, type XlsxColumn, type XlsxGridBlock, type XlsxGridSheet, type XlsxSheet } from "@/lib/export";
import { formatDate, formatDateTime } from "@/lib/utils";
import { AiSanitizePanel } from "@/components/ai-sanitize-panel";
import { AiReviewPanel } from "@/components/ai-review-panel";
import { StagedUploadPanel } from "@/components/staged-upload-panel";
import { AccessDenied, LogoutButton } from "@/components/login-gate";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Segmented } from "@/components/ui/segmented";
import { ContractorSetupContent } from "@/pages/contractor-setup";
import { WarningParametersContent } from "@/pages/warning-parameters";
import { ThicknessContent } from "@/pages/thickness";
import { OrderReviewAnomalyRegister } from "@/components/order-review-anomaly-register";
import { StagingEvidenceRegister } from "@/components/staging-evidence-register";

// Most tabs are admin-only. Job Templates is visible to all roles so normal
// users can manage their own named job sets for the global filter.
// The /bucket-list-dates route is served by a dedicated standalone page
// (BucketListDatesPage) so non-admin users can view MFC dates separately.
const ALL_TABS: Array<{ path: string; label: string; disabled?: boolean; adminOnly?: boolean }> = [
  { path: "/data", label: "Data", adminOnly: true },
  { path: "/job-templates", label: "Job Templates" },
  { path: "/computed-fg", label: "Computed FG", adminOnly: true },
  { path: "/order-reconciliation", label: "Order Reconciliation", adminOnly: true },
  { path: "/release-balance", label: "Release Balance", adminOnly: true },
  { path: "/order-review-generated", label: "Order Review (Gen.)", adminOnly: true },
  { path: "/contractor-setup", label: "Contractor Setup", adminOnly: true },
  { path: "/warning-parameters", label: "Warning Parameters", adminOnly: true },
  { path: "/thickness", label: "Thickness", adminOnly: true },
  { path: "/data-check", label: "Data Check", adminOnly: true },
  { path: "/erp-rules", label: "ERP Rules", adminOnly: true },
  { path: "/bucket-list-dates", label: "Bucket List Dates" },
  { path: "/users", label: "Users", adminOnly: true },
];

export default function DataView() {
  const { data: authStatus } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey() },
  });
  const [location, setLocation] = useLocation();

  const isAdmin = authStatus?.role === "admin";
  const activeTab = ALL_TABS.find((t) => t.path === location);

  // Redirect non-admins away from admin-only tabs; allow /job-templates through.
  useEffect(() => {
    if (!authStatus) return;
    if (!isAdmin && (!activeTab || activeTab.adminOnly)) {
      setLocation("/job-templates");
    }
  }, [authStatus, isAdmin, activeTab, setLocation]);

  if (!authStatus) return null;
  // Block render until redirect resolves for admin-only tabs
  if (!isAdmin && activeTab?.adminOnly) return null;
  return <TabbedPage isAdmin={isAdmin} />;
}

function TabbedPage({ isAdmin }: { isAdmin: boolean }) {
  const [location, setLocation] = useLocation();
  const visibleTabs = ALL_TABS.filter((t) => isAdmin || !t.adminOnly);
  const active = visibleTabs.find((t) => t.path === location)?.path;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <Segmented
          value={active ?? ""}
          onChange={(v) => v && setLocation(v)}
          options={visibleTabs.map((t) => ({ value: t.path, label: t.label, disabled: t.disabled }))}
        />
      </div>

      {/* Content */}
      {active === "/job-templates" ? (
        <JobTemplatesContent />
      ) : active === "/computed-fg" ? (
        <ComputedFgContent />
      ) : active === "/order-reconciliation" ? (
        <OrderReconciliationContent />
      ) : active === "/release-balance" ? (
        <ReleaseBalanceContent />
      ) : active === "/order-review-generated" ? (
        <GeneratedOrderReviewContent />
      ) : active === "/contractor-setup" ? (
        <ContractorSetupContent />
      ) : active === "/warning-parameters" ? (
        <WarningParametersContent />
      ) : active === "/thickness" ? (
        <ThicknessContent />
      ) : active === "/data-check" ? (
        <DataCheckContent />
      ) : active === "/erp-rules" ? (
        <ErpRulesContent />
      ) : active === "/bucket-list-dates" ? (
        <BucketListDatesContent />
      ) : active === "/users" ? (
        <UsersContent />
      ) : active === "/data" ? (
        <DataViewContent />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Standalone Bucket List Dates page — accessible to all authenticated users
// (read-only for non-admins; server enforces admin on mutations).
// ---------------------------------------------------------------------------
export function BucketListDatesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bucket List Dates</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Client MFC dates and project start dates used as the Turnaround ageing baseline.
        </p>
      </div>
      <BucketListDatesContent />
    </div>
  );
}

function filterReleaseBalanceRows(
  data: ReleaseBalanceResponse | undefined,
  filters: Filters,
  namedJobSet: ReadonlySet<string>,
) {
  let activeJobSet: Set<string> | null = null;
  if (isNamedJobSetFilter(filters.job)) {
    activeJobSet = new Set([...namedJobSet].map((code) => code.includes(" - ") ? code.split(" - ")[0] : code));
  } else if (filters.selectedJobs.length > 0) {
    activeJobSet = new Set(filters.selectedJobs.map((code) => code.includes(" - ") ? code.split(" - ")[0] : code));
  } else if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) {
    activeJobSet = new Set([filters.job]);
  }
  const allRows = data?.rows ?? [];
  return activeJobSet ? allRows.filter((row) => activeJobSet.has(row.project ?? "")) : allRows;
}

const ZIP_FAB_SET = bundleActivitySet("TLT_FABRICATION") ?? new Set<string>();
const ZIP_YARD_SET = bundleActivitySet("YARD") ?? new Set<string>();
const ZIP_GALV_SET = new Set(
  [...(bundleActivitySet("GALVANIZING") ?? [])].filter((activity) => !ZIP_YARD_SET.has(activity)),
);

function buildActivityExportSheets(records: any[]): XlsxSheet[] {
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    if (isAwaitingAssignment(record)) continue;
    if (isCutting(record.activity) && !isActiveCutting(record)) continue;
    const activity = activityDisplayKeyForRecord(record);
    const list = grouped.get(activity) ?? [];
    list.push(record);
    grouped.set(activity, list);
  }
  const averageAge = (rows: any[]) => {
    const ageable = rows.filter((row) => row.ageingDays != null);
    return ageable.length
      ? Math.round(ageable.reduce((sum, row) => sum + row.ageingDays, 0) / ageable.length)
      : null;
  };
  const activities = [...grouped.keys()].sort(compareActivity);
  return [
    {
      name: "Activities",
      columns: [
        { label: "Activity", field: "activity" },
        { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
        { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
        { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
        { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
      ],
      rows: activities.map((activity) => {
        const rows = grouped.get(activity) ?? [];
        return {
          activity,
          marks: rows.length,
          qty: rows.reduce((sum, row) => sum + (row.balanceQty ?? 0), 0),
          weight: rows.reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
          avgAge: averageAge(rows),
        };
      }),
    },
    {
      name: "Marks",
      columns: [
        { label: "Activity", field: "activity" },
        { label: "Project", field: "job" },
        { label: "Structure", field: "structure" },
        { label: "Mark", field: "markId" },
        { label: "Section", field: "section" },
        { label: "Contractor", field: "contractor" },
        { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
        { label: "Balance Wt", field: "balanceWt", numeric: true, decimals: 2, total: true },
        { label: "Assign Date", field: "assignDate" },
        { label: "Last Production", field: "lastProductionDate" },
        { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
      ],
      rows: activities.flatMap((activity) =>
        (grouped.get(activity) ?? []).map((record) => ({
          activity,
          job: record.job,
          structure: record.structure,
          markId: record.markId,
          section: record.section,
          contractor: record.contractor,
          balanceQty: record.balanceQty,
          balanceWt: record.balanceWt,
          assignDate: record.assignDate ?? "",
          lastProductionDate: record.lastProductionDate ?? "",
          ageingDays: record.ageingDays,
        })),
      ),
    },
  ];
}

function buildContractorExportRows(records: any[], categoryMap: Parameters<typeof contractorCategoryFor>[1]) {
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    const rawName = record.contractor || "Unassigned";
    const name = rawName === "Unassigned"
      ? rawName
      : contractorCategoryFor(rawName, categoryMap).displayName || rawName;
    const list = grouped.get(name) ?? [];
    list.push(record);
    grouped.set(name, list);
  }
  return [...grouped.entries()].map(([name, rows]) => {
    const ageable = rows.filter((row) => row.ageingDays != null);
    return {
      name,
      marks: rows.length,
      projects: new Set(rows.map((row) => row.job).filter((job) => job && job !== "(Unassigned)")).size,
      qty: rows.reduce((sum, row) => sum + (row.balanceQty ?? 0), 0),
      weight: rows.reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
      fabLoad: rows.filter((row) => ZIP_FAB_SET.has((row.activity ?? "").toUpperCase()) &&
        (!isCutting(row.activity) || isActiveCutting(row) || isAwaitingAssignment(row)))
        .reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
      galvaLoad: rows.filter((row) => ZIP_GALV_SET.has((row.activity ?? "").toUpperCase()))
        .reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
      yardLoad: rows.filter((row) => ZIP_YARD_SET.has((row.activity ?? "").toUpperCase()))
        .reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
      avgAge: ageable.length
        ? Math.round(ageable.reduce((sum, row) => sum + row.ageingDays, 0) / ageable.length)
        : null,
    };
  }).sort((a, b) => b.weight - a.weight);
}

const CONTRACTOR_WORKLOAD_COLUMNS: XlsxColumn[] = [
  { label: "Contractor", field: "name" },
  { label: "Total Wt", field: "weight", numeric: true, decimals: 2, total: true },
  { label: "Projects", field: "projects", numeric: true, decimals: 0 },
  { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
  { label: "Fabrication Load", field: "fabLoad", numeric: true, decimals: 2, total: true },
  { label: "Galvanizing Load", field: "galvaLoad", numeric: true, decimals: 2, total: true },
  { label: "Yard Load", field: "yardLoad", numeric: true, decimals: 2, total: true },
  { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
];

function buildPlantOperationSheets(records: any[]): XlsxSheet[] {
  const fabricationRows = records
    .filter((record) => ZIP_FAB_SET.has((record.activity ?? "").toUpperCase()))
    .map((record) => ({
      project: record.job || "(Unassigned)",
      structure: record.structure || "",
      markId: record.markId,
      section: record.section || "",
      activity: record.activity || "",
      contractor: record.contractor || "Unassigned",
      holeOp: record.holeOperation === "PUNCHING" ? "Punching" : record.holeOperation === "DRILLING" ? "Drilling" : "Not set",
      thicknessMm: record.thicknessMm ?? null,
      qty: record.balanceQty,
      weight: record.balanceWt,
      ageingDays: record.ageingDays ?? null,
    }));
  const galvanizingByProjectContractor = new Map<string, any[]>();
  for (const record of records.filter((row) => (bundleActivitySet("GALVANIZING") ?? new Set()).has((row.activity ?? "").toUpperCase()))) {
    const key = `${record.job || "(Unassigned)"}\u0001${record.contractor || "Unassigned"}`;
    const list = galvanizingByProjectContractor.get(key) ?? [];
    list.push(record);
    galvanizingByProjectContractor.set(key, list);
  }
  const galvanizingRows = [...galvanizingByProjectContractor.entries()].flatMap(([key, rows]) => {
    const [project, contractor] = key.split("\u0001");
    const ageable = rows.filter((row) => row.ageingDays != null);
    return [{
      project,
      contractor,
      marks: rows.length,
      qty: rows.reduce((sum, row) => sum + (row.balanceQty ?? 0), 0),
      weight: rows.reduce((sum, row) => sum + (row.balanceWt ?? 0), 0),
      avgAge: ageable.length ? Math.round(ageable.reduce((sum, row) => sum + row.ageingDays, 0) / ageable.length) : null,
      totalThicknessMm: rows.reduce((sum, row) => sum + (row.thicknessMm ?? 0), 0),
    }];
  });
  return [
    {
      name: "Fabrication",
      columns: [
        { label: "Project", field: "project" }, { label: "Structure", field: "structure" },
        { label: "Mark ID", field: "markId" }, { label: "Section", field: "section" },
        { label: "Activity", field: "activity" }, { label: "Contractor", field: "contractor" },
        { label: "Hole Op.", field: "holeOp" }, { label: "Thickness (mm)", field: "thicknessMm", numeric: true, decimals: 1 },
        { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
        { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
        { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
      ],
      rows: fabricationRows,
    },
    {
      name: "Galvanization",
      columns: [
        { label: "Project", field: "project" }, { label: "Contractor", field: "contractor" },
        { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
        { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
        { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
        { label: "Avg Ageing (days)", field: "avgAge", numeric: true, decimals: 0 },
        { label: "Total Thickness (mm)", field: "totalThicknessMm", numeric: true, decimals: 0, total: true },
      ],
      rows: galvanizingRows,
    },
  ];
}

function buildDailyProductionMovementSheets(records: any[], movement: any, dateRange: string | null): XlsxSheet[] {
  const window = dateRange ? dateRangeWindow(dateRange) : null;
  const start = window?.start.toISOString().slice(0, 10);
  const end = window?.end.toISOString().slice(0, 10);
  const cuttingByDay = new Map<string, number>();
  for (const day of movement?.days ?? []) {
    if (day.cuttingOutputMt > 0) cuttingByDay.set(day.dayKey, day.cuttingOutputMt * 1000);
  }
  const today = new Date().toISOString().slice(0, 10);
  const dates = new Set<string>();
  for (const record of records) {
    const date = record.lastProductionDate as string | null;
    if (!date) continue;
    if (window ? date >= start! && date <= end! : date <= today) dates.add(date);
  }
  for (const date of cuttingByDay.keys()) {
    if (window ? date >= start! && date <= end! : date <= today) dates.add(date);
  }
  const moveDates = [...dates].sort().slice(-7);
  const grouped = new Map<string, any[]>();
  for (const record of records) {
    if (isCutting(record.activity) && !isActiveCutting(record) && !isAwaitingAssignment(record)) continue;
    const activity = activityDisplayKeyForRecord(record);
    const list = grouped.get(activity) ?? [];
    list.push(record);
    grouped.set(activity, list);
  }
  const activities = [...grouped.keys()].sort(compareActivity);
  const dateColumns: XlsxColumn[] = moveDates.map((date, index) => ({
    label: formatDate(date), field: `d${index}`, numeric: true, decimals: 3, total: true,
  }));
  const activityRows = activities.map((activity) => {
    const rows = grouped.get(activity) ?? [];
    const perDate = activity === "C"
      ? moveDates.map((date) => cuttingByDay.get(date) ?? 0)
      : moveDates.map((date) => rows.reduce((sum, row) =>
        row.lastProductionDate === date ? sum + (row.balanceWt ?? 0) : sum, 0));
    const row: Record<string, any> = { activity, total: perDate.reduce((sum, value) => sum + value, 0) };
    perDate.forEach((value, index) => { row[`d${index}`] = value > 0 ? value : null; });
    return row;
  });
  const activitySheets = activities.flatMap((activity) => {
    const rows = grouped.get(activity) ?? [];
    const byContractor = new Map<string, number[]>();
    for (const row of rows) {
      const index = moveDates.indexOf(row.lastProductionDate);
      if (index < 0) continue;
      const contractor = row.contractor || "(No Contractor)";
      const values = byContractor.get(contractor) ?? moveDates.map(() => 0);
      values[index] += row.balanceWt ?? 0;
      byContractor.set(contractor, values);
    }
    if (!byContractor.size) return [];
    return [{
      name: activity,
      columns: [
        { label: "Contractor", field: "contractor" },
        ...dateColumns,
        { label: "Total (MT)", field: "total", numeric: true, decimals: 3, total: true },
      ],
      rows: [...byContractor.keys()]
        .sort((left, right) => byContractor.get(right)!.reduce((sum, value) => sum + value, 0) -
          byContractor.get(left)!.reduce((sum, value) => sum + value, 0))
        .map((contractor) => {
          const values = byContractor.get(contractor)!;
          const row: Record<string, any> = { contractor, total: values.reduce((sum, value) => sum + value, 0) };
          values.forEach((value, index) => { row[`d${index}`] = value > 0 ? value : null; });
          return row;
        }),
    }];
  });
  return [{
    name: "Summary",
    columns: [
      { label: "Activity", field: "activity" },
      ...dateColumns,
      { label: "Total (MT)", field: "total", numeric: true, decimals: 3, total: true },
    ],
    rows: activityRows,
  }, ...activitySheets];
}

function buildSpeedOfExecutionSheets(records: any[], velocityItems: any[]): XlsxSheet[] {
  const visible = new Set(records.map((row) => velocityKey(row.markId, row.jobCardNo)));
  const items = velocityItems.filter((item) => visible.has(velocityKey(item.markId, item.jobCardNo)));
  const makeRollup = (field: "job" | "contractor" | "activity", stage = false) => {
    const grouped = new Map<string, { markCount: number; stalled: number; slow: number; gapSum: number; gapCount: number }>();
    for (const item of items) {
      const key = stage ? activityDisplayKey(item.activity) : (item[field] || (field === "contractor" ? "Unassigned" : "(Unassigned)"));
      const bucket = grouped.get(key) ?? { markCount: 0, stalled: 0, slow: 0, gapSum: 0, gapCount: 0 };
      bucket.markCount++;
      if (item.status === "stalled") bucket.stalled++;
      if (item.status === "slow") bucket.slow++;
      if (item.etaGap != null) { bucket.gapSum += item.etaGap; bucket.gapCount++; }
      grouped.set(key, bucket);
    }
    return [...grouped.entries()].map(([key, bucket]) => ({
      [field === "job" ? "project" : field]: key,
      markCount: bucket.markCount,
      stalled: bucket.stalled,
      slow: bucket.slow,
      avgEtaGap: bucket.gapCount ? bucket.gapSum / bucket.gapCount : null,
      stuckScore: bucket.markCount ? (bucket.stalled + 0.5 * bucket.slow) / bucket.markCount : 0,
    }));
  };
  const projects = makeRollup("job").sort((a, b) => b.stuckScore - a.stuckScore || b.stalled - a.stalled);
  const contractors = makeRollup("contractor").sort((a, b) => b.stuckScore - a.stuckScore || b.stalled - a.stalled);
  const stageBuckets = new Map<string, { markCount: number; stalled: number; slow: number; paceSum: number; paceCount: number }>();
  for (const item of items) {
    const activity = activityDisplayKey(item.activity);
    const bucket = stageBuckets.get(activity) ?? { markCount: 0, stalled: 0, slow: 0, paceSum: 0, paceCount: 0 };
    bucket.markCount++;
    if (item.status === "stalled") bucket.stalled++;
    if (item.status === "slow") bucket.slow++;
    if (item.daysPerStage != null) { bucket.paceSum += item.daysPerStage; bucket.paceCount++; }
    stageBuckets.set(activity, bucket);
  }
  const stages = [...stageBuckets.entries()]
    .map(([activity, bucket]) => ({
      activity,
      markCount: bucket.markCount,
      stalled: bucket.stalled,
      slow: bucket.slow,
      avgDaysPerStage: bucket.paceCount ? bucket.paceSum / bucket.paceCount : null,
    }))
    .sort((a, b) => compareActivity(a.activity, b.activity));
  return [
    { name: "Projects", columns: [
      { label: "Project", field: "project" }, { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
      { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true }, { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
      { label: "Avg ETA Gap", field: "avgEtaGap", numeric: true, decimals: 1 }, { label: "Stuck Score", field: "stuckScore", numeric: true, decimals: 2 },
    ], rows: projects },
    { name: "Contractors", columns: [
      { label: "Contractor", field: "contractor" }, { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
      { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true }, { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
      { label: "Avg ETA Gap", field: "avgEtaGap", numeric: true, decimals: 1 }, { label: "Stuck Score", field: "stuckScore", numeric: true, decimals: 2 },
    ], rows: contractors },
    { name: "Stages", columns: [
      { label: "Activity", field: "activity" }, { label: "Marks", field: "markCount", numeric: true, decimals: 0, total: true },
      { label: "Stalled", field: "stalled", numeric: true, decimals: 0, total: true }, { label: "Slow", field: "slow", numeric: true, decimals: 0, total: true },
      { label: "Avg Days/Stage", field: "avgDaysPerStage", numeric: true, decimals: 1 },
    ], rows: stages },
  ];
}

const ZIP_JOB_WISE_COLUMNS: XlsxColumn[] = [
  { label: "Mark No.", field: "markId" },
  { label: "Section", field: "section" },
  { label: "Length", field: "length", numeric: true, decimals: 2 },
  { label: "Width", field: "width", numeric: true, decimals: 2 },
  { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
  { label: "Balance Wt (MT)", field: "balanceWtMt", numeric: true, decimals: 3, total: true },
  { label: "Activity", field: "activity" },
  { label: "Contractor", field: "contractor" },
  { label: "Last Op Date", field: "lastProductionDate" },
  { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
  { label: "Lifecycle Status", field: "lifecycleStatus" },
  { label: "Stalled", field: "stalledLabel" },
  { label: "Velocity Status", field: "velocityStatusLabel" },
];

function buildJobWiseReportSheets(
  records: any[],
  settings: Parameters<typeof lifecycleStatus>[1],
  isStalled: (markId: string | null | undefined, jobCardNo: string | null | undefined) => boolean,
  velocityFor: (markId: string | null | undefined, jobCardNo: string | null | undefined) => any,
): XlsxSheet[] {
  const enriched = [...records]
    .sort((a, b) => compareActivity(a.activity, b.activity) || String(a.markId ?? "").localeCompare(String(b.markId ?? "")))
    .map((record) => {
      const status = lifecycleStatus(
        { activity: record.activity, ageingDays: record.ageingDays, scope: scopeFor(record), sequence: sequenceFor(record) },
        settings,
      );
      const velocity = velocityFor(record.markId, record.jobCardNo);
      const stalled = isStalled(record.markId, record.jobCardNo);
      return {
        ...record,
        balanceWtMt: record.balanceWt != null ? record.balanceWt / 1000 : null,
        lifecycleStatus: LIFECYCLE_LABELS[status.status],
        stalledLabel: stalled ? "Yes" : "",
        velocityStatusLabel: velocity
          ? VELOCITY_LABELS[velocity.status as keyof typeof VELOCITY_LABELS]
          : "",
      };
    });
  const byActivity = new Map<string, typeof enriched>();
  for (const row of enriched) {
    const activity = activityDisplayKeyForRecord(row);
    const rows = byActivity.get(activity) ?? [];
    rows.push(row);
    byActivity.set(activity, rows);
  }
  return [
    { name: "Summary", columns: ZIP_JOB_WISE_COLUMNS, rows: enriched },
    ...[...byActivity.entries()]
      .sort(([a], [b]) => compareActivity(a, b))
      .map(([activity, rows]) => ({ name: activity, columns: ZIP_JOB_WISE_COLUMNS, rows })),
  ];
}

const ZIP_FAB_LOAD_NOTE =
  "Note: the six load columns are not mutually exclusive. A mark still to be punched, drilled and bent appears in every applicable column, so column totals must not be summed to reconcile to a balance figure.";

function zipFabLoadMatch(section: string, column: string, record: any): boolean {
  const notReleased = classifyWipCase(record) === "NOT_RELEASED";
  if (section === "upcoming") {
    if (!notReleased) return false;
  } else {
    if (notReleased) return false;
    if (isCutting(record.activity) && !isActiveCutting(record) && !isAwaitingAssignment(record)) return false;
  }
  const activity = normalizeActivity(record.activity);
  const rank = activityRank(record.activity);
  const sectionType = record.sectionType;
  const holeOperation = record.holeOperation;
  if (section === "operational") {
    if (column === "welded") return activity === "W";
    if (column === "bending") return activity === "B";
    if (column === "anglePunch") return sectionType === "ANGLE" && activity === "RFI" && holeOperation === "PUNCHING";
    if (column === "drilling") return sectionType === "ANGLE" && activity === "RFI" && holeOperation === "DRILLING";
    if (column === "platePunch") return sectionType === "PLATE" && activity === "RFI" && holeOperation === "PUNCHING";
    return column === "plateDrill" && sectionType === "PLATE" && activity === "RFI" && holeOperation === "DRILLING";
  }
  if (column === "welded") return rank < activityRank("W") && routeIncludesOp(record.operation, "W");
  if (column === "bending") return rank < activityRank("B") && routeIncludesOp(record.operation, "B");
  if (column === "anglePunch") return sectionType === "ANGLE" && activity === "C" && holeOperation === "PUNCHING";
  if (column === "drilling") return sectionType === "ANGLE" && activity === "C" && holeOperation === "DRILLING";
  if (column === "platePunch") return sectionType === "PLATE" && activity === "C" && holeOperation === "PUNCHING";
  return column === "plateDrill" && sectionType === "PLATE" && activity === "C" && holeOperation === "DRILLING";
}

function buildFabricationLoadGridSheets(records: any[]): XlsxGridSheet[] {
  const grids = FAB_LOAD_SECTIONS.map((section) => {
    const blocks = fabLoadColumnsForSection(section.value).map((column) => {
      const totals = new Map<string, number>();
      for (const record of records) {
        if ((record.category || "TLT") !== "TLT" || !zipFabLoadMatch(section.value, column.value, record)) continue;
        const project = (record.job || "").trim();
        if (!project || project === "(Unassigned)") continue;
        totals.set(project, (totals.get(project) ?? 0) + (record.balanceWt ?? 0));
      }
      const rows = [...totals.entries()]
        .sort(([, left], [, right]) => right - left)
        .map(([project, weightKg]) => [project, Math.round(weightKg) / 1000]);
      return {
        title: column.label,
        headers: ["Project", "Wt (t)"],
        numeric: [false, true],
        decimals: 3,
        rows,
        totals: ["G. Total", rows.reduce((sum, row) => sum + Number(row[1]), 0)],
      } satisfies XlsxGridBlock;
    });
    return { label: section.label, blocks };
  });
  return [
    { name: "All", note: ZIP_FAB_LOAD_NOTE, sections: grids.map((grid) => ({ banner: grid.label.toUpperCase(), blocks: grid.blocks })) },
    ...grids.map((grid) => ({ name: grid.label, blocks: grid.blocks })),
  ];
}

const ZIP_FAB_COMPLETION_COLUMNS: XlsxColumn[] = [
  { label: "BOM Label", field: "bomLabel" },
  { label: "Sub-Type Group", field: "subTypeGroup" },
  { label: "Project", field: "project" },
  { label: "MFC Batch", field: "mfcBatch" },
  { label: "Release Balance Calc (MT)", field: "releaseBalanceCalcMt", numeric: true, decimals: 3, total: true },
  { label: "Awaiting Assignment Calc (MT)", field: "assignmentBalanceCalcMt", numeric: true, decimals: 3, total: true },
  { label: "Cutting Balance — C (MT)", field: "cuttingBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "HG Balance (MT)", field: "hgBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "RFI Balance (MT)", field: "rfiBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "NH Balance (MT)", field: "nhBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "B Balance (MT)", field: "bBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "HAB Balance (MT)", field: "habBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "W Balance (MT)", field: "wBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "Quality Check — Q (MT)", field: "qBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "Test/Sign-off — TS (MT)", field: "tsBalanceMt", numeric: true, decimals: 3, total: true },
  { label: "Total Fabrication Balance (MT)", field: "totalFabBalanceMt", numeric: true, decimals: 3, total: true },
];

function buildFabCompletionSheets(rows: FabricationProjectCompletionRow[]): XlsxSheet[] {
  const withTotal = rows
    .map((row) => ({
      ...row,
      mfcBatch: row.mfcBatch ?? "",
      totalFabBalanceMt:
        row.releaseBalanceCalcMt + row.assignmentBalanceCalcMt + row.cuttingBalanceMt + row.hgBalanceMt +
        row.rfiBalanceMt + row.nhBalanceMt + row.bBalanceMt + row.habBalanceMt + row.wBalanceMt + row.qBalanceMt,
    }))
    .sort((a, b) => a.bomLabel.localeCompare(b.bomLabel) || a.subTypeGroup.localeCompare(b.subTypeGroup) || a.project.localeCompare(b.project));
  const byBom = new Map<string, typeof withTotal>();
  for (const row of withTotal) {
    const group = byBom.get(row.bomLabel) ?? [];
    group.push(row);
    byBom.set(row.bomLabel, group);
  }
  return [
    { name: "Summary", columns: ZIP_FAB_COMPLETION_COLUMNS, rows: withTotal },
    ...[...byBom.entries()].map(([name, bomRows]) => ({ name, columns: ZIP_FAB_COMPLETION_COLUMNS, rows: bomRows })),
  ];
}

function buildContractorPerformanceSheets(entries: any[]): XlsxSheet[] {
  const dates = [...new Set(entries.map((entry) => entry.date).filter(Boolean))].sort();
  const contractors = [...new Set(entries.map((entry) => entry.contractor?.trim() || "Unassigned"))]
    .sort((a, b) => a.localeCompare(b));
  const summaryRows = contractors.map((contractor) => {
    const row: Record<string, string | number> = { contractor };
    for (const date of dates) {
      row[date] = entries
        .filter((entry) => (entry.contractor?.trim() || "Unassigned") === contractor && entry.date === date)
        .reduce((sum, entry) => sum + (entry.weightKg ?? 0) / 1000, 0);
    }
    row.total = dates.reduce((sum, date) => sum + Number(row[date] ?? 0), 0);
    return row;
  });
  const summaryColumns: XlsxColumn[] = [
    { label: "Contractor", field: "contractor" },
    ...dates.map((date) => ({ label: formatDate(date), field: date, numeric: true, decimals: 2, total: true })),
    { label: "Total (MT)", field: "total", numeric: true, decimals: 2, total: true },
  ];
  const detailColumns: XlsxColumn[] = [
    { label: "Date", field: "date" },
    { label: "Project", field: "project" },
    { label: "From Activity", field: "fromActivity" },
    { label: "To Activity", field: "toActivity" },
    { label: "Mark Count", field: "markCount", numeric: true, decimals: 0, total: true },
    { label: "Weight (MT)", field: "weightMt", numeric: true, decimals: 2, total: true },
  ];
  const detailRows = [...entries]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.project).localeCompare(String(b.project)))
    .map((entry) => ({ ...entry, date: formatDate(entry.date), weightMt: (entry.weightKg ?? 0) / 1000 }));
  return [
    { name: "Summary", columns: summaryColumns, rows: summaryRows },
    { name: "Detail", columns: detailColumns, rows: detailRows },
    ...contractors.map((contractor) => ({
      name: contractor,
      columns: detailColumns,
      rows: detailRows.filter((entry) => (entry.contractor?.trim() || "Unassigned") === contractor),
    })),
  ];
}

function DataViewContent() {
  const { data: imports = [], refetch, isLoading: importsLoading } = useListImports();
  const { data: orderStatus, isLoading: orderStatusLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });
  const { data: releaseBalance } = useGetReleaseBalance(undefined, {
    query: { queryKey: getGetReleaseBalanceQueryKey() },
  });
  const { available: fgAvailable, rows: fgRows } = useFgRows();
  const orderImports = orderStatus?.imports ?? [];
  const recentCumulativeOverrides = orderStatus?.recentCumulativeOverrides ?? [];
  const { data: deletionLog = [] } = useListDeletionLog();

  // Strict per-date pairing: an Order Review can only be uploaded for a date that
  // already has a committed WIP / Balance & Activity import. The pairing key is the
  // "As on" date parsed from each file (WIP falls back to its upload date). The
  // uploader pre-gate just requires at least one dated WIP to exist; the panel and
  // the server then enforce that the chosen Order Review's date matches a WIP date.
  const wipAsOnDates = new Set(
    imports.map((i) => i.asOnDate).filter((d): d is string => !!d),
  );
  const orderReviewLocked = wipAsOnDates.size === 0;
  const orderReviewLockedMessage =
    "Upload a WIP / Balance & Activity report and accept its checks first. An Order Review can only be uploaded for a date that already has a committed WIP report.";

  // Dates already taken (one import per date rule). Used by uploaders to gate file
  // selection before staging so the user learns about the conflict immediately.
  const takenWipDates = new Set(
    imports.map((i) => i.asOnDate).filter((d): d is string => !!d),
  );
  const takenOrDates = new Set(
    orderImports.map((o) => o.asOnDate).filter((d): d is string => !!d),
  );
  const { selectedImportId, setSelectedImportId, filters } = useTracker();
  // The shared store normally advances to imports[0], but its state update is
  // one render behind the list query. Use the newest loaded WIP immediately so
  // the Data-page exports cannot be clicked into a false "select an import"
  // state during that short handoff.
  const selectedImportIsAvailable =
    selectedImportId != null && imports.some((entry) => entry.id === selectedImportId);
  const effectiveImportId = selectedImportIsAvailable
    ? selectedImportId
    : imports[0]?.id ?? null;
  const activeJobSet = useActiveJobSet();
  const compareProjects = useProjectCompare();
  const [, setLocation] = useLocation();
  const deleteImport = useDeleteImport();
  const deleteAll = useDeleteAllImports();
  const deleteOrderImport = useDeleteOrderImport();
  const adminRecompute = useAdminRecompute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [exportingAllExcel, setExportingAllExcel] = useState(false);

  const handleRecompute = () => {
    adminRecompute.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "Recompute complete",
          description: `${res.classificationBackfilled.toLocaleString()} classification, ${res.holeOperationBackfilled.toLocaleString()} hole-operation rows backfilled. ${res.milestonesCount.toLocaleString()} milestones, ${res.contractorMovementEntries.toLocaleString()} contractor movement entries recomputed.`,
        });
        queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMilestonesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetOrderStatusQueryKey() });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Recompute failed", description: err?.message || "Unknown error" });
      },
    });
  };

  const { data: allRecords, isLoading: recordsLoading } = useGetImportRecords(effectiveImportId as number, {
    query: { enabled: !!effectiveImportId, queryKey: getGetImportRecordsQueryKey(effectiveImportId as number) }
  });
  const filteredRecords = useFilteredRecords(allRecords);
  const velocity = useVelocityInfo(effectiveImportId);
  const stalled = useStalledInfo(effectiveImportId);
  const { settings: rawTurnaroundSettings } = useSettings();
  const turnaroundSettings = useMemo(
    () => migrateTurnaroundSettings(rawTurnaroundSettings),
    [rawTurnaroundSettings],
  );
  const { data: productionMovement } = useGetImportProductionMovement(effectiveImportId as number, {
    query: {
      enabled: !!effectiveImportId,
      queryKey: getGetImportProductionMovementQueryKey(effectiveImportId as number),
    },
  });
  const { data: contractorMovement } = useGetContractorMovement();
  const { data: fabricationCompletion } = useGetFabricationProjectCompletionTlt(
    effectiveImportId ? { importId: effectiveImportId } : undefined,
    {
      query: {
        enabled: !!effectiveImportId,
        queryKey: getGetFabricationProjectCompletionTltQueryKey(
          effectiveImportId ? { importId: effectiveImportId } : undefined,
        ),
      },
    },
  );
  const zipOrderStatusRows = useMemo(
    () => buildOrderStatusRows({
      records: (allRecords ?? []) as WipRecord[],
      orderRows: orderStatus?.rows ?? [],
      filters,
      activeJobSet,
      compareProjects,
    }),
    [allRecords, orderStatus?.rows, filters, activeJobSet, compareProjects],
  );
  const zipReleaseBalanceRows = useMemo(
    () => filterReleaseBalanceRows(releaseBalance, filters, activeJobSet),
    [releaseBalance, filters, activeJobSet],
  );
  const contractorCategories = useContractorCategoryMap();
  const zipContractorMovementEntries = useMemo(() => {
    const bundle = filters.activity?.startsWith("bundle:")
      ? bundleActivitySet(filters.activity.slice("bundle:".length))
      : null;
    const dateWindow = dateRangeWindow(filters.dateRange);
    const start = dateWindow?.start.toISOString().slice(0, 10);
    const end = dateWindow?.end.toISOString().slice(0, 10);
    return (contractorMovement?.entries ?? [])
      .map((entry) => {
        const raw = entry.contractor?.trim();
        const contractor = raw
          ? contractorCategoryFor(raw, contractorCategories).displayName || raw
          : "Unassigned";
        return contractor === entry.contractor ? entry : { ...entry, contractor };
      })
      .filter((entry) => {
        if (entry.project === "(Unassigned)") return false;
        if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) {
          const matchesNamed = isNamedJobSetFilter(filters.job)
            ? activeJobSet.has(entry.project) || [...activeJobSet].some((key) => key.startsWith(`${entry.project} - `))
            : entry.project === filters.job;
          if (!matchesNamed) return false;
        }
        if (filters.selectedJobs.length && !filters.selectedJobs.some((key) => key === entry.project || key.startsWith(`${entry.project} - `))) return false;
        if (filters.contractor && entry.contractor !== filters.contractor) return false;
        if (filters.activity) {
          const from = String(entry.fromActivity ?? "").toUpperCase();
          const to = String(entry.toActivity ?? "").toUpperCase();
          if (bundle ? !bundle.has(from) && !bundle.has(to) : from !== filters.activity && to !== filters.activity) return false;
        }
        if (start && end && (entry.date < start || entry.date >= end)) return false;
        const search = filters.search.trim().toLowerCase();
        return !search || entry.project.toLowerCase().includes(search) || String(entry.contractor).toLowerCase().includes(search);
      });
  }, [contractorMovement?.entries, filters, activeJobSet, contractorCategories]);
  const zipFabCompletionRows = useMemo(() => {
    const rows = fabricationCompletion?.available ? fabricationCompletion.rows : [];
    if (isNamedJobSetFilter(filters.job)) {
      return rows.filter((row) => activeJobSet.has(row.project) || [...activeJobSet].some((key) => key.startsWith(`${row.project} - `)));
    }
    if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) return rows.filter((row) => row.project === filters.job);
    if (filters.selectedJobs.length) return rows.filter((row) => filters.selectedJobs.some((key) => key === row.project || key.startsWith(`${row.project} - `)));
    return rows;
  }, [fabricationCompletion, filters.job, filters.selectedJobs, activeJobSet]);

  const selectedImport = imports.find(s => s.id === effectiveImportId);
  const exportDataLoading =
    importsLoading ||
    orderStatusLoading ||
    recordsLoading ||
    !selectedImport ||
    !filteredRecords;

  const handleCommitted = (res: CommitResult) => {
    if (res.kind === "order-review") {
      const cl = res.orderReviewImport.changeLog;
      const s = res.orderReviewImport.summary;
      const description = cl
        ? `${cl.inserted.length.toLocaleString()} new, ${cl.updated.length.toLocaleString()} updated, ${cl.unchanged.toLocaleString()} unchanged${cl.flagged.length > 0 ? `, ${cl.flagged.length.toLocaleString()} not in this file` : ""}.${res.seeded > 0 ? ` ${res.seeded.toLocaleString()} dispatch keys seeded.` : ""}`
        : s
          ? `${s.rowsKept.toLocaleString()} order rows kept across ${s.projectsFound.toLocaleString()} projects.${res.seeded > 0 ? ` ${res.seeded.toLocaleString()} dispatch keys seeded.` : ""}`
          : "Order Review ingested.";
      toast({ title: "Order Review imported", description });
      queryClient.invalidateQueries({ queryKey: getGetOrderStatusQueryKey() });
      return;
    }
    const c = res.changeSet.counts;
    toast({
      title: "Import added",
      description: `${res.import.summary.rowsKept.toLocaleString()} rows kept. ${c.addedRows.toLocaleString()} new, ${c.completed.toLocaleString()} completed since the last upload.`,
    });
    refetch();
    // Don't pin to the new import ID here — the store is in "follow latest" mode
    // and will auto-advance to imports[0] once the list refreshes, avoiding the
    // race where the new ID isn't in the list yet and the effect resets to yesterday.
    queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOrderStatusQueryKey() });
    // Navigate straight to Project Wise after a WIP upload so the user
    // lands on the default report view immediately.
    setLocation("/jobs");
  };

  const handleDelete = (id: number) => {
    if (!confirm("Delete this import? Its membership is removed; the shared record pool is kept.")) return;
    deleteImport.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Import deleted" });
        refetch();
        if (selectedImportId === id) setSelectedImportId(null);
        queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["/api/imports/deletion-log"] });
      }
    });
  };

  const handleDeleteOrder = (id: number) => {
    if (!confirm("Delete this Order Review file? Rows last seen in this file will be removed from the current order book; rows last seen in other files stay. Dispatch entries with no remaining Order Review row are also removed. Historical values cannot be reconstructed after deletion.")) return;
    deleteOrderImport.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Order Review file deleted" });
        queryClient.invalidateQueries({ queryKey: getGetOrderStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["/api/imports/deletion-log"] });
      },
    });
  };

  const handleDeleteAll = () => {
    if (
      !confirm(
        "Delete ALL data? This permanently removes every import and the entire shared record pool. This cannot be undone. New data can be uploaded afterwards.",
      )
    )
      return;
    deleteAll.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "All data deleted",
          description: `${res.importsDeleted.toLocaleString()} imports and ${res.poolRowsDeleted.toLocaleString()} pool rows removed.`,
        });
        setSelectedImportId(null);
        refetch();
        queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Delete failed", description: err?.message || "Unknown error" });
      },
    });
  };

  const doExportExcel = () => {
    if (!filteredRecords?.length) {
      toast({ variant: "destructive", title: "No data to export" });
      return;
    }
    const enriched = filteredRecords.map((r) => {
      const info = contractorCategoryFor(r.contractor, contractorCategories);
      return {
        ...r,
        contractor_category: contractorCategoryLabel(info.category),
        out_vendor_type: info.outVendorType.join(";"),
      };
    });
    const cols: XlsxColumn[] = [
      { label: "Project", field: "job" },
      { label: "Structure", field: "structure" },
      { label: "Mark", field: "markId" },
      { label: "Section", field: "section" },
      { label: "Activity", field: "activity" },
      { label: "Contractor", field: "contractor" },
      { label: "Contractor Type", field: "contractor_category" },
      { label: "Out-vendor Type", field: "out_vendor_type" },
      { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
      { label: "Balance Wt", field: "balanceWt", numeric: true, decimals: 2, total: true },
      { label: "Assign Date", field: "assignDate" },
      { label: "Last Production", field: "lastProductionDate" },
      { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
    ];
    void exportToXlsx(
      `tracker_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
      cols,
      enriched,
      { sheetName: "Records" },
    );
  };

  const doExportJson = () => {
    if (!allRecords?.length) {
      toast({ variant: "destructive", title: "No data to export" });
      return;
    }
    const date = exportTimestamp();
    exportToJson(`import_${selectedImportId}_${date}.json`, { import: selectedImport, records: allRecords });
  };

  const handleExportAllExcel = async () => {
    if (exportDataLoading) {
      toast({
        variant: "destructive",
        title: "Loading latest data",
        description: "The latest WIP and Order Review data is still loading. Try again in a moment.",
      });
      return;
    }
    if (!filteredRecords.length) {
      toast({
        variant: "destructive",
        title: "No WIP records to export",
        description: "The selected WIP import has no records matching the active filters.",
      });
      return;
    }

    setExportingAllExcel(true);
    try {
      const timestamp = exportTimestamp();
      const files: DownloadableFile[] = [];
      const included: string[] = [];
      const unavailable: string[] = [];

      const enrichedRecords = filteredRecords.map((r) => {
        const info = contractorCategoryFor(r.contractor, contractorCategories);
        return {
          ...r,
          contractor_category: contractorCategoryLabel(info.category),
          out_vendor_type: info.outVendorType.join(";"),
        };
      });
      files.push(await createXlsxFile(
        `01_selected_wip_records_${timestamp}.xlsx`,
        [
          { label: "Project", field: "job" },
          { label: "Structure", field: "structure" },
          { label: "Mark", field: "markId" },
          { label: "Section", field: "section" },
          { label: "Activity", field: "activity" },
          { label: "Contractor", field: "contractor" },
          { label: "Contractor Type", field: "contractor_category" },
          { label: "Out-vendor Type", field: "out_vendor_type" },
          { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
          { label: "Balance Wt", field: "balanceWt", numeric: true, decimals: 2, total: true },
          { label: "Assign Date", field: "assignDate" },
          { label: "Last Production", field: "lastProductionDate" },
          { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
        ] satisfies XlsxColumn[],
        enrichedRecords,
        { sheetName: "Records" },
      ));
      included.push("Selected WIP records");

      const orderRows = zipOrderStatusRows;
      if (orderStatus?.available && orderRows.length > 0) {
        files.push(await createXlsxFile(
          `02_order_status_${timestamp}.xlsx`,
          [
            { label: "Project Code", field: "project" },
            { label: "Structure Type", field: "structure" },
            { label: "Sub Type", field: "subType" },
            { label: "Sets", field: "sets", numeric: true, decimals: 0 },
            { label: "Weight (MT)", field: "weightMt", numeric: true, decimals: 3, total: true },
            { label: "WO Order Qty (MT)", field: "woOrderQtyMt", numeric: true, decimals: 3, total: true },
            { label: "BOM Type", field: "bomType" },
            { label: "Release (MT)", field: "releaseMt", numeric: true, decimals: 3 },
            { label: "Release Balance (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
            { label: "Scope", field: "scope" },
            { label: "Fabrication (MT)", field: "fabMt", numeric: true, decimals: 3, total: true },
            { label: "Galvanizing (MT)", field: "galvMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch (MT)", field: "fileDespatchMt", numeric: true, decimals: 3, total: true },
            { label: "Dispatch Balance (MT)", field: "dispatchBalanceMt", numeric: true, decimals: 3, total: true },
          ] satisfies XlsxColumn[],
          orderRows.map((row) => ({
            ...row,
            subType: row.subType ?? "",
            sets: row.sets ?? "",
            weightMt: row.weightMt ?? "",
            woOrderQtyMt: row.woOrderQtyMt ?? "",
            bomType: row.bomType ?? "",
            releaseMt: row.releaseMt ?? "",
            releaseBalanceMt: row.releaseBalanceMt ?? "",
            scope: row.outOfScope ? "NTLT (out of scope)" : "TLT",
            fabMt: row.fabMt ?? "",
            galvMt: row.galvMt ?? "",
            fileDespatchMt: row.fileDespatchMt ?? "",
            dispatchBalanceMt: row.dispatchBalanceMt ?? "",
          })),
          { sheetName: "Order Status" },
        ));
        included.push("Order Status");
      } else {
        unavailable.push("Order Status (no committed Order Review data)");
      }

      const releaseRows = zipReleaseBalanceRows;
      if (releaseBalance?.available && releaseRows.length > 0) {
        files.push(await createXlsxFile(
          `03_release_balance_${timestamp}.xlsx`,
          [
            { label: "Project", field: "project" },
            { label: "Structure", field: "structure" },
            { label: "Release Balance Order Review (MT)", field: "releaseBalanceOrderReviewMt", numeric: true, decimals: 3, total: true },
            { label: "Release Balance Computed WIP (MT)", field: "releaseBalanceComputedMt", numeric: true, decimals: 3, total: true },
            { label: "Diff (MT)", field: "diffMt", numeric: true, decimals: 3, total: true },
          ] satisfies XlsxColumn[],
          releaseRows,
          { sheetName: "Release Balance" },
        ));
        included.push("Release Balance");
      } else {
        unavailable.push("Release Balance (not available for this WIP format)");
      }

      if (fgAvailable && fgRows.length > 0) {
        files.push(await createXlsxFile(
          `04_computed_fg_${timestamp}.xlsx`,
          [
            { label: "Project", field: "project" },
            { label: "Structure", field: "structure" },
            { label: "Release (MT)", field: "releaseMt", numeric: true, decimals: 3, total: true },
            { label: "File Despatch (MT)", field: "fileDespatchMt", numeric: true, decimals: 3, total: true },
            { label: "FG (Order Review) (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
            { label: "FG (WIP file) (MT)", field: "fgWipMt", numeric: true, decimals: 3, total: true },
          ] satisfies XlsxColumn[],
          fgRows,
          { sheetName: "Computed FG" },
        ));
        included.push("Computed FG");
      } else {
        unavailable.push("Computed FG (no matching WIP and Order Review data)");
      }

      const activitySheets = buildActivityExportSheets(filteredRecords);
      if (activitySheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `05_activity_wise_${timestamp}.xlsx`,
          activitySheets,
        ));
        included.push("Activity Wise");
      } else {
        unavailable.push("Activity Wise (no qualifying activity records)");
      }

      const contractorRows = buildContractorExportRows(filteredRecords, contractorCategories);
      if (contractorRows.length) {
        files.push(await createXlsxFile(
          `06_contractor_wise_${timestamp}.xlsx`,
          CONTRACTOR_WORKLOAD_COLUMNS,
          contractorRows,
          { sheetName: "Workload" },
        ));
        included.push("Contractor Wise");
      } else {
        unavailable.push("Contractor Wise (no qualifying contractor records)");
      }

      const plantSheets = buildPlantOperationSheets(filteredRecords);
      if (plantSheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `07_plant_operation_fabrication_${timestamp}.xlsx`,
          [plantSheets[0]],
        ));
        included.push("Plant Operation — Fabrication");
      } else {
        unavailable.push("Plant Operation — Fabrication (no TLT fabrication records)");
      }
      if (plantSheets[1]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `08_plant_operation_galvanization_${timestamp}.xlsx`,
          [plantSheets[1]],
        ));
        included.push("Plant Operation — Galvanization");
      } else {
        unavailable.push("Plant Operation — Galvanization (no galvanizing records)");
      }

      const dailyMovementSheets = buildDailyProductionMovementSheets(
        filteredRecords,
        productionMovement,
        filters.dateRange,
      );
      if (dailyMovementSheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `09_daily_production_movement_activity_wise_${timestamp}.xlsx`,
          dailyMovementSheets,
        ));
        included.push("Daily Production Movement — Activity Wise");
      } else {
        unavailable.push("Daily Production Movement — Activity Wise (no production dates)");
      }

      const speedSheets = buildSpeedOfExecutionSheets(filteredRecords, velocity.items);
      if (speedSheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `10_speed_of_execution_${timestamp}.xlsx`,
          speedSheets,
        ));
        included.push("Speed of Execution");
      } else {
        unavailable.push("Speed of Execution (no velocity history for this import)");
      }

      const jobWiseSheets = buildJobWiseReportSheets(
        filteredRecords,
        turnaroundSettings,
        stalled.isStalled,
        velocity.velocityFor,
      );
      if (jobWiseSheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `11_job_wise_report_${timestamp}.xlsx`,
          jobWiseSheets,
        ));
        included.push("Job Wise Report");
      } else {
        unavailable.push("Job Wise Report (no records match the active filters)");
      }

      const fabLoadSheets = buildFabricationLoadGridSheets(filteredRecords);
      const fabLoadHasRows = fabLoadSheets.some((sheet) =>
        sheet.sections?.some((section) => section.blocks.some((block) => block.rows.length > 0)),
      );
      if (fabLoadHasRows) {
        files.push(await createXlsxBlockGridFile(
          `12_fabrication_load_tlt_${timestamp}.xlsx`,
          fabLoadSheets,
        ));
        included.push("Fabrication Load for TLT");
      } else {
        unavailable.push("Fabrication Load for TLT (no qualifying TLT fabrication records)");
      }

      const contractorPerformanceSheets = buildContractorPerformanceSheets(zipContractorMovementEntries);
      if (zipContractorMovementEntries.length) {
        files.push(await createXlsxSheetsFile(
          `13_contractor_performance_${timestamp}.xlsx`,
          contractorPerformanceSheets,
        ));
        included.push("Contractor Performance");
      } else {
        unavailable.push("Contractor Performance (no movement-ledger entries match the active filters)");
      }

      const fabCompletionSheets = buildFabCompletionSheets(zipFabCompletionRows);
      if (fabCompletionSheets[0]?.rows?.length) {
        files.push(await createXlsxSheetsFile(
          `14_fabrication_completion_tlt_${timestamp}.xlsx`,
          fabCompletionSheets,
        ));
        included.push("Fabrication Report – Project Completion - TLT");
      } else {
        unavailable.push("Fabrication Report – Project Completion - TLT (not available for this WIP format or job filter)");
      }

      files.push({
        filename: "README.txt",
        bytes: new TextEncoder().encode([
          "Balance & Activity Tracker — Excel export bundle",
          `Created: ${new Date().toLocaleString()}`,
          `Selected WIP import: ${selectedImport.label || selectedImport.sourceFilename}`,
          "",
          "Included workbooks:",
          ...included.map((name) => `- ${name}`),
          "",
          "Not available at export time:",
          ...(unavailable.length ? unavailable.map((name) => `- ${name}`) : ["- None"]),
          "",
          "ZIP defaults:",
          "- All WIP-based workbooks use the active global filters.",
           "- Every workbook includes a TOTAL row: sum only the data rows or read the TOTAL cell, never both. A whole-column SUM (for example, SUM(F:F)) includes the TOTAL row and doubles the result.",
           "- Activity Wise reports Balance Wt in kilograms, matching the raw WIP file; Project Wise uses metric tonnes (MT).",
           "- Activity Wise includes process-stage records and Finished Goods (blank Activity), but intentionally excludes Release Balance and Awaiting Assignment; its C row is active Cutting only.",
           "- Fabrication Load has six intentionally overlapping operation columns. A mark can appear in more than one column, so do not add the six column totals to reconcile against a WIP balance.",
          "- Job Wise uses Activity sorting and includes its lifecycle, stalled, and velocity columns.",
          "- Fabrication Load uses its default weight-descending order; saved priority order is not applied.",
          "- Contractor Performance applies the global filters that a movement ledger can represent (job, contractor, activity, date, search).",
          "- Fabrication Completion includes all projects in the active job scope and the standard expanded stage columns.",
          "- Plant Operation uses the all-sections / all-operations defaults, within the active global filters.",
          "",
          "Not included because they do not provide an Excel workbook on the Reports page:",
          "- Project Wise (Order Type and MFC display mode)",
          "- Bucket List (MFC colour assignment and temporary hidden-project state)",
          "- Activity Wise Net Balance Movement and Contractor Wise Net Balance Movement (history-window selection)",
          "- Turnaround (warning-parameter settings)",
          "",
          "Their individual Excel downloads remain available on the corresponding report pages.",
        ].join("\n")),
      });

      downloadZip(`tracker_excel_exports_${timestamp}.zip`, files);
      toast({
        title: "Excel ZIP downloaded",
        description: `${included.length} workbook${included.length === 1 ? "" : "s"} included${unavailable.length ? `; ${unavailable.length} unavailable report${unavailable.length === 1 ? "" : "s"} listed in README` : ""}.`,
      });
    } catch (error) {
      console.error("[Export] Excel ZIP failed", error);
      toast({
        variant: "destructive",
        title: "Excel ZIP export failed",
        description: error instanceof Error ? error.message : "The archive could not be created.",
      });
    } finally {
      setExportingAllExcel(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Data</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportAllExcel()}
            disabled={exportingAllExcel || exportDataLoading}
            className="h-8 gap-2"
          >
            <Archive className={`w-4 h-4 ${exportingAllExcel ? "animate-pulse" : ""}`} />
            {exportingAllExcel
              ? "Building ZIP..."
              : exportDataLoading
                ? "Loading latest data..."
                : "Export all Excel files"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRecompute}
            disabled={adminRecompute.isPending}
            className="h-8 gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${adminRecompute.isPending ? "animate-spin" : ""}`} />
            {adminRecompute.isPending ? "Recomputing..." : "Recompute"}
          </Button>
          <LogoutButton />
        </div>
      </div>
      <div className="bg-primary/10 border border-primary/20 rounded-md p-4 flex gap-4 text-sm items-start">
        <div className="text-primary mt-0.5 font-bold">i</div>
        <p className="text-primary-foreground/90 font-medium">
          Every upload is added as a new import. Rows are kept as-is (in-sheet duplicates included) and deduplicated only across uploads. Ageing is computed live (today − Last Production Entry Date).
        </p>
      </div>

      <CutoffCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <StagedUploadPanel
          expectedType="wip"
          onCommitted={handleCommitted}
          takenDates={takenWipDates}
        />
        <StagedUploadPanel
          expectedType="order-review"
          onCommitted={handleCommitted}
          locked={orderReviewLocked}
          lockedMessage={orderReviewLockedMessage}
          allowedDates={wipAsOnDates}
          takenDates={takenOrDates}
        />
      </div>

      <ItemMasterUploadCard />

      {selectedImportId && <AiSanitizePanel importId={selectedImportId} />}

      {selectedImportId && (
        <div className="space-y-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">AI Review</h2>
            <p className="text-muted-foreground text-sm mt-1">
              An advisory audit of the computed results for the selected import. The deterministic
              engine remains the source of truth; AI findings are suggestions only.
            </p>
          </div>
          <AiReviewPanel importId={selectedImportId} />
        </div>
      )}

      {selectedImport && !selectedImport.hasTypeData && (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 p-3 flex gap-2 items-start">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 dark:text-amber-300">
            <span className="font-semibold">Classification data not available for this import.</span>{" "}
            This file was uploaded before per-row Type/Status tracking was added.
            WIP bucket figures (Initial, TS, Galvanising, etc.) cannot be computed for this import.
            Re-upload the source WIP file to restore full classification.
          </div>
        </div>
      )}

      {selectedImport && (
        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
              Current Parse Summary
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={doExportExcel} className="h-8 gap-2">
                  <FileSpreadsheet className="w-4 h-4" /> Excel (Filtered)
                </Button>
                <Button variant="outline" size="sm" onClick={doExportJson} className="h-8 gap-2">
                  <FileDown className="w-4 h-4" /> JSON (Raw)
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Rows Read</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.rowsRead.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Rows Kept</span>
                <span className="font-bold text-lg tabular-nums text-primary">{selectedImport.summary.rowsKept.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Distinct Rows</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.distinctRows.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Duplicate Copies</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.duplicateRowCopies.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Projects Found</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.projectsFound}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Missing Contractor</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.missingContractor}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Missing Date</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.missingDate}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Not Started (C)</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.notStarted.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">No Production Date</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.noProductionDate.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Future Prod. Date</span>
                <span className="font-bold text-lg tabular-nums">{selectedImport.summary.futureProductionDate.toLocaleString()}</span>
              </div>
              {selectedImport.summary.ntltOrphanCount != null && (
                <>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">NTLT Orphan Marks</span>
                    <span className="font-bold text-lg tabular-nums">{selectedImport.summary.ntltOrphanCount.toLocaleString()}</span>
                    <span className="block text-xs text-muted-foreground">RSJ/Earthing/General — no project code</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">NTLT Orphan Weight</span>
                    <span className="font-bold text-lg tabular-nums">{((selectedImport.summary.ntltOrphanWtMt ?? 0) / 1000).toFixed(3)} MT</span>
                    <span className="block text-xs text-muted-foreground">Attributed to (No Project), grouped by Section</span>
                  </div>
                </>
              )}
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Unclassified Rows</span>
                <span className={`font-bold text-lg tabular-nums ${(selectedImport.summary.unclassifiedRowCount ?? 0) > 0 ? "text-destructive" : ""}`}>
                  {(selectedImport.summary.unclassifiedRowCount ?? 0).toLocaleString()}
                </span>
                {selectedImport.summary.unclassifiedWtKg != null
                  ? <span className="block text-xs text-muted-foreground">{(selectedImport.summary.unclassifiedWtKg / 1000).toFixed(3)} MT</span>
                  : <span className="block text-xs text-muted-foreground">Unknown Type or Job Card Status</span>
                }
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">FG Excluded from Live Work</span>
                <span className="font-bold text-lg tabular-nums">{(selectedImport.summary.fgExcludedRowCount ?? 0).toLocaleString()}</span>
                <span className="block text-xs text-muted-foreground">Still retained for FG reporting</span>
              </div>
            </div>
            {selectedImport.summary.typeCounts && selectedImport.summary.typeCounts.length > 0 && (
              <div className="mt-4 rounded-md border bg-muted/20 p-3">
                <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  ERP Type breakdown
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                  {selectedImport.summary.typeCounts.map(({ type, rows }) => (
                    <div key={type} className="flex items-center justify-between gap-3 rounded border bg-background px-2.5 py-2">
                      <span className="truncate" title={type}>{type}</span>
                      <span className="font-bold tabular-nums">{rows.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(selectedImport.summary.unknownTypeRowCount ?? 0) > 0 && (
              <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 flex gap-2 items-start">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-semibold">
                    {(selectedImport.summary.unknownTypeRowCount ?? 0).toLocaleString()} row{selectedImport.summary.unknownTypeRowCount === 1 ? "" : "s"} with unknown ERP Type values
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    Unknown and legacy Type values remain in live-work figures so no work is silently hidden. Review the ERP source before relying on Type-specific buckets.
                  </p>
                  {selectedImport.summary.unknownTypeValues && (
                    <div className="mt-2 font-mono text-xs text-muted-foreground space-y-0.5">
                      {selectedImport.summary.unknownTypeValues.map(({ type, rows }) => (
                        <div key={type}>&quot;{type}&quot; · {rows.toLocaleString()} row{rows === 1 ? "" : "s"}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {(selectedImport.summary.unclassifiedRowCount ?? 0) > 0 && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 flex gap-2 items-start">
                <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-semibold text-destructive">
                    {selectedImport.summary.unclassifiedRowCount!.toLocaleString()} unclassified {selectedImport.summary.unclassifiedRowCount === 1 ? "row" : "rows"}{selectedImport.summary.unclassifiedWtKg != null ? ` · ${(selectedImport.summary.unclassifiedWtKg / 1000).toFixed(3)} MT` : ""} — unexpected Type or Job Card Status value
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    These rows do not match the verified closed value sets for Col A ("Type") or Col G ("Job Card Status").
                    This usually means a new file format. The rows are still counted in total balance but not bucketed into any WIP case.
                  </p>
                  {selectedImport.summary.unclassifiedSamples && selectedImport.summary.unclassifiedSamples.length > 0 && (
                    <div className="mt-2 font-mono text-xs text-muted-foreground space-y-0.5">
                      {selectedImport.summary.unclassifiedSamples.map((s, i) => (
                        <div key={i}>Type: "{s.type}" / Status: "{s.status}"</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Import History</h3>
          {imports.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeleteAll}
              disabled={deleteAll.isPending}
              className="h-8 gap-2 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            >
              <AlertTriangle className="w-4 h-4" />
              {deleteAll.isPending ? "Deleting..." : "Delete all data"}
            </Button>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">WIP Files</h4>
          <div className="grid gap-3">
            {imports.map(s => (
              <Card
                key={s.id}
                className={`transition-all ${selectedImportId === s.id ? 'border-primary ring-1 ring-primary shadow-md' : 'hover:border-primary/50'}`}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div
                    className="flex-1 cursor-pointer flex flex-col gap-1"
                    onClick={() => setSelectedImportId(s.id)}
                  >
                    <div className="font-bold flex items-center gap-2 flex-wrap">
                      {s.label || s.sourceFilename}
                      {selectedImportId === s.id && <CheckCircle2 className="w-4 h-4 text-primary" />}
                      {!s.hasTypeData && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          <AlertTriangle className="w-3 h-3" />
                          No classification data
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                      <span>{formatDate(s.createdAt)}</span>
                      <span>{s.summary.rowsKept.toLocaleString()} rows</span>
                      {s.changeSummary && (
                        <>
                          <span className="text-emerald-600 dark:text-emerald-400">+{s.changeSummary.addedRows.toLocaleString()} added</span>
                          <span>{s.changeSummary.newMarks.toLocaleString()} new</span>
                          <span>{s.changeSummary.completed.toLocaleString()} completed</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(s.id)} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {imports.length === 0 && <div className="text-center p-8 text-sm text-muted-foreground border rounded-lg border-dashed">No WIP files uploaded yet.</div>}
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">Order Review Files</h4>
          {recentCumulativeOverrides.length > 0 && (
            <div className="rounded-md border border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  A cumulative-regression override was granted in the last seven days
                  for {recentCumulativeOverrides.length === 1 ? " this file" : ` ${recentCumulativeOverrides.length} files`}.
                  Review the recorded reason before relying on merged Order Review figures.
                </span>
              </div>
            </div>
          )}
          <div className="grid gap-3">
            {orderImports.map(o => (
              <Card key={o.id} className="transition-all hover:border-primary/50">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex-1 flex flex-col gap-1">
                    <div className="font-bold">{o.label || o.sourceFilename}</div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                      <span>{formatDate(o.createdAt)}</span>
                      {o.asOnDate && <span>as on {formatDate(o.asOnDate)}</span>}
                      <span>{o.summary.rowsKept.toLocaleString()} rows</span>
                      {o.overrideReason && (
                        <span
                          className="font-medium text-amber-700 dark:text-amber-300"
                          title={`Cumulative regression override${o.overrideBy ? ` by ${o.overrideBy}` : ""}: ${o.overrideReason}`}
                        >
                          Cumulative override
                        </span>
                      )}
                      {o.changeLog && (
                        <>
                          <span className="text-emerald-600 dark:text-emerald-400">+{o.changeLog.inserted.length.toLocaleString()} added</span>
                          <span>{o.changeLog.updated.length.toLocaleString()} updated</span>
                          <span>{o.changeLog.unchanged.toLocaleString()} unchanged</span>
                        </>
                      )}
                      {o.summary.missingStructure > 0
                        ? <span className="text-destructive font-medium">{o.summary.missingStructure} orphaned row{o.summary.missingStructure === 1 ? "" : "s"}{o.summary.missingStructureWtMt != null ? ` · ${o.summary.missingStructureWtMt.toFixed(3)} MT` : ""} (no structure — excluded)</span>
                        : null
                      }
                      {(o.summary.skippedBanner ?? 0) > 0
                        ? <span className="text-amber-600 dark:text-amber-400 font-medium">{o.summary.skippedBanner} banner row{o.summary.skippedBanner === 1 ? "" : "s"} skipped</span>
                        : null
                      }
                      {o.summary.missingStructure === 0 && (o.summary.skippedBanner ?? 0) === 0
                        ? <span>0 skipped rows</span>
                        : null
                      }
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => handleDeleteOrder(o.id)} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {orderImports.length === 0 && <div className="text-center p-8 text-sm text-muted-foreground border rounded-lg border-dashed">No Order Review files uploaded yet.</div>}
          </div>
        </div>
      </div>

      {/* OR Self-Consistency Panel */}
      <div className="space-y-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          Order Review — Cascade Identity Checks
        </h3>
        <OrderReviewConsistencyPanel />
      </div>

      <OrderReviewAnomalyRegister />
      <StagingEvidenceRegister />

      {/* Deletion audit log */}
      <div className="space-y-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <History className="w-4 h-4" />
          Deletion Log
        </h3>
        {deletionLog.length === 0 ? (
          <div className="text-center p-6 text-sm text-muted-foreground border rounded-lg border-dashed">
            No files have been deleted yet.
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">When</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Deleted by</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Type</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">File</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Report date</th>
                </tr>
              </thead>
              <tbody>
                {deletionLog.map((entry, i) => (
                  <tr key={entry.id} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground whitespace-nowrap">
                      {formatDate(entry.deletedAt)}
                    </td>
                    <td className="px-3 py-2 font-medium">{entry.deletedBy}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
                        entry.fileType === "wip"
                          ? "bg-primary/10 text-primary"
                          : "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                      }`}>
                        {entry.fileType === "wip" ? "WIP" : "Order Review"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[200px]" title={entry.sourceFilename}>
                      {entry.sourceFilename}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {entry.reportDate ? formatDate(entry.reportDate) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// The canonical "day" of an import, mirroring the server's importDayKey:
// report date when a valid YYYY-MM-DD, else the UTC calendar day of createdAt.
function importDayKey(i: { reportDate: string | null; createdAt: string }): string {
  if (i.reportDate && /^\d{4}-\d{2}-\d{2}$/.test(i.reportDate)) return i.reportDate;
  return new Date(i.createdAt).toISOString().slice(0, 10);
}

// Global "valid data starts here" WIP cutoff. Persisted in the singleton
// settings row; when set, the whole app (client selection + every server-side
// history replay) ignores WIP imports dated before it. Listing uses all=true so
// the picker can offer every date, including ones currently hidden by the cutoff.
function CutoffCard() {
  const { settings, updateSettings, saving } = useSettings();
  const { data: allImports = [] } = useListImports(
    { all: true },
    { query: { queryKey: getListImportsQueryKey({ all: true }) } },
  );
  const cutoff = settings.validFromDate ?? "";
  const dayKeys = Array.from(new Set(allImports.map(importDayKey))).sort().reverse();

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Valid Data Cutoff
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Pick the earliest WIP report date that should count. Every view, report,
          and history calculation ignores imports dated before it. Leave as
          "No cutoff" to include all uploaded data.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="bg-background border border-border rounded-md px-3 py-2 text-sm min-w-[14rem]"
            value={cutoff}
            disabled={saving}
            onChange={(e) =>
              updateSettings({ validFromDate: e.target.value || null })
            }
          >
            <option value="">No cutoff (include all data)</option>
            {dayKeys.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            {cutoff && !dayKeys.includes(cutoff) && (
              <option value={cutoff}>{cutoff}</option>
            )}
          </select>
          {cutoff && (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={saving}
              onClick={() => updateSettings({ validFromDate: null })}
            >
              Clear cutoff
            </Button>
          )}
          {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
        </div>
        {cutoff && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Active: imports dated before {cutoff} are hidden everywhere.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Item Master upload card — a direct (non-staged) XLS/XLSX upload that populates
// the item_master table used as the primary thickness source. Independent of WIP
// imports; can be updated any time without re-uploading balance files.
// ---------------------------------------------------------------------------
interface ItemMasterStats {
  totalRows: number;
  rowsWithThickness: number;
  lastUploadedAt: string | null;
}

function ItemMasterUploadCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const STATS_KEY = ["/api/item-master/stats"];

  const { data: stats, isLoading: statsLoading } = useQuery<ItemMasterStats>({
    queryKey: STATS_KEY,
    queryFn: () =>
      fetch("/api/item-master/stats", { credentials: "include" }).then((r) => r.json()),
  });

  const upload = useMutation<
    { totalRows: number; upserted: number; rowsWithThickness: number },
    Error,
    File
  >({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/item-master/upload", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error ?? "Upload failed");
      }
      return r.json();
    },
    onSuccess: (res) => {
      toast({
        title: "Item master uploaded",
        description: `${res.upserted.toLocaleString()} rows upserted, ${res.rowsWithThickness.toLocaleString()} with thickness. Thickness cache cleared.`,
      });
      queryClient.invalidateQueries({ queryKey: STATS_KEY });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Upload failed", description: err.message });
    },
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    e.target.value = "";
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Item Master (Thickness Source)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Upload the VTPL item master XLS/XLSX. All rows are upserted (keyed on Item Code).
          Non-JW rows with a thickness value become the primary thickness source for all section
          types (channels, beams, pipes, RSJ, etc.), taking priority over section parsing.
        </p>
        {statsLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : stats && stats.totalRows > 0 ? (
          <div className="flex flex-wrap gap-4 text-sm">
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">Total Rows</span>
              <span className="font-bold tabular-nums">{stats.totalRows.toLocaleString()}</span>
            </div>
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">Rows with Thickness</span>
              <span className="font-bold tabular-nums text-primary">{stats.rowsWithThickness.toLocaleString()}</span>
            </div>
            {stats.lastUploadedAt && (
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Last Updated</span>
                <span className="font-bold tabular-nums">
                  {formatDate(stats.lastUploadedAt.slice(0, 10))}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            No item master loaded — thickness falls back to section parsing.
          </p>
        )}
        <div className="flex items-center gap-3">
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".xls,.xlsx"
              className="sr-only"
              onChange={handleFile}
              disabled={upload.isPending}
            />
            <span
              className={`inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors ${
                upload.isPending ? "opacity-50 pointer-events-none" : "cursor-pointer"
              }`}
            >
              <FileSpreadsheet className="w-4 h-4" />
              {upload.isPending ? "Uploading…" : stats && stats.totalRows > 0 ? "Re-upload" : "Upload XLS/XLSX"}
            </span>
          </label>
          {upload.isPending && (
            <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// "Current Jobs" — a small, direct (non-staged) upload: a plain list of
// project codes (.xlsx/.xls) that powers a set-membership "Current Jobs"
// option in the existing Job filter. Each upload REPLACES the list; it never
// touches WIP/Order Review parsing, hash/dedup, Activity, qty, or ageing.
function ReleaseBalanceContent() {
  // No importId param — defaults to the latest import on the server side,
  // which is what the comparison page needs (it is not import-selector-scoped).
  const { data, isLoading } = useGetReleaseBalance(undefined, {
    query: { queryKey: getGetReleaseBalanceQueryKey() },
  });
  const { filters } = useTracker();
  const namedJobSet = useActiveJobSet();
  const rows = useMemo(
    () => filterReleaseBalanceRows(data, filters, namedJobSet),
    [data, filters, namedJobSet],
  );
  const isJobFiltered = isNamedJobSetFilter(filters.job)
    || filters.selectedJobs.length > 0
    || !!(filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE);
  const totals = useMemo(() => {
    if (!isJobFiltered) return data?.totals;
    return {
      releaseBalanceComputedMt: rows.reduce((s, r) => s + (r.releaseBalanceComputedMt ?? 0), 0),
      releaseBalanceOrderReviewMt: rows.reduce((s, r) => s + (r.releaseBalanceOrderReviewMt ?? 0), 0),
      diffMt: rows.reduce((s, r) => s + (r.diffMt ?? 0), 0),
      rowCount: rows.length,
    };
  }, [data, isJobFiltered, rows]);

  const handleExport = () => {
    exportToXlsx(
      "release-balance.xlsx",
      [
        { label: "Project", field: "project" },
        { label: "Structure", field: "structure" },
        { label: "Release Balance Order Review (MT)", field: "releaseBalanceOrderReviewMt", numeric: true, decimals: 3, total: true },
        { label: "Release Balance Computed WIP (MT)", field: "releaseBalanceComputedMt", numeric: true, decimals: 3, total: true },
        { label: "Diff (MT)", field: "diffMt", numeric: true, decimals: 3, total: true },
      ] as XlsxColumn[],
      rows,
      { sheetName: "Release Balance" },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Release Balance</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Per-structure Release Balance Computed from the latest WIP file:
            sum of Balance Wt. (Col Q) divided by 1000 for rows where Type
            (Col A) is "Job Card Not Started" and Job Card Status (Col G) is
            "Initial". Cross-checked against the Order Review file's stated
            Release Balance. Automatically re-computed on every WIP upload —
            the Recompute button on the Data tab does not affect this view
            (it cannot, since the raw file bytes are not permanently stored).
          </p>
        </div>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExport} className="shrink-0">
            <FileDown className="h-4 w-4 mr-1.5" />
            Export
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            Loading...
          </CardContent>
        </Card>
      ) : !data?.available ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            {(data as Record<string, unknown> | undefined)?.hasTypeData === false
              ? "Classification data not available for the loaded WIP file. It pre-dates per-row Type/Status storage — Release Balance cannot be computed. Re-upload the source WIP file to restore this view."
              : "No Release Balance data. Upload a WIP file in the newer format (with \u201cType\u201d and \u201cJob Card Status\u201d columns) to populate this view."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Order Review (MT)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums">
                  {data.orderReviewAsOnDate
                    ? mt3(totals?.releaseBalanceOrderReviewMt)
                    : "-"}
                </div>
                {data.orderReviewAsOnDate && (
                  <div className="text-xs text-muted-foreground mt-1">
                    as on {data.orderReviewAsOnDate}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Computed WIP (MT)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums">
                  {mt3(totals?.releaseBalanceComputedMt)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totals?.rowCount ?? 0} structures
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Diff (MT)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums">
                  {data.orderReviewAsOnDate ? mt3(totals?.diffMt) : "-"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Computed minus Order Review
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By structure</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-background border-b">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Project</th>
                      <th className="px-3 py-2 text-left font-semibold">Structure</th>
                      <th className="px-3 py-2 text-right font-semibold">Order Review (MT)</th>
                      <th className="px-3 py-2 text-right font-semibold">Computed WIP (MT)</th>
                      <th className="px-3 py-2 text-right font-semibold">Diff (MT)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((r) => (
                      <tr key={`${r.project}|${r.structure}`} className="hover:bg-muted/40">
                        <td className="px-3 py-2">{r.project}</td>
                        <td className="px-3 py-2">{r.structure}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.releaseBalanceOrderReviewMt ?? undefined)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.releaseBalanceComputedMt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.diffMt ?? undefined)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="sticky bottom-0 bg-background border-t font-semibold">
                    <tr>
                      <td className="px-3 py-2" colSpan={2}>Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(totals?.releaseBalanceOrderReviewMt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(totals?.releaseBalanceComputedMt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(totals?.diffMt)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Generated Order Review (per-stage validation) ────────────────────────────
// Activity sets for chain computation (per spec). Single source of truth lives
// in @workspace/domain; do not redefine locally.
// GEN_FAB_ACTS = Cutting (C) + all QC activities (HG…TS) = everything pre-galv.
const GEN_FAB_ACTS  = new Set([PROCESS_SEQUENCE[0], ...QC_ACTIVITY_SET]);
// GEN_GALV_ACTS = G, GB, Y — identical to GALV_ACTIVITY_SET.
const GEN_GALV_ACTS = GALV_ACTIVITY_SET;

type ConfTier = "high" | "medium" | "low";
interface GenStageSpec {
  key: string; label: string; shortLabel: string;
  genField: keyof GenStructRowData;
  orField: "releaseMt"|"fileFabMt"|"fileGalvMt"|"inspectionMt"|"fileDespatchMt"|null;
  /** Matching field name on GenStructRowData (orProg*). Used for diff + stats. */
  structOrField: keyof GenStructRowData;
}
const GEN_STAGES: GenStageSpec[] = [
  { key:"rel",  label:"Progress Release",     shortLabel:"Rel",  genField:"genProgRelease", orField:"releaseMt",  structOrField:"orProgRelease" },
  { key:"fab",  label:"Progress Fabrication", shortLabel:"Fab",  genField:"genProgFab",     orField:"fileFabMt",  structOrField:"orProgFab"     },
  { key:"galv", label:"Progress Galvanising", shortLabel:"Galv", genField:"genProgGalv",    orField:"fileGalvMt", structOrField:"orProgGalv"    },
  // FG: Gen = WIP "FG Pending For Dispatch" rows; OR = Galvanising − Despatch from OR file.
  // Expect a large gap (~47%) — they measure different things (snapshot vs cumulative book figure).
  { key:"fg",   label:"Finished Goods (FG)",  shortLabel:"FG",   genField:"genProgFg",      orField:null,         structOrField:"orProgFg"      },
];

// Balance stage specs (separate from Progress). Balance = what remains in-progress at each stage.
// Gen values are derived from WIP. OR values come from the Balance columns in the uploaded OR file.
// orField is null when the OR file has no corresponding Balance column in our schema.
interface GenBalStageSpec {
  key: string; label: string; shortLabel: string;
  genField: keyof GenStructRowData;
  orField: keyof GenStructRowData | null;
}
const GEN_BAL_STAGES: GenBalStageSpec[] = [
  { key:"balRel",  label:"Balance Release",     shortLabel:"Rel",  genField:"genBalRelease", orField:"orBalRelease" },
  { key:"balFab",  label:"Balance Fabrication", shortLabel:"Fab",  genField:"genBalFab",     orField:"orBalFab"    },
  { key:"balGalv", label:"Balance Galvanising", shortLabel:"Galv", genField:"genBalGalv",    orField:"orBalGalv"   },
  // No OR file Balance FG column in our schema — show gen only; leave OR blank, never zero.
  { key:"balFg",   label:"Balance Fin. Goods",  shortLabel:"FG",   genField:"fgWt",          orField:null          },
];
const TIER_CLS: Record<ConfTier,{badge:string;flag:string}> = {
  high:   { badge:"bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", flag:"text-red-600 dark:text-red-400 font-semibold" },
  medium: { badge:"bg-amber-500/15 text-amber-700 dark:text-amber-400",       flag:"text-orange-600 dark:text-orange-400 font-semibold" },
  low:    { badge:"bg-slate-200/60 text-slate-600 dark:bg-slate-700/40 dark:text-slate-400", flag:"text-slate-600 dark:text-slate-400 font-semibold" },
};

interface GenStructRowData {
  structure: string; subType: string | null; mfcBatch: string; markCount: number;
  isNew: boolean;            // releasePct < 5%
  woOrderQtyMt: number | null;
  genBalRelease: number;     // isInitialCutting marks weight (MT)
  genProgRelease: number;    // woQty - genBalRelease (or sum(released) if no OR)
  genBalFab: number;         // released marks in fab activities (MT)
  genProgFab: number;        // genProgRelease - genBalFab
  genBalGalv: number;        // released marks in galv activities (MT)
  genProgGalv: number;       // genProgFab - genBalGalv
  fgWt: number;              // blank-activity (FG Pending) marks weight (MT)
  genProgFg: number;         // = fgWt — WIP "FG Pending For Dispatch" weight
  totalWt: number;           // all marks weight (MT)
  // OR file Progress comparison values
  orProgRelease: number | null; orProgFab: number | null;
  orProgGalv: number | null;
  /** fileGalvMt − fileDespatchMt; null when OR row absent or galvMt null;
   *  may be negative (despatch exceeds galv in OR file — source-data issue). */
  orProgFg: number | null;
  // OR file Balance comparison values (from Balance columns in OR file)
  orBalRelease: number | null; // fileBalReleaseMt
  orBalFab: number | null;     // balFabMt
  orBalGalv: number | null;    // balGalvMt
  orBalWo: number | null;      // balWoMt — OR file Balance Work Order (col R)
  // OR leading-column values
  orSets: number | null;       // Order Qty sets
  orWeightMt: number | null;   // Order Qty weight (MT)
  weightPerSet: number | null; // orWeightMt / orSets — null when either unavailable
  // BOM label
  bomDerived: "Proto" | "Mass" | "Mixed";
  bomLowConf: boolean;         // markCount < 8 — accessory-item noise likely
  orBomType: string | null;    // OR Col K value (latest row for this structure)
  orBomInconsistent: boolean;  // OR has multiple different BOM labels for this structure
}
type GenProjGroup = {
  project: string; releasePct: number; structures: GenStructRowData[];
  totals: Record<string, number>;
};

function GeneratedOrderReviewContent() {
  const { selectedImportId } = useTracker();
  const { data: allRecordsRaw, isLoading: recLoading } = useGetImportRecords(
    selectedImportId as number,
    { query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) } },
  );
  const { data: orderStatus, isLoading: orLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });
  // OR lookup: "project|structure" → order status row (last wins on dup keys)
  // Also captures all distinct bomType values per key for OR-inconsistency detection.
  const orBomData = useMemo(() => {
    const lastRow = new Map<string, OrderStatusRow>();
    const bomTypes = new Map<string, Set<string>>();
    for (const r of orderStatus?.rows ?? []) {
      const key = `${r.project}|${r.structure}`;
      lastRow.set(key, r);
      if (r.bomType) {
        if (!bomTypes.has(key)) bomTypes.set(key, new Set());
        bomTypes.get(key)!.add(r.bomType);
      }
    }
    return { lastRow, bomTypes };
  }, [orderStatus]);

  // Project-level OR summary for release % display (used in project cell tooltip).
  const orProjSummary = useMemo(() => {
    const m = new Map<string, { releaseMt: number; woQtyMt: number }>();
    for (const r of orderStatus?.rows ?? []) {
      const p = m.get(r.project) ?? { releaseMt: 0, woQtyMt: 0 };
      m.set(r.project, {
        releaseMt: p.releaseMt + (r.releaseMt ?? 0),
        woQtyMt:   p.woQtyMt   + (r.woOrderQtyMt ?? 0),
      });
    }
    return m;
  }, [orderStatus]);

  // Post-first-import projects: present in this import but NOT in the very first
  // WIP import ever loaded. These are the only projects whose full history the app
  // has captured, making the reconstructed chain reliable.
  // The set is stable: it can only grow over time as new projects arrive.
  const { data: newProjectsData, isLoading: newProjLoading } = useQuery({
    queryKey: ["/api/imports", selectedImportId, "new-projects"],
    queryFn: () =>
      fetch(`/api/imports/${selectedImportId}/new-projects`)
        .then((r) => r.json() as Promise<{ codes: string[] }>),
    enabled: !!selectedImportId,
    staleTime: Infinity,
  });
  const firstTimeProjects = useMemo(
    () => new Set(newProjectsData?.codes ?? []),
    [newProjectsData],
  );
  const isLoading = recLoading || orLoading || newProjLoading;

  const projectGroups = useMemo((): GenProjGroup[] => {
    const records = allRecordsRaw ?? [];
    // TLT / Structure marks only with a real project code and a structure
    const tlt = records.filter(
      (r) =>
        (r.category === "TLT" || (r.orderNature ?? "").trim().toUpperCase() === "STRUCTURE") &&
        r.job && r.job !== "(Unassigned)",
    );

    type Rec = typeof tlt[number];
    const byProj = new Map<string, Map<string, Rec[]>>();
    for (const r of tlt) {
      const struct = (r.structure ?? "").trim();
      if (!struct) continue;
      if (!byProj.has(r.job!)) byProj.set(r.job!, new Map());
      const sm = byProj.get(r.job!)!;
      if (!sm.has(struct)) sm.set(struct, []);
      sm.get(struct)!.push(r);
    }

    const groups: GenProjGroup[] = [];
    for (const [proj, structMap] of byProj) {
      // SCOPE FILTER: TLT projects that were NOT present in the very first WIP
      // import. Projects in the first import have unobserved history.
      const isFirstTime = firstTimeProjects.has(proj);
      if (!isFirstTime) continue;

      const orS = orProjSummary.get(proj);
      const projWoQty   = orS?.woQtyMt  ?? 0;
      const projRelease = orS?.releaseMt ?? 0;
      const releasePct  = projWoQty > 0 ? (projRelease / projWoQty) * 100 : 0;

      const structures: GenStructRowData[] = [];
      for (const [struct, marks] of structMap) {
        const actOf   = (r: Rec) => (r.activity ?? "").toUpperCase().trim();
        const sum     = (arr: Rec[]) => arr.reduce((s, r) => s + (r.balanceWt ?? 0), 0);
        const toMt    = (kg: number) => kg / 1000;

        const initCut  = marks.filter((r) => r.isInitialCutting);
        const released = marks.filter((r) => !r.isInitialCutting);
        // FG = released marks with blank activity ("FG Pending For Dispatch")
        const fg       = released.filter((r) => !actOf(r));

        const genBalRelease  = toMt(sum(initCut));
        const orRow          = orBomData.lastRow.get(`${proj}|${struct}`);
        const woQty          = orRow?.woOrderQtyMt ?? null;
        // genProgRelease requires woOrderQtyMt from OR file (per spec).
        // Fall back to sum(released) when OR is unavailable.
        const genProgRelease = woQty != null ? woQty - genBalRelease : toMt(sum(released));
        const genBalFab      = toMt(sum(released.filter((r) => GEN_FAB_ACTS.has(actOf(r)))));
        const genBalGalv     = toMt(sum(released.filter((r) => GEN_GALV_ACTS.has(actOf(r)))));
        const fgWt           = toMt(sum(fg));
        const genProgFg      = fgWt; // WIP "FG Pending For Dispatch" weight
        // Pure-WIP derivation — never mixes OR and WIP values in the same subtraction.
        // genProgFab  = weight at or past TS (fabrication complete) =
        //               sum(TS) + sum(G/GB/Y) + sum(blank=FG).
        //   OR stamps Progress Fabrication when a mark reaches TS; anything at
        //   TS or beyond counts as fabricated.
        // genProgGalv = weight at or past Y (galvanising complete) =
        //               sum(Y) + sum(blank=FG).
        //   OR stamps Progress Galvanising when a mark reaches Y (last galv step);
        //   anything at Y or beyond counts as galvanised.
        // Both are sums of non-negative values — structurally cannot go negative.
        const tsWt           = toMt(sum(released.filter((r) => actOf(r) === "TS")));
        const yWt            = toMt(sum(released.filter((r) => actOf(r) === "Y")));
        const genProgFab     = tsWt + genBalGalv + fgWt;
        const genProgGalv    = yWt + fgWt;
        const totalWt        = toMt(sum(marks));
        // OR FG = Galvanising − Despatch from OR file.
        // Kept as-is even when negative (Despatch > Galvanising is a source-data
        // inconsistency in the OR file; we surface it rather than clamping to zero).
        const orProgFg: number | null = orRow
          ? (orRow.fileGalvMt != null
              ? orRow.fileGalvMt - (orRow.fileDespatchMt ?? 0)
              : null)
          : null;

        // BOM label derived from job card prefix (P→Proto, 0→Mass, 95% dominance).
        // Use copies-expanded length for the dominance ratio (higher-copies P-cards
        // are weighted correctly); markCount uses distinct markId for the Marks column.
        const total    = marks.length; // copies-expanded count, BOM dominance only
        const pCount   = marks.filter((r) => (r.jobCardNo ?? "").startsWith("P")).length;
        const z0Count  = marks.filter((r) => /^0/.test(r.jobCardNo ?? "")).length;
        const bomDerived: "Proto" | "Mass" | "Mixed" =
          pCount / total >= 0.95  ? "Proto" :
          z0Count / total >= 0.95 ? "Mass"  : "Mixed";
        const bomLowConf      = total < 8;
        const structKey       = `${proj}|${struct}`;
        const orBomTypeVal    = orRow?.bomType ?? null;
        const orBomInconsistent = (orBomData.bomTypes.get(structKey)?.size ?? 0) > 1;

        const orSets       = orRow?.sets ?? null;
        const orWeightMt   = orRow?.weightMt ?? null;
        const weightPerSet = (orWeightMt != null && orSets != null && orSets > 0)
          ? orWeightMt / orSets : null;

        structures.push({
          structure: struct,
          subType: marks[0]?.towerSubType ?? null,
          mfcBatch: marks[0]?.mfcBatch ?? "Z",
          markCount: new Set(marks.map((r) => r.markId)).size, // distinct marks, not copies
          isNew: isFirstTime || (projWoQty > 0 && releasePct < 5),
          woOrderQtyMt: woQty,
          genBalRelease, genProgRelease,
          genBalFab, genProgFab,
          genBalGalv, genProgGalv,
          fgWt, genProgFg,
          totalWt,
          orProgRelease: orRow?.releaseMt ?? null,
          orProgFab:     orRow?.fileFabMt ?? null,
          orProgGalv:    orRow?.fileGalvMt ?? null,
          orProgFg,
          orBalRelease:  orRow?.fileBalReleaseMt ?? null,
          orBalFab:      orRow?.balFabMt ?? null,
          orBalGalv:     orRow?.balGalvMt ?? null,
          orBalWo:       orRow?.balWoMt ?? null,
          orSets, orWeightMt, weightPerSet,
          bomDerived, bomLowConf,
          orBomType: orBomTypeVal,
          orBomInconsistent,
        });
      }
      structures.sort((a, b) => a.structure.localeCompare(b.structure));

      const sf = (f: keyof GenStructRowData) =>
        structures.reduce((s, r) => s + (typeof r[f] === "number" ? (r[f] as number) : 0), 0);
      groups.push({
        project: proj, releasePct, structures,
        totals: {
          genProgRelease: sf("genProgRelease"), genProgFab: sf("genProgFab"),
          genProgGalv: sf("genProgGalv"),       genProgFg: sf("genProgFg"),
          genBalRelease:  sf("genBalRelease"),  genBalFab: sf("genBalFab"),
          genBalGalv:     sf("genBalGalv"),     fgWt:      sf("fgWt"),
        },
      });
    }
    groups.sort((a, b) => a.project.localeCompare(b.project));
    return groups;
  }, [allRecordsRaw, orBomData, orProjSummary, firstTimeProjects]);

  // Per-stage match % summary (structures where |gen - or| <= 0.5 MT and OR is present).
  // Tier is derived from the actual measured match rate, not hardcoded:
  //   ≥ 90% → high   |   ≥ 65% → medium   |   < 65% → low
  const stageStats = useMemo(() => {
    const allStructs = projectGroups.flatMap((g) => g.structures);
    return GEN_STAGES.map((stage) => {
      const withOr = allStructs.filter((s) => {
        const or = s[stage.structOrField] as number | null | undefined;
        return typeof or === "number" && or !== null;
      });
      const matching = withOr.filter((s) => {
        const gen = s[stage.genField]    as number | null;
        const or  = s[stage.structOrField] as number | null;
        return gen != null && or != null && Math.abs(gen - or) <= 0.5;
      });
      const pct: number | null = withOr.length > 0 ? (matching.length / withOr.length) * 100 : null;
      const tier: ConfTier = pct == null ? "low" : pct >= 90 ? "high" : pct >= 65 ? "medium" : "low";
      return { key: stage.key, total: withOr.length, matching: matching.length, tier };
    });
  }, [projectGroups]);
  // Fast lookup map used throughout the render.
  const stageStatsByKey = useMemo(
    () => new Map(stageStats.map((s) => [s.key, s])),
    [stageStats],
  );

  const handleExport = () => {
    const exportRows = projectGroups.flatMap((pg) =>
      pg.structures.map((s) => ({
        project:      pg.project,
        structure:    s.structure,
        subType:      s.subType,
        mfcBatch:     s.mfcBatch,
        marks:        s.markCount,
        weightPerSet: s.weightPerSet,
        orSets:       s.orSets,
        orWeightMt:   s.orWeightMt,
        woOrderQtyMt: s.woOrderQtyMt,
        bomLabel:     s.bomDerived + (s.bomLowConf ? " (LOW CONF)" : ""),
        orBomType:    s.orBomType,
        orBomNote:    s.orBomInconsistent
          ? "OR inconsistency"
          : (s.orBomType && s.orBomType !== s.bomDerived ? "Disagree" : ""),
        genProgRelease: s.genProgRelease, orProgRelease: s.orProgRelease,
        genProgFab:     s.genProgFab,     orProgFab:     s.orProgFab,
        genProgGalv:    s.genProgGalv,    orProgGalv:    s.orProgGalv,
        genProgFg:      s.genProgFg,      orProgFg:      s.orProgFg,
        orBalWo:        s.orBalWo,
        genBalRelease:  s.genBalRelease,  orBalRelease:  s.orBalRelease,
        genBalFab:      s.genBalFab,      orBalFab:      s.orBalFab,
        genBalGalv:     s.genBalGalv,     orBalGalv:     s.orBalGalv,
        fgWt:           s.fgWt,
      } satisfies import("@/lib/export").GenOrExportRow),
    ));
    void exportGenOrXlsx(
      `generated_order_review_${exportTimestamp()}.xlsx`,
      exportRows,
    );
  };

  if (!selectedImportId) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground text-sm">
          No import selected. Select a WIP import from the Data tab to generate this view.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground text-sm">Loading...</CardContent>
      </Card>
    );
  }

  const structCount = projectGroups.reduce((s, g) => s + g.structures.length, 0);
  const markCount   = projectGroups.reduce((s, g) => g.structures.reduce((ss, str) => ss + str.markCount, 0) + s, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Generated Order Review</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            <span className="font-semibold uppercase tracking-wide text-xs text-amber-600">
              Generated — not imported data.
            </span>{" "}
            Scope: TLT projects that{" "}
            <span className="font-semibold">entered WIP after the first file ever loaded</span>.
            Projects present from day one carry history the app never captured; projects that
            arrived later are tracked from their first activity, making the reconstructed chain reliable.
            Chain: Release → Fabrication → Galvanising → Finished Goods, reconstructed from WIP
            alongside the matching OR file figure at each stage.{" "}
            BOM label is derived from job card prefix (P→Proto, 0→Mass, 95% dominance) and shown
            alongside OR Col K where available. Structures with fewer than 8 marks are flagged
            LOW CONF — likely accessory items whose job card reflects manufacture, not procurement lot.
            This view is strictly read-only and never affects imported data.
          </p>
        </div>
        {projectGroups.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExport} className="shrink-0">
            <FileDown className="h-4 w-4 mr-1.5" />
            Export
          </Button>
        )}
      </div>

      {/* Per-stage match % summary strip */}
      {structCount > 0 && (
        <div className="rounded-lg border bg-muted/20 p-4">
          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
            Match rate vs OR file (±0.5 MT tolerance, structures with OR data)
          </div>
          <div className="grid grid-cols-4 gap-3">
            {GEN_STAGES.map((stage) => {
              const stat = stageStatsByKey.get(stage.key)!;
              const pct  = stat.total > 0 ? (stat.matching / stat.total) * 100 : null;
              const tierMeta = TIER_CLS[stat.tier];
              return (
                <div key={stage.key} className="space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold">{stage.shortLabel}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${tierMeta.badge}`}>
                      {stat.tier}
                    </span>
                  </div>
                  <div className="text-lg font-bold tabular-nums">
                    {pct != null ? `${pct.toFixed(1)}%` : "—"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {stat.matching}/{stat.total} structures
                  </div>
                  {/* Progress bar */}
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${pct != null && pct >= 90 ? "bg-emerald-500" : pct != null && pct >= 80 ? "bg-amber-500" : "bg-red-500"}`}
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {projectGroups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No structures found. Select a WIP import with TLT records.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex gap-3 flex-wrap text-sm items-center">
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {projectGroups.length} project{projectGroups.length !== 1 ? "s" : ""}
            </span>
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {structCount} structure{structCount !== 1 ? "s" : ""}
            </span>
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {markCount.toLocaleString()} marks
            </span>
            {/* Confidence legend */}
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              Confidence:
              {(["high","medium","low"] as ConfTier[]).map((t) => (
                <span key={t} className={`px-1.5 py-0.5 rounded font-medium ${TIER_CLS[t].badge}`}>
                  {t}
                </span>
              ))}
            </span>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  {/* ─── Two-row banner header ─────────────────────────────────────────
                      Row 1: fixed cols (rowSpan=2) · PROGRESS (colSpan=4) · BALANCE (colSpan=5)
                      Row 2: stage sub-headers (fixed cols spanned from row 1)
                      Row 3: "gen / OR" sub-label per stage column */}
                  <thead>
                    {/* Row 1: banners */}
                    <tr className="bg-slate-800 dark:bg-slate-900 text-white border-b-2">
                      <th className="px-2 py-2 text-left font-semibold min-w-[80px]" rowSpan={3}>Project</th>
                      <th className="px-2 py-2 text-left font-semibold min-w-[90px]" rowSpan={3}>Structure</th>
                      <th className="px-2 py-2 text-left font-semibold min-w-[50px]" rowSpan={3}>Sub Type</th>
                      <th className="px-2 py-2 text-left font-semibold min-w-[40px]" rowSpan={3}>MFC</th>
                      <th className="px-2 py-2 text-right font-semibold min-w-[40px]" rowSpan={3}>Marks</th>
                      <th className="px-2 py-2 text-right font-semibold min-w-[68px] border-l border-slate-600"
                          rowSpan={3} title="Order Qty weight ÷ sets (from OR file)">Wt/Set<br/>(MT)</th>
                      <th className="px-2 py-2 text-right font-semibold min-w-[52px] border-l border-slate-600"
                          rowSpan={3} title="Order Qty sets (OR file)">Ord Qty<br/>Sets</th>
                      <th className="px-2 py-2 text-right font-semibold min-w-[68px]"
                          rowSpan={3} title="Order Qty weight MT (OR file)">Ord Qty<br/>Wt (MT)</th>
                      <th className="px-2 py-2 text-right font-semibold min-w-[68px]"
                          rowSpan={3} title="WO Order Qty weight MT (OR file Col J)">WO Qty<br/>(MT)</th>
                      <th className="px-2 py-2 text-left font-semibold min-w-[74px] border-l border-slate-600"
                          rowSpan={3}>BOM Label</th>
                      <th className="px-3 py-2 text-center font-bold tracking-wide border-l-2 border-blue-400"
                          colSpan={4} style={{ background: "rgba(30,58,95,0.95)" }}>
                        PROGRESS
                      </th>
                      <th className="px-3 py-2 text-center font-bold tracking-wide border-l-2 border-emerald-400"
                          colSpan={5} style={{ background: "rgba(26,58,42,0.95)" }}>
                        BALANCE
                      </th>
                    </tr>
                    {/* Row 2: stage sub-headers */}
                    <tr className="text-[10px] text-white/80">
                      {GEN_STAGES.map((stage, i) => {
                        const st = stageStatsByKey.get(stage.key)!;
                        return (
                          <th key={stage.key}
                              className={`px-2 py-1.5 text-center font-semibold min-w-[90px] ${i === 0 ? "border-l-2 border-blue-400" : "border-l border-slate-600"}`}
                              style={{ background: "rgba(30,58,95,0.85)" }}>
                            <div>{stage.shortLabel}</div>
                            <div className={`text-[9px] font-normal px-1 py-0 rounded mt-0.5 inline-block ${TIER_CLS[st.tier].badge}`}>
                              {st.tier}
                            </div>
                          </th>
                        );
                      })}
                      <th className="px-2 py-1.5 text-center font-semibold min-w-[68px] border-l-2 border-emerald-400"
                          style={{ background: "rgba(26,58,42,0.85)" }}
                          title="Balance Work Order (MT) — remaining WO qty from OR file col R; blank until the OR file is re-uploaded after the col-R upgrade">WO (MT)</th>
                      {GEN_BAL_STAGES.map((stage) => (
                        <th key={stage.key}
                            className="px-2 py-1.5 text-center font-semibold min-w-[90px] border-l border-slate-600"
                            style={{ background: "rgba(26,58,42,0.85)" }}>
                          {stage.shortLabel}
                        </th>
                      ))}
                    </tr>
                    {/* Row 3: gen / OR sub-label */}
                    <tr className="bg-muted/40 border-b text-[10px] text-muted-foreground">
                      {GEN_STAGES.map((stage, i) => (
                        <td key={stage.key}
                            className={`px-2 py-0.5 text-center ${i === 0 ? "border-l-2 border-blue-300/50" : "border-l border-slate-200 dark:border-slate-700"}`}>
                          gen / OR
                        </td>
                      ))}
                      <td className="px-2 py-0.5 text-center border-l-2 border-emerald-300/60">OR only</td>
                      {GEN_BAL_STAGES.map((stage) => (
                        <td key={stage.key} className="px-2 py-0.5 text-center border-l border-slate-200 dark:border-slate-700">
                          {stage.orField ? "gen / OR" : "gen only"}
                        </td>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {projectGroups.map((pg) => (
                      <Fragment key={pg.project}>
                        {pg.structures.map((s, si) => {
                          const anyProgDiff = GEN_STAGES.some((stage) => {
                            const gen = s[stage.genField]      as number | null;
                            const or  = s[stage.structOrField] as number | null;
                            return gen != null && or != null && Math.abs(gen - or) > 0.5;
                          });
                          const anyBalDiff = GEN_BAL_STAGES.some((stage) => {
                            if (!stage.orField) return false;
                            const gen = s[stage.genField] as number | null;
                            const or  = s[stage.orField]  as number | null;
                            return gen != null && or != null && Math.abs(gen - or) > 0.5;
                          });
                          const anyDiff = anyProgDiff || anyBalDiff;
                          return (
                            <tr key={s.structure} className={`hover:bg-muted/20 ${anyDiff ? "bg-amber-50/40 dark:bg-amber-950/15" : ""}`}>
                              {/* Project cell — spans all structure rows + subtotal */}
                              {si === 0 && (
                                <td
                                  className="px-3 py-2 font-bold align-top border-r bg-muted/10"
                                  rowSpan={pg.structures.length + 1}
                                >
                                  <span className="font-mono text-sm">{pg.project}</span>
                                  <br />
                                  <span className="text-muted-foreground font-normal text-[10px]">
                                    {pg.structures.length} struct{pg.structures.length !== 1 ? "s" : ""}
                                    {" · "}{pct1(pg.releasePct)} rel.
                                  </span>
                                  {s.isNew && (
                                    <span className="block mt-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                                      NEW
                                    </span>
                                  )}
                                </td>
                              )}
                              {/* Fixed cols */}
                              <td className="px-2 py-1.5 font-mono text-[11px]">{s.structure}</td>
                              <td className="px-2 py-1.5 text-muted-foreground text-[10px]">{s.subType ?? "—"}</td>
                              <td className="px-2 py-1.5 text-muted-foreground text-[10px]">{s.mfcBatch}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{s.markCount}</td>
                              {/* Wt/Set (MT) */}
                              <td className="px-2 py-1.5 text-right tabular-nums border-l text-[11px]">
                                {s.weightPerSet != null ? mt3(s.weightPerSet) : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              {/* OR Qty Sets */}
                              <td className="px-2 py-1.5 text-right tabular-nums border-l text-[11px]">
                                {s.orSets != null ? s.orSets : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              {/* OR Qty Wt (MT) */}
                              <td className="px-2 py-1.5 text-right tabular-nums text-[11px]">
                                {s.orWeightMt != null ? mt3(s.orWeightMt) : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              {/* WO Qty (MT) */}
                              <td className="px-2 py-1.5 text-right tabular-nums text-[11px]">
                                {s.woOrderQtyMt != null ? mt3(s.woOrderQtyMt) : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              {/* BOM label */}
                              <td className="px-2 py-1.5 border-l">
                                <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-medium
                                  ${s.bomDerived === "Proto" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" :
                                    s.bomDerived === "Mass"  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" :
                                                               "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"}
                                  ${s.bomLowConf ? "opacity-60 ring-1 ring-inset ring-current ring-dashed" : ""}`}>
                                  {s.bomDerived}
                                  {s.bomLowConf && (
                                    <span title="Fewer than 8 marks — likely accessory item; prefix may not reflect procurement lot">⚠</span>
                                  )}
                                </span>
                                {s.orBomType && (
                                  <span className={`block text-[10px] leading-tight mt-0.5
                                    ${s.orBomInconsistent ? "text-red-600 dark:text-red-400 font-medium" :
                                      s.orBomType !== s.bomDerived ? "text-amber-600 dark:text-amber-400" :
                                      "text-muted-foreground"}`}>
                                    OR: {s.orBomType}
                                    {s.orBomInconsistent && (
                                      <span className="ml-0.5" title="OR Col K has multiple different BOM labels for this structure — derived value is more consistent">⚡</span>
                                    )}
                                    {!s.orBomInconsistent && s.orBomType !== s.bomDerived && (
                                      <span className="ml-0.5" title="Derived label disagrees with OR Col K">≠</span>
                                    )}
                                  </span>
                                )}
                              </td>
                              {/* ── PROGRESS stage cells ───────────────────────────────── */}
                              {GEN_STAGES.map((stage, i) => {
                                const gen = s[stage.genField]      as number | null;
                                const or  = s[stage.structOrField] as number | null;
                                const diff = gen != null && or != null ? Math.abs(gen - or) : null;
                                const flagged = diff != null && diff > 0.5;
                                const negativeOr = or != null && or < 0;
                                const flagCls = TIER_CLS[stageStatsByKey.get(stage.key)!.tier].flag;
                                return (
                                  <td key={stage.key}
                                      className={`px-2 py-1.5 text-right tabular-nums ${i === 0 ? "border-l-2 border-blue-300/50" : "border-l border-slate-200 dark:border-slate-700"}`}>
                                    <span className={flagged ? flagCls : ""}>{mt3(gen)}</span>
                                    {or != null && (
                                      <span className={`block text-[10px] leading-tight ${negativeOr ? "text-red-600 dark:text-red-400 font-semibold" : "text-muted-foreground"}`}>
                                        OR: {mt3(or)}
                                        {negativeOr && (
                                          <span title="Negative OR FG: Despatch exceeds Galvanising in the OR file — source-data inconsistency">
                                            <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5" />
                                          </span>
                                        )}
                                        {!negativeOr && flagged && (
                                          <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5 text-amber-500" />
                                        )}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                              {/* ── BALANCE section ─────────────────────────────────────── */}
                              {/* Balance Work Order (MT) — OR file col R (remaining WO qty).
                                  OR reference only; blank when no OR row / pre-upgrade ingest. */}
                              <td className="px-2 py-1.5 text-right tabular-nums border-l-2 border-emerald-300/50 text-[11px]">
                                {s.orBalWo != null
                                  ? <span className="text-muted-foreground">{mt3(s.orBalWo)}</span>
                                  : <span className="text-muted-foreground/30">—</span>}
                              </td>
                              {/* Balance stage cells */}
                              {GEN_BAL_STAGES.map((stage) => {
                                const gen = s[stage.genField] as number;
                                const or  = stage.orField ? (s[stage.orField] as number | null) : null;
                                const diff = or != null ? Math.abs(gen - or) : null;
                                const flagged = diff != null && diff > 0.5;
                                return (
                                  <td key={stage.key} className="px-2 py-1.5 text-right tabular-nums border-l border-slate-200 dark:border-slate-700">
                                    <span className={flagged ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}>{mt3(gen)}</span>
                                    {or != null && (
                                      <span className="block text-[10px] leading-tight text-muted-foreground">
                                        OR: {mt3(or)}
                                        {flagged && (
                                          <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5 text-amber-500" />
                                        )}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                        {/* Per-project subtotal */}
                        {/* colSpan=9: Structure·SubType·MFC·Marks·WtPerSet·OR Sets·OR Wt·WO Wt·BOM */}
                        <tr className="bg-muted/40 font-semibold border-t border-b-2 text-[11px]">
                          <td className="px-3 py-1.5 text-muted-foreground uppercase tracking-wide" colSpan={9}>
                            Subtotal
                          </td>
                          {GEN_STAGES.map((stage, i) => (
                            <td key={stage.key}
                                className={`px-2 py-1.5 text-right tabular-nums ${i === 0 ? "border-l-2 border-blue-300/50" : "border-l border-slate-200 dark:border-slate-700"}`}>
                              {mt3(pg.totals[stage.genField as keyof typeof pg.totals] as number)}
                            </td>
                          ))}
                          <td className="border-l-2 border-emerald-300/50" />
                          {GEN_BAL_STAGES.map((stage) => (
                            <td key={stage.key} className="px-2 py-1.5 text-right tabular-nums border-l border-slate-200 dark:border-slate-700">
                              {mt3(pg.totals[stage.genField as keyof typeof pg.totals] as number)}
                            </td>
                          ))}
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/60 font-bold border-t-2 text-[11px]">
                      <td className="px-3 py-2 uppercase tracking-wide">Grand Total</td>
                      {/* colSpan=9: Structure·SubType·MFC·Marks·WtPerSet·OR Sets·OR Wt·WO Wt·BOM */}
                      <td colSpan={9} className="px-3 py-2 text-muted-foreground">
                        {projectGroups.length} projects · {structCount} structures · {markCount.toLocaleString()} marks
                      </td>
                      {GEN_STAGES.map((stage, i) => (
                        <td key={stage.key}
                            className={`px-2 py-2 text-right tabular-nums ${i === 0 ? "border-l-2 border-blue-300/50" : "border-l border-slate-200 dark:border-slate-700"}`}>
                          {mt3(projectGroups.reduce((s, g) => s + ((g.totals[stage.genField as keyof typeof g.totals] as number) ?? 0), 0))}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right tabular-nums border-l-2 border-emerald-300/50 text-muted-foreground">
                        {(() => {
                          const withVal = projectGroups.flatMap((g) => g.structures).filter((r) => r.orBalWo != null);
                          return withVal.length
                            ? mt3(withVal.reduce((s, r) => s + (r.orBalWo ?? 0), 0))
                            : "—";
                        })()}
                      </td>
                      {GEN_BAL_STAGES.map((stage) => (
                        <td key={stage.key} className="px-2 py-2 text-right tabular-nums border-l border-slate-200 dark:border-slate-700">
                          {mt3(projectGroups.reduce((s, g) => s + ((g.totals[stage.genField as keyof typeof g.totals] as number) ?? 0), 0))}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Order Review Self-Consistency Panel ─────────────────────────────────────
// Checks the five cascade identities in the uploaded OR file per structure.
// Read-only: never modifies any imported value.

interface OrIdentitySpec {
  key: string;
  label: string;
  lhsA: keyof import("@workspace/api-client-react").OrderStatusRow;
  lhsB: keyof import("@workspace/api-client-react").OrderStatusRow;
  rhs: keyof import("@workspace/api-client-react").OrderStatusRow;
  informational?: boolean; // over-release is expected, label as info not error
}
// We can't use the import() trick in interface position — inline type instead
const OR_IDENTITIES: Array<{
  key: string; label: string;
  a: keyof OrderStatusRow; b: keyof OrderStatusRow; c: keyof OrderStatusRow;
  info?: boolean;
}> = [
  { key:"rel",  label:"ProgRelease + BalRelease = WO Order Qty",
    a:"releaseMt",    b:"fileBalReleaseMt", c:"woOrderQtyMt", info:true },
  { key:"fab",  label:"ProgFab + BalFab = ProgRelease",
    a:"fileFabMt",   b:"balFabMt",         c:"releaseMt" },
  { key:"galv", label:"ProgGalv + BalGalv = ProgFab",
    a:"fileGalvMt",  b:"balGalvMt",        c:"fileFabMt" },
  { key:"insp", label:"ProgInsp + implied BalInsp = ProgGalv",
    a:"inspectionMt", b:"fileBalDespatchMt", c:"fileGalvMt" },
  { key:"desp", label:"ProgDesp + BalDesp = ProgInsp",
    a:"fileDespatchMt", b:"fileBalDespatchMt", c:"inspectionMt" },
];

function OrderReviewConsistencyPanel() {
  const { data: orderStatus } = useGetOrderStatus({ query: { queryKey: getGetOrderStatusQueryKey() } });
  const rows = orderStatus?.rows ?? [];

  const checks = useMemo(() => {
    // Identity 4 (insp): ProgInsp + BalInsp = ProgGalv — but BalInsp isn't stored.
    // Instead we report structures where inspectionMt > fileGalvMt (implied BalInsp < 0).
    const results = OR_IDENTITIES.map((id) => {
      const TOL = 0.002;
      type Offender = { project: string; structure: string; lhs: number; rhs: number; diff: number };
      const offenders: Offender[] = [];
      let satisfied = 0;
      let withData  = 0;
      let negBal    = 0;

      for (const r of rows) {
        const a = r[id.a] as number | null;
        const c = r[id.c] as number | null;

        // For identity "insp", we check: inspectionMt > fileGalvMt (implied negative balance)
        if (id.key === "insp") {
          const insp = r.inspectionMt;
          const galv = r.fileGalvMt;
          if (insp == null || galv == null) continue;
          withData++;
          const implied_lhs = insp; // ProgInsp
          const implied_rhs = galv; // ProgGalv (should be >= ProgInsp)
          const diff = implied_lhs - implied_rhs; // positive = BalInsp is negative
          if (diff <= TOL) { satisfied++; } else {
            negBal++;
            offenders.push({ project: r.project, structure: r.structure, lhs: insp, rhs: galv, diff });
          }
          continue;
        }

        const b = r[id.b] as number | null;
        if (a == null || c == null) continue;
        const lhsVal = (a ?? 0) + (id.key !== "insp" ? (b ?? 0) : 0);
        withData++;
        const diff = Math.abs(lhsVal - (c ?? 0));
        if (diff <= TOL) { satisfied++; }
        else { offenders.push({ project: r.project, structure: r.structure, lhs: lhsVal, rhs: c ?? 0, diff }); }
      }

      offenders.sort((x, y) => y.diff - x.diff);
      return { id, satisfied, withData, offenders: offenders.slice(0, 10), negBal };
    });

    // Negative balance flags (across all non-release columns)
    const NEG_COLS: Array<{ key: keyof OrderStatusRow; label: string }> = [
      { key:"balFabMt",          label:"Balance Fabrication" },
      { key:"balGalvMt",         label:"Balance Galvanising" },
      { key:"fileBalReleaseMt",  label:"Balance Release" },
      { key:"fileBalDespatchMt", label:"Balance Despatch" },
    ];
    const negFlags: Array<{ col: string; count: number; worstStructure: string; worstVal: number }> = [];
    for (const { key, label } of NEG_COLS) {
      const getVal = (r: OrderStatusRow) => r[key] as number | null;
      const neg = rows.filter((r) => getVal(r) != null && (getVal(r) as number) < 0);
      if (neg.length > 0) {
        const worst = neg.sort((a, b) => (getVal(a) as number) - (getVal(b) as number))[0];
        negFlags.push({ col: label, count: neg.length, worstStructure: `${worst.project}/${worst.structure}`, worstVal: getVal(worst) as number });
      }
    }

    return { results, negFlags };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="text-center p-8 text-sm text-muted-foreground border rounded-lg border-dashed">
        No Order Review data loaded. Upload an Order Review file to see consistency checks.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Negative balance flags */}
      {checks.negFlags.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1">
          <div className="flex items-center gap-2 text-sm font-bold text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Negative balance values (not physically possible)
          </div>
          {checks.negFlags.map((f) => (
            <div key={f.col} className="text-xs text-muted-foreground ml-6">
              <span className="font-medium text-foreground">{f.col}</span>: {f.count} structure{f.count !== 1 ? "s" : ""} — worst: {f.worstStructure} ({f.worstVal.toFixed(3)} MT)
            </div>
          ))}
        </div>
      )}

      {/* Identity check table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider min-w-[280px]">Identity</th>
              <th className="text-center px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Satisfied</th>
              <th className="text-center px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Total</th>
              <th className="text-center px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Rate</th>
              <th className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase tracking-wider">Worst offenders (top 3)</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {checks.results.map((check, i) => {
              const rate = check.withData > 0 ? (check.satisfied / check.withData) * 100 : null;
              const isGood = rate != null && rate >= 99;
              const isInfo = check.id.info;
              return (
                <tr key={check.id.key} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{check.id.label}</div>
                    {isInfo && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Over-release is expected — treat as informational.
                      </div>
                    )}
                    {check.id.key === "insp" && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Balance Inspection not stored — showing structures where ProgInsp &gt; ProgGalv.
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums font-semibold">
                    {check.satisfied}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-muted-foreground">
                    {check.withData}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    <span className={`font-bold ${isInfo ? "text-sky-600 dark:text-sky-400" : isGood ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                      {rate != null ? `${rate.toFixed(1)}%` : "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {check.offenders.slice(0, 3).map((o) => (
                      <div key={`${o.project}|${o.structure}`} className="text-[11px]">
                        <span className="font-mono font-medium text-foreground">{o.project}/{o.structure}</span>
                        {" "}Δ{o.diff.toFixed(3)} MT
                      </div>
                    ))}
                    {check.offenders.length === 0 && check.withData > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">✓ All pass</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Tolerance: ±0.002 MT. Read-only — no imported values are changed.
        {rows.length > 0 && ` Covering ${rows.length} structures from the latest Order Review.`}
      </p>
    </div>
  );
}

// ─── Utility formatters (shared by multiple components below) ─────────────────

function mt3(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

function pct1(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(1)}%`;
}

function fmtChangeVal(v: string | number | null): string {
  if (v == null) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return v;
}

const RECON_STATUS_META: Record<
  DispatchReconciliationRow["status"],
  { label: string; cls: string }
> = {
  match: { label: "Match", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  mismatch: { label: "Mismatch", cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
  no_file: { label: "No file row", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  no_computed: { label: "No computed", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
};

type FgSortKey =
  | "structure"
  | "releaseMt"
  | "fileDespatchMt"
  | "computedFgMt"
  | "fgWipMt";

function ComputedFgContent() {
  const { available, asOnDate, rows, isLoading } = useFgRows();
  const [sortKey, setSortKey] = useState<FgSortKey>("structure");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const groups = useMemo(() => {
    const byProject = new Map<string, FgComputedRow[]>();
    for (const r of rows) {
      const key = r.project || "(Unassigned)";
      const list = byProject.get(key);
      if (list) list.push(r);
      else byProject.set(key, [r]);
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: FgComputedRow, b: FgComputedRow): number => {
      if (sortKey === "structure") return a.structure.localeCompare(b.structure) * dir;
      return ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir;
    };
    return [...byProject.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([project, list]) => {
        const sorted = [...list].sort(cmp);
        const subtotal = list.reduce(
          (acc, r) => ({
            releaseMt: acc.releaseMt + (r.releaseMt ?? 0),
            fileDespatchMt: acc.fileDespatchMt + (r.fileDespatchMt ?? 0),
            computedFgMt: acc.computedFgMt + (r.computedFgMt ?? 0),
            fgWipMt: r.fgWipMt != null ? (acc.fgWipMt ?? 0) + r.fgWipMt : acc.fgWipMt,
          }),
          { releaseMt: 0, fileDespatchMt: 0, computedFgMt: 0, fgWipMt: null as number | null },
        );
        return { project, list: sorted, subtotal };
      });
  }, [rows, sortKey, sortDir]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        releaseMt: acc.releaseMt + (r.releaseMt ?? 0),
        fileDespatchMt: acc.fileDespatchMt + (r.fileDespatchMt ?? 0),
        computedFgMt: acc.computedFgMt + (r.computedFgMt ?? 0),
        fgWipMt: r.fgWipMt != null ? (acc.fgWipMt ?? 0) + r.fgWipMt : acc.fgWipMt,
      }),
      { releaseMt: 0, fileDespatchMt: 0, computedFgMt: 0, fgWipMt: null as number | null },
    );
  }, [rows]);

  const toggleSort = (key: FgSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "structure" ? "asc" : "desc");
    }
  };

  const sortArrow = (key: FgSortKey) => (sortKey === key ? (sortDir === "asc" ? " \u2191" : " \u2193") : "");

  const handleExport = () => {
    exportToXlsx(
      "computed-fg.xlsx",
      [
        { label: "Project", field: "project" },
        { label: "Structure", field: "structure" },
        { label: "Release (MT)", field: "releaseMt", numeric: true, decimals: 3, total: true },
        { label: "File Despatch (MT)", field: "fileDespatchMt", numeric: true, decimals: 3, total: true },
        { label: "FG (Order Review) (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
        { label: "FG (WIP file) (MT)",     field: "fgWipMt",      numeric: true, decimals: 3, total: true },
      ],
      rows,
      { sheetName: "Computed FG" },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Computed FG</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Finished-goods figures per structure, two sources side by side.{" "}
            <span className="font-medium">FG (Order Review)</span> = OR file Galvanising minus Despatch (cumulative book figure).{" "}
            <span className="font-medium">FG (WIP file)</span> = WIP rows with Type "FG Pending For Dispatch" (physical yard stock now).
            A gap between them is normal — they measure different things.
          </p>
        </div>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExport} className="shrink-0">
            <FileDown className="h-4 w-4 mr-1.5" />
            Export
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            Loading...
          </CardContent>
        </Card>
      ) : !available ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No Computed FG yet. Upload an Order Review file on the Data tab to
            compute finished-goods figures.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No structures for the selected Job filter.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Structures{asOnDate ? ` — file as on ${formatDate(asOnDate)}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted sticky top-0 z-10">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold">Project</th>
                    <th className="px-3 py-2 font-semibold cursor-pointer select-none" onClick={() => toggleSort("structure")}>
                      Structure{sortArrow("structure")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("releaseMt")}>
                      Release (MT){sortArrow("releaseMt")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("fileDespatchMt")}>
                      File Despatch (MT){sortArrow("fileDespatchMt")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("computedFgMt")}>
                      FG (Order Review) (MT){sortArrow("computedFgMt")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("fgWipMt")}>
                      FG (WIP file) (MT){sortArrow("fgWipMt")}
                    </th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.project} className="border-b last:border-0">
                    {g.list.map((r, i) => (
                      <tr key={`${r.project}-${r.structure}`} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2">{i === 0 ? g.project || "(Unassigned)" : ""}</td>
                        <td className="px-3 py-2">{r.structure}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.releaseMt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fileDespatchMt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.computedFgMt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fgWipMt)}</td>
                      </tr>
                    ))}
                    <tr className="bg-muted/20 text-xs font-medium">
                      <td className="px-3 py-1.5 text-muted-foreground" colSpan={2}>
                        {g.project || "(Unassigned)"} subtotal ({g.list.length})
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.releaseMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.fileDespatchMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.computedFgMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.fgWipMt)}</td>
                    </tr>
                  </tbody>
                ))}
                <tfoot className="border-t-2 bg-muted font-semibold sticky bottom-0 z-10">
                  <tr>
                    <td className="px-3 py-2" colSpan={2}>Grand total ({rows.length})</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.releaseMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.fileDespatchMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.computedFgMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.fgWipMt)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OrderReconciliationContent() {
  const { data: order, isLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });
  const { filters } = useTracker();
  const namedJobSet2 = useActiveJobSet();
  const activeJobSet = useMemo(() => {
    if (isNamedJobSetFilter(filters.job)) return namedJobSet2;
    // Combo keys like "920 - C" — extract the plain job code for project-level rows
    if (filters.selectedJobs.length > 0)
      return new Set(filters.selectedJobs.map(c => c.includes(' - ') ? c.split(' - ')[0] : c));
    if (filters.job && filters.job !== MULTI_JOBS_FILTER_VALUE) return new Set([filters.job]);
    return null;
  }, [filters.job, filters.selectedJobs, namedJobSet2]);

  const recon = order?.reconciliation;
  const allReconRows = recon?.rows ?? [];
  const rows = useMemo(
    () => (activeJobSet ? allReconRows.filter((r) => activeJobSet.has(r.project ?? "")) : allReconRows),
    [allReconRows, activeJobSet],
  );
  const visibleMatched = useMemo(() => rows.filter((r) => r.status === "match").length, [rows]);
  const visibleMismatched = useMemo(() => rows.filter((r) => r.status === "mismatch").length, [rows]);

  const allBalRows = order?.balanceReconciliation?.rows ?? [];
  const visibleBalRows = useMemo<BalanceReconciliationRow[]>(
    () => (activeJobSet ? allBalRows.filter((r) => activeJobSet.has(r.project ?? "")) : allBalRows),
    [allBalRows, activeJobSet],
  );
  const visibleRelMatched = useMemo(() => visibleBalRows.filter((r) => r.releaseStatus === "match").length, [visibleBalRows]);
  const visibleRelMismatched = useMemo(() => visibleBalRows.filter((r) => r.releaseStatus === "mismatch").length, [visibleBalRows]);
  const visibleDispMatched = useMemo(() => visibleBalRows.filter((r) => r.dispatchStatus === "match").length, [visibleBalRows]);
  const visibleDispMismatched = useMemo(() => visibleBalRows.filter((r) => r.dispatchStatus === "mismatch").length, [visibleBalRows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Order Reconciliation</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Compares the dispatch tonnage stated in the latest Order Review file
          against the dispatch computed from WIP marks leaving the Yard. Rows
          differing beyond the {recon?.tolerancePct ?? 1}% tolerance are flagged.
        </p>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            Loading...
          </CardContent>
        </Card>
      ) : !order?.available ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No Order Review file ingested yet. Upload one on the Data tab.
          </CardContent>
        </Card>
      ) : (
        <>
          {order.fileImport && (
            <Card className="border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
                  File Intake Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">As On</span>
                    <span className="font-bold text-lg tabular-nums">{formatDate(order.fileImport.asOnDate)}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Rows Kept</span>
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.summary.rowsKept.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Projects</span>
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.summary.projectsFound}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">File Dispatch (MT)</span>
                    <span className="font-bold text-lg tabular-nums">{mt3(order.fileImport.summary.totalFileDespatchMt)}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Matched to WIP</span>
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.summary.matchedToWip.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Unmatched to WIP</span>
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.summary.unmatchedToWip.toLocaleString()}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {order.fileImport?.changeLog && (
            <Card className="border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
                  Latest Upload Changes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Inserted</span>
                    <span className="font-bold text-lg tabular-nums text-emerald-600 dark:text-emerald-400">{order.fileImport.changeLog.inserted.length.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Updated</span>
                    <span className="font-bold text-lg tabular-nums text-blue-600 dark:text-blue-400">{order.fileImport.changeLog.updated.length.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Unchanged</span>
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.changeLog.unchanged.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="block text-muted-foreground text-xs uppercase mb-1">Not in this file</span>
                    <span className="font-bold text-lg tabular-nums text-rose-600 dark:text-rose-400">{order.fileImport.changeLog.flagged.length.toLocaleString()}</span>
                  </div>
                </div>
                {order.fileImport.changeLog.updated.length > 0 && (
                  <div className="mt-4 overflow-auto max-h-[70vh]">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted sticky top-0 z-10">
                        <tr className="text-left">
                          <th className="px-3 py-2 font-semibold">Project</th>
                          <th className="px-3 py-2 font-semibold">Structure</th>
                          <th className="px-3 py-2 font-semibold">Changed Fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.fileImport.changeLog.updated.map((u) => (
                          <tr key={`${u.project}-${u.structure}`} className="border-b last:border-0 hover:bg-muted/30 align-top">
                            <td className="px-3 py-2">{u.project}</td>
                            <td className="px-3 py-2">{u.structure}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-col gap-0.5">
                                {u.changes.map((c) => (
                                  <span key={c.field} className="text-xs">
                                    <span className="font-medium">{c.field}</span>
                                    <span className="text-muted-foreground">: {fmtChangeVal(c.from)} &rarr; {fmtChangeVal(c.to)}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Structures</div>
                <div className="text-2xl font-bold mt-1 tabular-nums">{rows.length}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Matched</div>
                <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{visibleMatched}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Mismatched</div>
                <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{visibleMismatched}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground text-sm">
                  No structures to reconcile.
                </div>
              ) : (
                <div className="overflow-auto max-h-[70vh]">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted sticky top-0 z-10">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-semibold">Project</th>
                        <th className="px-3 py-2 font-semibold">Structure</th>
                        <th className="px-3 py-2 font-semibold text-right">File Dispatch</th>
                        <th className="px-3 py-2 font-semibold text-right">Computed Dispatch</th>
                        <th className="px-3 py-2 font-semibold text-right">Diff</th>
                        <th className="px-3 py-2 font-semibold text-right">% Diff</th>
                        <th className="px-3 py-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const meta = RECON_STATUS_META[r.status];
                        return (
                          <tr key={`${r.project}-${r.structure}`} className="border-b last:border-0 hover:bg-muted/30">
                            <td className="px-3 py-2">{r.project}</td>
                            <td className="px-3 py-2">{r.structure}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fileDespatchMt)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{mt3(r.computedDispatchMt)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{mt3(r.diffMt)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{pct1(r.diffPct)}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>
                                {meta.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {order.balanceReconciliation && (
            <>
              <div className="pt-2">
                <h2 className="text-lg font-bold tracking-tight">Order Balance Reconciliation</h2>
                <p className="text-muted-foreground text-sm mt-1">
                  Cross-checks the two order balances computed from Col J (WO
                  Order Qty) against the file&apos;s own stated balances: Release
                  Balance (J minus Release) vs file col S, and Dispatch Balance (J
                  minus File Despatch) vs file col W. Rows differing beyond{" "}
                  {order.balanceReconciliation.tolerancePct}% (min{" "}
                  {mt3(order.balanceReconciliation.absFloorMt)} MT) are flagged.
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Release Matched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{visibleRelMatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Release Mismatched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{visibleRelMismatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Dispatch Matched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{visibleDispMatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Dispatch Mismatched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{visibleDispMismatched}</div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-0">
                  {visibleBalRows.length === 0 ? (
                    <div className="py-10 text-center text-muted-foreground text-sm">
                      No structures to reconcile.
                    </div>
                  ) : (
                    <div className="overflow-auto max-h-[70vh]">
                      <table className="w-full text-sm">
                        <thead className="border-b bg-muted sticky top-0 z-10">
                          <tr className="text-left">
                            <th className="px-3 py-2 font-semibold">Project</th>
                            <th className="px-3 py-2 font-semibold">Structure</th>
                            <th className="px-3 py-2 font-semibold text-right">WO Order Qty</th>
                            <th className="px-3 py-2 font-semibold text-right">Rel. Bal (calc)</th>
                            <th className="px-3 py-2 font-semibold text-right">Rel. Bal (file)</th>
                            <th className="px-3 py-2 font-semibold text-right">Rel. Diff</th>
                            <th className="px-3 py-2 font-semibold">Rel. Status</th>
                            <th className="px-3 py-2 font-semibold text-right">Disp. Bal (calc)</th>
                            <th className="px-3 py-2 font-semibold text-right">Disp. Bal (file)</th>
                            <th className="px-3 py-2 font-semibold text-right">Disp. Diff</th>
                            <th className="px-3 py-2 font-semibold">Disp. Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleBalRows.map((r: BalanceReconciliationRow) => {
                            const rMeta = RECON_STATUS_META[r.releaseStatus];
                            const dMeta = RECON_STATUS_META[r.dispatchStatus];
                            return (
                              <tr key={`${r.project}-${r.structure}`} className="border-b last:border-0 hover:bg-muted/30">
                                <td className="px-3 py-2">{r.project}</td>
                                <td className="px-3 py-2">{r.structure}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.woOrderQtyMt)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.computedReleaseBalanceMt)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fileReleaseBalanceMt)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.releaseDiffMt)}</td>
                                <td className="px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${rMeta.cls}`}>
                                    {rMeta.label}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.computedDispatchBalanceMt)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fileDispatchBalanceMt)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{mt3(r.dispatchDiffMt)}</td>
                                <td className="px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${dMeta.cls}`}>
                                    {dMeta.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Users Management (admin only) ────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
        role === "admin"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {role === "admin" ? <ShieldCheck className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
      {role === "admin" ? "Admin" : "User"}
    </span>
  );
}

function AddUserForm({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const createUser = useCreateUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast({
        title: "Password is too short",
        description: "The initial password must be at least 6 characters.",
        variant: "destructive",
      });
      return;
    }
    if (password !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "Enter the same initial password in both fields.",
        variant: "destructive",
      });
      return;
    }
    createUser.mutate(
      {
        data: {
          email: email.trim().toLowerCase(),
          displayName: displayName.trim() || undefined,
          password,
          role,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({
            title: "User created",
            description: `${email} was added with the initial password you provided.`,
          });
          onClose();
        },
        onError: (err) => {
          const status = (err as { status?: number })?.status;
          toast({
            title: "Failed to create user",
            description: status === 409 ? "Email already exists." : "An error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card className="border-border mb-6">
      <CardHeader>
        <CardTitle className="text-base">Add user</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-email">Email</Label>
              <Input
                id="new-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="user@vijaytransmission.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-display">Display name (optional)</Label>
              <Input
                id="new-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Full name"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Initial password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                placeholder="At least 6 characters"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password-confirm">Confirm initial password</Label>
              <Input
                id="new-password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                placeholder="Re-enter password"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="radio" name="role" value="user" checked={role === "user"} onChange={() => setRole("user")} />
                User
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="radio" name="role" value="admin" checked={role === "admin"} onChange={() => setRole("admin")} />
                Admin
              </label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The user will sign in with this initial password and must set a new one on first login.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={createUser.isPending} size="sm">
              {createUser.isPending ? "Creating..." : "Create user"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function UserRow({ user, currentUserId }: { user: AppUser; currentUserId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const resetPassword = useResetUserPassword();
  const updateRole = useUpdateUserRole();
  const deleteUserMutation = useDeleteUser();
  const isSelf = user.id === currentUserId;

  const handleResetPassword = () => {
    if (!confirm(`Reset password for ${user.email}? They will need to set a new one on next login.`)) return;
    resetPassword.mutate(
      { id: user.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "Password reset", description: `${user.email} will set a new password on next login.` });
        },
        onError: () => toast({ title: "Failed to reset password", variant: "destructive" }),
      },
    );
  };

  const handleToggleRole = () => {
    const newRole = user.role === "admin" ? "user" : "admin";
    updateRole.mutate(
      { id: user.id, data: { role: newRole } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "Role updated", description: `${user.email} is now ${newRole}.` });
        },
        onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
      },
    );
  };

  const handleDelete = () => {
    if (!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    deleteUserMutation.mutate(
      { id: user.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "User deleted", description: `${user.email} has been removed.` });
        },
        onError: () => toast({ title: "Failed to delete user", variant: "destructive" }),
      },
    );
  };

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <td className="py-2.5 px-3">
        <div className="font-medium text-sm">{user.displayName || <span className="text-muted-foreground italic">—</span>}</div>
        <div className="text-xs text-muted-foreground">{user.email}</div>
      </td>
      <td className="py-2.5 px-3">
        <RoleBadge role={user.role} />
      </td>
      <td className="py-2.5 px-3 text-xs">
        {user.mustChangePassword ? (
          <span className="text-amber-600 font-medium">Must change</span>
        ) : (
          <span className="text-muted-foreground">Set</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground tabular-nums">
        {formatDate(user.createdAt.split("T")[0]!)}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1 justify-end flex-wrap">
          <Button
            variant="ghost" size="sm" className="h-7 px-2 text-xs"
            onClick={handleResetPassword} disabled={resetPassword.isPending}
            title="Reset password to default"
          >
            <RotateCcw className="w-3 h-3 mr-1" /> Reset pw
          </Button>
          {!isSelf && (
            <>
              <Button
                variant="ghost" size="sm" className="h-7 px-2 text-xs"
                onClick={handleToggleRole} disabled={updateRole.isPending}
                title={user.role === "admin" ? "Demote to user" : "Promote to admin"}
              >
                {user.role === "admin" ? <Shield className="w-3 h-3 mr-1" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                {user.role === "admin" ? "Make user" : "Make admin"}
              </Button>
              <Button
                variant="ghost" size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={handleDelete} disabled={deleteUserMutation.isPending}
                title="Delete user"
              >
                <Trash2 className="w-3 h-3 mr-1" /> Delete
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function UsersContent() {
  const { data: authStatus } = useGetAuthStatus({ query: { queryKey: getGetAuthStatusQueryKey() } });
  const { data, isLoading } = useListUsers({ query: { queryKey: getListUsersQueryKey() } });
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const users = data?.users ?? [];
  const currentUserId = (authStatus as unknown as { id?: string } | undefined)?.id ?? "";

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? users.filter((u) => u.email.toLowerCase().includes(q) || (u.displayName ?? "").toLowerCase().includes(q))
      : users;
  }, [users, search]);

  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <div className="space-y-4">
      <Card className="border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-lg">Users</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {users.length} total — {adminCount} admin{adminCount !== 1 ? "s" : ""}
              </p>
            </div>
            <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
              <UserPlus className="w-4 h-4 mr-1.5" />
              Add user
            </Button>
          </div>
        </CardHeader>
      </Card>

      {showAdd && <AddUserForm onClose={() => setShowAdd(false)} />}

      <Card className="border-border">
        <CardContent className="p-0">
          <div className="p-3 border-b border-border">
            <Input
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground text-sm">Loading users...</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No users found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">User</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Role</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Password</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Created</th>
                    <th className="py-2 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((user) => (
                    <UserRow key={user.id} user={user} currentUserId={currentUserId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <LoginActivitySection users={users} />
    </div>
  );
}

// ── Usage Activity ────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 5 * 60 * 1000; // must match server constant

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function sessionStatus(s: UserSessionEntry, now: number): {
  statusLabel: string;
  statusClass: string;
} {
  if (s.logoutAt) {
    return {
      statusLabel: "Ended",
      statusClass: "text-muted-foreground",
    };
  }
  if (!s.lastHeartbeatAt) {
    return s.busySeconds !== null
      ? { statusLabel: "Recorded", statusClass: "text-muted-foreground" }
      : { statusLabel: "Legacy session", statusClass: "text-muted-foreground" };
  }
  const anchor = s.lastHeartbeatAt;
  const idleMs = now - new Date(anchor).getTime();
  if (idleMs < SESSION_IDLE_MS) {
    return {
      statusLabel: s.lastClientState === "busy" ? "Busy" : "Idle",
      statusClass: s.lastClientState === "busy"
        ? "text-green-600 font-medium"
        : "text-amber-700 dark:text-amber-400 font-medium",
    };
  }
  const idleMinutes = Math.floor(idleMs / 60_000);
  return {
    statusLabel: `Idle (${idleMinutes}m ago)`,
    statusClass: "text-muted-foreground",
  };
}

function TimelineEntry({ entry }: { entry: UserSessionEntry["timeline"][number] }) {
  const description = entry.kind === "session_start"
    ? "Session started"
    : entry.kind === "session_end"
      ? "Session ended"
      : entry.kind === "page_visit"
        ? `Visited ${entry.pageLabel || entry.pagePath || "a page"}`
        : entry.kind === "report_generated"
          ? `Generated ${entry.reportName || "a report"}${entry.fileType ? ` (${entry.fileType.toUpperCase()})` : ""}`
          : `${entry.pageLabel === "hidden" ? "App hidden" : "App visible"}${entry.pagePath ? ` — ${entry.pagePath}` : ""}`;
  return (
    <li className="flex gap-3 text-xs">
      <span className="tabular-nums text-muted-foreground shrink-0">{formatDateTime(entry.at)}</span>
      <span>{description}</span>
    </li>
  );
}

function SessionUsageRow({ session, now }: { session: UserSessionEntry; now: number }) {
  const [open, setOpen] = useState(false);
  const status = sessionStatus(session, now);
  const lastSeen = session.lastHeartbeatAt ?? session.lastActivityAt ?? session.logoutAt;
  return (
    <Fragment>
      <tr className="border-b border-border hover:bg-muted/20 transition-colors">
        <td className="py-2 px-3">
          <div className="font-medium text-sm">{session.displayName || <span className="italic text-muted-foreground">—</span>}</div>
          <div className="text-xs text-muted-foreground">{session.email}</div>
        </td>
        <td className="py-2 px-3 text-xs tabular-nums whitespace-nowrap">{formatTime(session.loginAt)}</td>
        <td className={`py-2 px-3 text-xs tabular-nums whitespace-nowrap ${status.statusClass}`}>
          {status.statusLabel}
          {lastSeen && <div className="text-[10px] font-normal text-muted-foreground">last seen {formatTime(lastSeen)}</div>}
        </td>
        <td className="py-2 px-3 text-xs tabular-nums whitespace-nowrap">{formatDuration(session.busySeconds ?? null)}</td>
        <td className="py-2 px-3 text-xs tabular-nums whitespace-nowrap">{formatDuration(session.idleSeconds ?? null)}</td>
        <td className="py-2 px-3 text-xs tabular-nums text-center">{session.pageVisitCount}</td>
        <td className="py-2 px-3 text-xs tabular-nums text-center">{session.reportCount}</td>
        <td className="py-2 px-3 text-xs max-w-[180px] truncate">{session.lastPagePath || "—"}</td>
        <td className="py-2 px-3 text-xs">
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Timeline"}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/10">
          <td colSpan={9} className="px-5 py-3">
            {session.timeline.length === 0 ? (
              <p className="text-xs text-muted-foreground">No detailed events were captured for this legacy session.</p>
            ) : (
              <ol className="space-y-1.5">
                {session.timeline.map((entry, index) => (
                  <TimelineEntry key={`${entry.kind}-${entry.at}-${index}`} entry={entry} />
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function DayBlock({ date, sessions, now }: { date: string; sessions: UserSessionEntry[]; now: number }) {
  const [open, setOpen] = useState(true);
  const displayDate = formatDate(date);
  const uniqueUsers = new Set(sessions.map((s) => s.userId)).size;
  const users = Array.from(new Map(sessions.map((session) => [session.userId, session])).values()).map((user) => {
    const ownSessions = sessions.filter((session) => session.userId === user.userId);
    const knownBusy = ownSessions.filter((session) => session.busySeconds != null);
    const knownIdle = ownSessions.filter((session) => session.idleSeconds != null);
    return {
      id: user.userId,
      name: user.displayName || user.email,
      sessions: ownSessions.length,
      busySeconds: knownBusy.length
        ? knownBusy.reduce((sum, session) => sum + (session.busySeconds ?? 0), 0)
        : null,
      idleSeconds: knownIdle.length
        ? knownIdle.reduce((sum, session) => sum + (session.idleSeconds ?? 0), 0)
        : null,
      pages: ownSessions.reduce((sum, session) => sum + session.pageVisitCount, 0),
      reports: ownSessions.reduce((sum, session) => sum + session.reportCount, 0),
    };
  });

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className="font-semibold text-sm">{displayDate}</span>
          <span className="text-xs text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""} — {uniqueUsers} user{uniqueUsers !== 1 ? "s" : ""}
          </span>
        </div>
      </button>
      {open && (
        <div className="space-y-3 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {users.map((user) => (
              <div key={user.id} className="rounded-md border border-border bg-background px-3 py-2">
                <div className="font-medium text-sm truncate">{user.name}</div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Busy <strong className="text-foreground tabular-nums">{formatDuration(user.busySeconds)}</strong></span>
                  <span>Idle <strong className="text-foreground tabular-nums">{formatDuration(user.idleSeconds)}</strong></span>
                  <span>{user.pages} page visit{user.pages !== 1 ? "s" : ""}</span>
                  <span>{user.reports} report{user.reports !== 1 ? "s" : ""}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">User</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Started</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Status / Last Seen</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Busy</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Idle</th>
                  <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">Pages</th>
                  <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">Reports</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Last Page</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Details</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => <SessionUsageRow key={session.id} session={session} now={now} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function LoginActivitySection({ users }: { users: AppUser[] }) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const [startDate, setStartDate] = useState(() =>
    dateInputValue(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)),
  );
  const [endDate, setEndDate] = useState(() => dateInputValue(new Date()));
  const [appliedFilters, setAppliedFilters] = useState(() => ({
    userId: "",
    startDate: dateInputValue(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)),
    endDate: dateInputValue(new Date()),
  }));
  const validDateRange = Boolean(startDate && endDate && startDate <= endDate);
  const activityParams = useMemo(() => ({
    ...(appliedFilters.userId ? { userId: appliedFilters.userId } : {}),
    startDate: appliedFilters.startDate,
    endDate: appliedFilters.endDate,
  }), [appliedFilters]);
  const { data, isLoading } = useGetUserActivity(activityParams, {
    query: {
      enabled: validDateRange,
      queryKey: getGetUserActivityQueryKey(activityParams),
      refetchInterval: 60_000,
    },
  });
  const days = data?.days ?? [];
  const totalSessions = data?.totalSessions ?? 0;
  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Usage Activity</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLoading
              ? "Loading..."
              : `${totalSessions} session${totalSessions !== 1 ? "s" : ""} in this filtered range — busy/idle time is measured from browser activity, not login duration`}
          </p>
        </div>
      </div>

      <Card className="border-border">
        <CardContent className="p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_repeat(2,minmax(150px,180px))_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="usage-user-filter" className="text-xs font-semibold">User</Label>
              <select
                id="usage-user-filter"
                value={selectedUserId}
                onChange={(event) => {
                  const userId = event.target.value;
                  setSelectedUserId(userId);
                  setAppliedFilters((previous) => ({ ...previous, userId }));
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">All users</option>
                {users
                  .slice()
                  .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email))
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.displayName || user.email}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="usage-start-date" className="text-xs font-semibold">From</Label>
              <Input
                id="usage-start-date"
                type="date"
                value={startDate}
                onChange={(event) => {
                  const nextStartDate = event.target.value;
                  setStartDate(nextStartDate);
                  if (nextStartDate && endDate && nextStartDate <= endDate) {
                    setAppliedFilters((previous) => ({ ...previous, startDate: nextStartDate }));
                  }
                }}
                aria-label="Usage activity start date"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="usage-end-date" className="text-xs font-semibold">To</Label>
              <Input
                id="usage-end-date"
                type="date"
                value={endDate}
                onChange={(event) => {
                  const nextEndDate = event.target.value;
                  setEndDate(nextEndDate);
                  if (startDate && nextEndDate && startDate <= nextEndDate) {
                    setAppliedFilters((previous) => ({ ...previous, endDate: nextEndDate }));
                  }
                }}
                aria-label="Usage activity end date"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelectedUserId("");
                const resetStartDate = dateInputValue(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000));
                const resetEndDate = dateInputValue(new Date());
                setStartDate(resetStartDate);
                setEndDate(resetEndDate);
                setAppliedFilters({ userId: "", startDate: resetStartDate, endDate: resetEndDate });
              }}
            >
              Reset
            </Button>
          </div>
          {!validDateRange && (
            <p className="mt-2 text-xs text-destructive">Choose a valid date span where From is on or before To.</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Showing {startDate && endDate ? `${formatDate(startDate)} to ${formatDate(endDate)}` : "a custom date span"}.
            Events are counted on the day they occurred.
          </p>
        </CardContent>
      </Card>


      {!validDateRange ? (
        <Card className="border-border">
          <CardContent className="p-6 text-center text-muted-foreground text-sm">Activity is waiting for a valid date range.</CardContent>
        </Card>
      ) : isLoading ? (
        <Card className="border-border">
          <CardContent className="p-6 text-center text-muted-foreground text-sm">Loading activity...</CardContent>
        </Card>
      ) : days.length === 0 ? (
        <Card className="border-border">
          <CardContent className="p-6 text-center text-muted-foreground text-sm">No activity yet.</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {days.map((day) => (
            <DayBlock key={day.date} date={day.date} sessions={day.sessions} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data Check Content — DC0–DC11 integrity checks
// ---------------------------------------------------------------------------

type DcViolation = { project: string; structure: string; fields: Record<string, string | null> };
type DcHardRule  = { id: string; label: string; toleranceMt: number; structuresEvaluated: number; violationCount: number; pass: boolean; violations: DcViolation[] };
type DcWarning   = { id: string; label: string; structureCount: number; totalMt: number; worstProject: string; worstStructure: string; worstMt: number; markCount?: number };
type DcWipBucket = { name: string; mt: number; marks: number };
type DcTransition = { from: string; to: string; count: number; weightMt: number };

type DcMarkMovementAvailable = {
  available: true;
  prevImportId: number;
  currImportId: number;
  prevDate: string;
  currDate: string;
  identityKey: string;
  trackedMarks: number;
  forwardMoves: number;
  backwardMoves: number;
  backwardWeightMt: number;
  backwardTransitions: DcTransition[];
  leavingFgCount: number;
  leavingFgWeightMt: number;
  leavingFgTransitions: DcTransition[];
  vanishedCount: number;
  vanishedWeightMt: number;
  vanishedByLastActivity: { activity: string; count: number; weightMt: number }[];
};
type DcMarkMovementGated = {
  available: false;
  reason: string;
  prevImportId: number | null;
  currImportId: number;
  prevDate: string | null;
  currDate: string;
};
type DcMarkMovementResult = DcMarkMovementAvailable | DcMarkMovementGated;

type DataCheckResponse = {
  available: boolean;
  orImportId: number | null;
  orAsOnDate: string | null;
  orOverride: { reason: string; at: string; by: string } | null;
  wipImportId: number | null;
  /** False for pre-type-column imports; DC6 and DC16 are not evaluated for those. */
  wipHasTypeData: boolean;
  structuresEvaluated: number;
  hardRuleFailures: number;
  hardRules: DcHardRule[];
  warnings: DcWarning[];
  wipBuckets: DcWipBucket[];
  wipUnclassifiedMarks: number;
  wipTotalMt: number;
  wipTotalMarks: number;
  ntltBuckets: DcWipBucket[];
  ntltUnclassifiedMarks: number;
  ntltUnclassifiedMt: number;
  ntltTotalMt: number;
  ntltTotalMarks: number;
  dc0StoredTotalRows: number;
  markMovement: DcMarkMovementResult | null;
  dc17: Dc17Result | null;
  sourceColumnWatch: DcSourceColumnWatch | null;
};

// Source Column Watch types (mirrored from API). Descriptive only — never a DC
// rule, never affects the banner or any pass/fail count.
type SourceWatchValue = { value: string | null; marks: number; weightMt: number };
type SourceWatchColumn = {
  key: string;
  header: string;
  present: boolean;
  mode?: "coverage" | "distribution" | "numeric";
  populatedCount?: number;
  numericSummary?: { min: number; max: number; mean: number } | null;
  values: SourceWatchValue[];
  crossTab: { orderNature: string; value: string | null; marks: number }[];
};
type DcSourceColumnWatch = {
  currImportId: number;
  currDayKey: string;
  prevImportId: number | null;
  prevDayKey: string | null;
  current: SourceWatchColumn[] | null;
  previous: SourceWatchColumn[] | null;
};

// DC17 types (mirrored from API)
type Dc17StructureRow = {
  project: string;
  structure: string;
  j: number;
  q: number;
  w: number;
  gap: number;
  category: "A" | "B" | "C" | "D" | "E" | "F" | "G";
};
type Dc17Result = {
  structuresCompared: number;
  structuresClean: number;
  flagged: Dc17StructureRow[];
  byCategory: Record<string, { count: number; totalMt: number }>;
};

const DATA_CHECK_QUERY_KEY = ["data-check"] as const;

async function fetchDataCheck(): Promise<DataCheckResponse> {
  const r = await fetch("/api/reports/data-check", { credentials: "include" });
  if (!r.ok) throw new Error(`Data check fetch failed: ${r.status}`);
  return r.json() as Promise<DataCheckResponse>;
}

function DataCheckContent() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: DATA_CHECK_QUERY_KEY,
    queryFn: fetchDataCheck,
    staleTime: 60_000,
  });

  const handleExport = async () => {
    if (!data?.available) return;

    // Sheet 1: Hard Rules summary
    const hardRulesSheet: XlsxSheet = {
      name: "Hard Rules",
      columns: [
        { field: "id",        label: "Rule",       numeric: false },
        { field: "label",     label: "Description",numeric: false },
        { field: "tol",       label: "Tolerance (MT)", numeric: true, decimals: 4 },
        { field: "evaluated", label: "Evaluated",  numeric: true, decimals: 0 },
        { field: "violations",label: "Violations", numeric: true, decimals: 0 },
        { field: "pass",      label: "Result",     numeric: false },
      ],
      rows: data.hardRules.map((r) => ({
        id: r.id, label: r.label, tol: r.toleranceMt,
        evaluated: r.structuresEvaluated, violations: r.violationCount,
        pass: r.pass ? "PASS" : "FAIL",
      })),
    };

    // Sheet 2: Warnings
    const warningsSheet: XlsxSheet = {
      name: "Warnings",
      columns: [
        { field: "id",       label: "Warning",      numeric: false },
        { field: "label",    label: "Description",  numeric: false },
        { field: "count",    label: "Structures",   numeric: true, decimals: 0 },
        { field: "marks",    label: "Marks",        numeric: true, decimals: 0 },
        { field: "totalMt",  label: "Total MT (signed)", numeric: true, decimals: 3 },
        { field: "worstProj",label: "Worst Project",numeric: false },
        { field: "worstStr", label: "Worst Structure",numeric: false },
        { field: "worstMt",  label: "Worst MT",     numeric: true, decimals: 3 },
      ],
      rows: data.warnings.map((w) => ({
        id: w.id, label: w.label, count: w.structureCount, marks: w.markCount ?? null, totalMt: w.totalMt,
        worstProj: w.worstProject, worstStr: w.worstStructure, worstMt: w.worstMt,
      })),
    };

    // Sheet 3: WIP Buckets (DC6)
    const wipSheet: XlsxSheet = {
      name: "DC6 WIP Buckets",
      columns: [
        { field: "name",  label: "Bucket",    numeric: false },
        { field: "mt",    label: "MT",        numeric: true, decimals: 3 },
        { field: "marks", label: "Marks",     numeric: true, decimals: 0 },
      ],
      rows: [
        ...data.wipBuckets.map((b) => ({ name: b.name, mt: b.mt, marks: b.marks })),
        { name: "Unclassified", mt: 0, marks: data.wipUnclassifiedMarks },
        { name: "TOTAL", mt: data.wipTotalMt, marks: data.wipTotalMarks },
      ],
    };

    // Sheet 4: All violations (DC1–DC5)
    const allViolations = data.hardRules
      .filter((r) => r.id !== "DC6" && r.violations.length > 0)
      .flatMap((r) => r.violations.map((v) => ({ rule: r.id, project: v.project, structure: v.structure, ...v.fields })));

    const violCols: XlsxColumn[] = allViolations.length > 0
      ? [
          // Export-only: on screen each rule's violations render under the rule's own card.
          { field: "rule",      label: "Rule",      numeric: false, headerNote: "Export-only column — on screen, violations are grouped under each rule's card." },
          { field: "project",   label: "Project",   numeric: false },
          { field: "structure", label: "Structure", numeric: false },
          ...Object.keys(allViolations[0]).filter((k) => !["rule","project","structure"].includes(k)).map((k) => ({
            field: k, label: k, numeric: false,
          })),
        ]
      : [{ field: "note", label: "Note", numeric: false }];

    const violRows = allViolations.length > 0
      ? allViolations
      : [{ note: "No violations found." }];

    const violSheet: XlsxSheet = { name: "All Violations", columns: violCols, rows: violRows };

    // Sheet 5: DC17 flagged structures
    const dc17Sheet: XlsxSheet = data.dc17
      ? {
          name: "DC17 Order-vs-WIP Gap",
          columns: [
            // Export-only: on screen these render as category descriptions and
            // group headings, not columns.
            { field: "cat",       label: "Category",    numeric: false, headerNote: "Export-only column — on screen, categories render as headings above the table." },
            { field: "group",     label: "Group",       numeric: false, headerNote: "Export-only column — on screen, groups render as headings above the table." },
            { field: "project",   label: "Project",     numeric: false },
            { field: "structure", label: "Structure",   numeric: false },
            // Labels match the on-screen DC17 detail table headers, with the
            // unit suffix added so the sheet is self-describing.
            { field: "j",         label: "J (WO Qty) (MT)",   numeric: true, decimals: 3 },
            { field: "q",         label: "Q (Despatch) (MT)", numeric: true, decimals: 3 },
            { field: "w",         label: "W (WIP) (MT)",      numeric: true, decimals: 3 },
            { field: "gap",       label: "Gap (MT)",          numeric: true, decimals: 3 },
          ],
          rows: data.dc17.flagged.map((r) => ({
            cat: r.category,
            group: DC17_CAT_INFO[r.category]?.group === "lag" ? "Likely job-card lag" : "Needs investigation",
            project: r.project,
            structure: r.structure,
            j: r.j,
            q: r.q,
            w: r.w,
            gap: r.gap,
          })),
        }
      : { name: "DC17 Order-vs-WIP Gap", columns: [{ field: "note", label: "Note", numeric: false }], rows: [{ note: "No WIP import available." }] };

    // Sheet 6: Source Column Watch — one block per watched column (descriptive only).
    const watch = data.sourceColumnWatch;
    const watchRows: Record<string, string | number>[] = [];
    if (watch) {
      const cols = watch.current ?? [];
      if (watch.current === null) {
        watchRows.push({ column: "(all watched columns)", value: "not present in this file", marks: "", weightMt: "", note: `import #${watch.currImportId}` });
      }
      for (const c of cols) {
        if (!c.present) {
          watchRows.push({ column: c.header, value: "not present in this file", marks: "", weightMt: "", note: "" });
          continue;
        }
        const total = c.values.reduce((s, v) => s + v.marks, 0);
        const prevCol = watch.previous?.find((p) => p.key === c.key && p.present) ?? null;
        const prevLabels = new Set((prevCol?.values ?? []).map((v) => v.value ?? "(blank)"));
        for (const v of c.values) {
          const label = v.value ?? "(blank)";
          watchRows.push({
            column: c.header,
            value: label,
            marks: v.marks,
            weightMt: v.weightMt,
            note: [
              total > 0 ? `${((v.marks / total) * 100).toFixed(1)}%` : "",
              prevCol && !prevLabels.has(label) ? "NEW VALUE vs previous import" : "",
              c.values.length === 1 ? "single value — no variation, carries no information yet" : "",
            ].filter(Boolean).join(" · "),
          });
        }
        for (const ct of c.crossTab) {
          watchRows.push({
            column: `${c.header} × Order Nature`,
            value: `${ct.orderNature} / ${ct.value ?? "(blank)"}`,
            marks: ct.marks,
            weightMt: "",
            note: "",
          });
        }
      }
    }
    const watchSheet: XlsxSheet = {
      name: "Source Column Watch",
      columns: [
        // Column and Note are export-only: on screen each watched column has its
        // own panel, and share/new-value context renders as badges, not a column.
        { field: "column",   label: "Column",      numeric: false, headerNote: "Export-only column — on screen each watched column has its own panel." },
        { field: "value",    label: "Value",       numeric: false },
        { field: "marks",    label: "Marks",       numeric: false },
        { field: "weightMt", label: "Weight (MT)", numeric: false },
        { field: "note",     label: "Note",        numeric: false, headerNote: "Export-only column — carries the on-screen Share / Prev share / NEW VALUE context." },
      ],
      rows: watchRows.length > 0 ? watchRows : [{ column: "", value: "No WIP import available.", marks: "", weightMt: "", note: "" }],
    };

    await exportToXlsxSheets(
      `DataCheck_${exportTimestamp()}.xlsx`,
      [hardRulesSheet, warningsSheet, wipSheet, violSheet, dc17Sheet, watchSheet],
    );
  };

  // Overall banner
  const allClear = data?.available && data.hardRuleFailures === 0 && data.dc0StoredTotalRows === 0;

  // Violation counts for banner severity scaling.
  // Total structures that appear in at least one hard-rule violation (DC1–DC6).
  const totalViolatingStructures = (data?.hardRules ?? [])
    .filter((r) => !r.pass)
    .reduce((s, r) => s + r.violationCount, 0);
  const dc0Fail = (data?.dc0StoredTotalRows ?? 0) > 0;
  const failingRuleCount = (data?.hardRuleFailures ?? 0) + (dc0Fail ? 1 : 0);
  // Share of OR structures affected by DC1–DC5 violations (DC0 and DC6 are not structure-count rules)
  const evalTotal = data?.structuresEvaluated ?? 0;
  const sharePct = evalTotal > 0 ? (totalViolatingStructures / evalTotal) * 100 : 0;
  // "Minor" = < 1% of structures and all individual discrepancies are small
  const isMajorViolation = sharePct >= 1 || totalViolatingStructures >= 10 || dc0Fail;

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Data Integrity Check</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            DC0–DC5 are hard rules (PASS / FAIL). DC7–DC11 are warnings (non-zero counts are expected).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
          {data?.available && (
            <Button variant="outline" size="sm" onClick={() => void handleExport()}>
              <FileDown className="h-3.5 w-3.5 mr-1" /> Export
            </Button>
          )}
        </div>
      </div>

      {isLoading && (
        <Card className="border-border">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">Running checks…</CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="p-4 flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Failed to load checks: {String(error)}
          </CardContent>
        </Card>
      )}

      {data && !isLoading && !data.available && (
        <Card className="border-border">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No Order Review import found. Upload an Order Review file to run checks.
          </CardContent>
        </Card>
      )}

      {data?.available && (
        <>
          {/* Import info strip */}
          <div className="rounded-md border border-border bg-muted/30 px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span>
              <span className="text-muted-foreground">OR import: </span>
              <span className="font-mono font-medium">#{data.orImportId}</span>
              {data.orAsOnDate && (
                <span className="text-muted-foreground ml-1">({formatDate(data.orAsOnDate)})</span>
              )}
            </span>
            {data.orOverride && (
              <span
                className="font-medium text-amber-700 dark:text-amber-300"
                title={`Cumulative regression override by ${data.orOverride.by}: ${data.orOverride.reason}`}
              >
                Cumulative override · {formatDate(data.orOverride.at)}
              </span>
            )}
            <span>
              <span className="text-muted-foreground">WIP import: </span>
              <span className="font-mono font-medium">#{data.wipImportId ?? "—"}</span>
            </span>
            <span>
              <span className="text-muted-foreground">OR structures: </span>
              <span className="font-medium">{data.structuresEvaluated.toLocaleString()}</span>
            </span>
            <span>
              <span className="text-muted-foreground">WIP marks: </span>
              <span className="font-medium">{data.wipTotalMarks.toLocaleString()}</span>
            </span>
            <span>
              <span className="text-muted-foreground">WIP total: </span>
              <span className="font-medium">{data.wipTotalMt.toFixed(3)} MT</span>
            </span>
          </div>

          {/* Overall status */}
          {allClear ? (
            <div className="flex items-center gap-2 rounded-md px-4 py-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300">
              <CircleCheck className="h-4 w-4 shrink-0" />
              <span className="text-sm font-medium">All hard rules passing — data is consistent.</span>
            </div>
          ) : (
            <div className={`flex items-start gap-2 rounded-md px-4 py-3 border ${
              isMajorViolation
                ? "bg-destructive/10 border-destructive/30 text-destructive"
                : "bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300"
            }`}>
              <CircleX className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="text-sm font-bold">
                  {failingRuleCount} hard rule{failingRuleCount !== 1 ? "s" : ""} failing
                  {totalViolatingStructures > 0 && evalTotal > 0 && (
                    <> — {totalViolatingStructures.toLocaleString()} structure{totalViolatingStructures !== 1 ? "s" : ""} affected
                    {" "}({sharePct < 0.1 ? "<0.1" : sharePct.toFixed(1)}% of {evalTotal.toLocaleString()} evaluated)</>
                  )}
                  {dc0Fail && totalViolatingStructures === 0 && " — OR parse hygiene"}
                  .
                </span>
                <span className="text-xs block mt-0.5 opacity-80">
                  {isMajorViolation
                    ? "Review the violations below — figures for affected structures may be unreliable."
                    : "Discrepancy is small relative to the dataset. Verify the affected structures in the drill-down below."}
                </span>
              </div>
            </div>
          )}

          {/* ---- DC0 parse hygiene row ---- */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Parse Hygiene
            </h3>
            <Card className={`border ${data.dc0StoredTotalRows === 0 ? "border-border" : "border-destructive/50 bg-destructive/5"}`}>
              <div className="flex items-start gap-3 px-4 py-3">
                <div className="mt-0.5 shrink-0">
                  {data.dc0StoredTotalRows === 0
                    ? <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    : <CircleX className="h-4 w-4 text-destructive" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC0</span>
                    <span className={`text-xs font-semibold ${data.dc0StoredTotalRows === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                      {data.dc0StoredTotalRows === 0 ? "PASS" : "FAIL"}
                    </span>
                    {data.dc0StoredTotalRows > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {data.dc0StoredTotalRows} stored structure{data.dc0StoredTotalRows !== 1 ? "s" : ""} match a total-row name
                      </span>
                    )}
                  </div>
                  {data.dc0StoredTotalRows === 0 ? (
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      No stored structure name matches a total-row pattern.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {data.dc0StoredTotalRows} stored structure{data.dc0StoredTotalRows !== 1 ? "s" : ""} match a Grand Total / Sub Total row name and should not be in the data.
                      Fix: re-upload the Order Review file after the parser fix is applied.
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </div>

          {/* ---- Hard rules DC1–DC6, DC16 ---- */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Hard Rules (DC1–DC6, DC16)
            </h3>
            {data.hardRules.map((rule) => (
              <DcHardRuleRow
                key={rule.id}
                rule={rule}
                wipBuckets={rule.id === "DC6" ? data.wipBuckets : rule.id === "DC16" ? data.ntltBuckets : undefined}
                wipUnclassifiedMarks={rule.id === "DC6" ? data.wipUnclassifiedMarks : rule.id === "DC16" ? data.ntltUnclassifiedMarks : undefined}
                wipUnclassifiedMt={rule.id === "DC6" ? undefined : rule.id === "DC16" ? data.ntltUnclassifiedMt : undefined}
                wipTotalMt={rule.id === "DC6" ? data.wipTotalMt : rule.id === "DC16" ? data.ntltTotalMt : undefined}
                wipTotalMarks={rule.id === "DC6" ? data.wipTotalMarks : rule.id === "DC16" ? data.ntltTotalMarks : undefined}
                wipHasTypeData={rule.id === "DC6" || rule.id === "DC16" ? data.wipHasTypeData : undefined}
              />
            ))}
          </div>

          {/* ---- Non-blocking warnings ---- */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Warnings — non-zero counts are expected; watch for large changes
            </h3>
            {data.warnings.map((w) => (
              <DcWarningRow key={w.id} warning={w} />
            ))}
          </div>

          {/* ---- Movement checks DC12–DC14 ---- */}
          {data.markMovement && (
            <DcMarkMovementSection movement={data.markMovement} />
          )}

          {/* ---- Source Column Watch (descriptive only — no pass/fail) ---- */}
          {data.sourceColumnWatch && (
            <SourceColumnWatchSection watch={data.sourceColumnWatch} />
          )}

          {/* ---- Order vs WIP gap DC17 ---- */}
          {data.dc17 && (
            <Dc17Section dc17={data.dc17} />
          )}
        </>
      )}
    </div>
  );
}

function DcHardRuleRow({
  rule,
  wipBuckets,
  wipUnclassifiedMarks,
  wipUnclassifiedMt,
  wipTotalMt,
  wipTotalMarks,
  wipHasTypeData,
}: {
  rule: DcHardRule;
  wipBuckets?: DcWipBucket[];
  wipUnclassifiedMarks?: number;
  wipUnclassifiedMt?: number;
  wipTotalMt?: number;
  wipTotalMarks?: number;
  /** Undefined for non-DC6 rules. False = old-format import; DC6 was not evaluated. */
  wipHasTypeData?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDc6 = rule.id === "DC6";
  const isDc16 = rule.id === "DC16";
  const isBucketRule = isDc6 || isDc16;
  // DC6/DC16 on an old-format import: not evaluated — show as N/A, not FAIL.
  const dc6NotEvaluated = isBucketRule && wipHasTypeData === false;
  const canExpand = isBucketRule ? !!wipBuckets && !dc6NotEvaluated : rule.violations.length > 0;

  const fieldKeys = rule.violations[0] ? Object.keys(rule.violations[0].fields) : [];

  return (
    <Card className={`border ${
      dc6NotEvaluated
        ? "border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-600/40"
        : rule.pass ? "border-border" : "border-destructive/50 bg-destructive/5 dark:bg-destructive/10"
    }`}>
      <div
        className={`flex items-start gap-3 px-4 py-3 ${canExpand ? "cursor-pointer select-none" : ""}`}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0">
          {dc6NotEvaluated
            ? <Info className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            : rule.pass
              ? <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              : <CircleX className="h-4 w-4 text-destructive" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">{rule.id}</span>
            <span className={`text-xs font-semibold ${
              dc6NotEvaluated
                ? "text-amber-700 dark:text-amber-400"
                : rule.pass ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
            }`}>
              {dc6NotEvaluated ? "N/A" : rule.pass ? "PASS" : "FAIL"}
            </span>
            {!dc6NotEvaluated && !rule.pass && (
              <span className="text-xs text-muted-foreground">
                {rule.violationCount.toLocaleString()} violation{rule.violationCount !== 1 ? "s" : ""}
                {isBucketRule ? " unclassified" : ""}
                {rule.toleranceMt > 0 && <span> · tol {rule.toleranceMt * 1000} kg</span>}
              </span>
            )}
            {isBucketRule && rule.pass && (
              <span className="text-xs text-muted-foreground">
                {rule.structuresEvaluated.toLocaleString()} marks · {wipTotalMt?.toFixed(3)} MT
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{rule.label}</p>
        </div>

        {canExpand && (
          <div className="shrink-0 text-muted-foreground mt-0.5">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
        )}
      </div>

      {/* DC6 / DC16 expand: bucket breakdown */}
      {isBucketRule && expanded && wipBuckets && (
        <div className="border-t border-border/40 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">WIP bucket breakdown:</p>
          <div className="overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border/40 bg-muted/40">
                  <th className="text-left px-2 py-1 font-medium">Bucket</th>
                  <th className="text-right px-2 py-1 font-medium">MT</th>
                  <th className="text-right px-2 py-1 font-medium">Marks</th>
                </tr>
              </thead>
              <tbody>
                {wipBuckets.map((b) => (
                  <tr key={b.name} className="border-b border-border/20 hover:bg-muted/20">
                    <td className="px-2 py-1">{b.name}</td>
                    <td className="px-2 py-1 text-right font-mono">{b.mt.toFixed(3)}</td>
                    <td className="px-2 py-1 text-right font-mono">{b.marks.toLocaleString()}</td>
                  </tr>
                ))}
                {(wipUnclassifiedMarks ?? 0) > 0 && (
                  <tr className="border-b border-destructive/30 bg-destructive/5">
                    <td className="px-2 py-1 text-destructive font-medium">Unclassified</td>
                    <td className="px-2 py-1 text-right font-mono text-destructive">
                      {wipUnclassifiedMt == null ? "—" : wipUnclassifiedMt.toFixed(3)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-destructive">{wipUnclassifiedMarks?.toLocaleString()}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-border font-semibold bg-muted/30">
                  <td className="px-2 py-1">TOTAL</td>
                  <td className="px-2 py-1 text-right font-mono">{(wipTotalMt ?? 0).toFixed(3)}</td>
                  <td className="px-2 py-1 text-right font-mono">{(wipTotalMarks ?? 0).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {rule.violations.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-destructive mb-2">
                Affected source rows:
              </p>
              <div className="overflow-auto max-h-80">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border/40 bg-muted/40">
                      <th className="text-left px-2 py-1 font-medium">Project</th>
                      <th className="text-left px-2 py-1 font-medium">Structure</th>
                      {fieldKeys.map((k) => (
                        <th key={k} className="text-right px-2 py-1 font-medium whitespace-nowrap">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rule.violations.map((v, i) => (
                      <tr key={i} className="border-b border-destructive/20 bg-destructive/5">
                        <td className="px-2 py-1">{v.project}</td>
                        <td className="px-2 py-1">{v.structure}</td>
                        {fieldKeys.map((k) => (
                          <td key={k} className="px-2 py-1 text-right font-mono">{v.fields[k] ?? "blank"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* DC1–DC5 expand: violations table */}
      {!isBucketRule && !rule.pass && expanded && rule.violations.length > 0 && (
        <div className="border-t border-border/40 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            All violations — sorted by |diff| descending ({rule.violationCount.toLocaleString()} total):
          </p>
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border/40 bg-muted/40">
                  <th className="text-left px-2 py-1 font-medium">Project</th>
                  <th className="text-left px-2 py-1 font-medium">Structure</th>
                  {fieldKeys.map((k) => (
                    <th key={k} className="text-right px-2 py-1 font-medium whitespace-nowrap">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rule.violations.map((v, i) => (
                  <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                    <td className="px-2 py-1">{v.project}</td>
                    <td className="px-2 py-1">{v.structure}</td>
                    {fieldKeys.map((k) => (
                      <td key={k} className="px-2 py-1 text-right font-mono">
                        {v.fields[k] != null ? v.fields[k] : <span className="text-muted-foreground italic">blank</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// DC12–DC14 mark movement section
// ---------------------------------------------------------------------------
function DcMarkMovementSection({ movement }: { movement: DcMarkMovementResult }) {
  const [expanded12, setExpanded12] = useState(false);
  const [expanded13, setExpanded13] = useState(false);
  const [expanded14, setExpanded14] = useState(false);

  const fmtMt = (v: number) => v.toFixed(3);
  const fmtDate = (d: string | null) => (d ? formatDate(d) : "—");

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
        Movement Checks — DC12–DC14
      </h3>

      {/* gated banner */}
      {!movement.available && (
        <Card className="border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-600/40">
          <div className="flex items-start gap-3 px-4 py-3">
            <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC12–DC14</span>
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">N/A</span>
                <span className="text-xs text-muted-foreground">
                  Comparing import #{movement.currImportId} ({fmtDate(movement.currDate)})
                  {movement.prevImportId && ` vs #${movement.prevImportId} (${fmtDate(movement.prevDate)})`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{movement.reason}</p>
            </div>
          </div>
        </Card>
      )}

      {movement.available && (() => {
        const mv = movement;
        const importStrip = (
          <span className="text-xs text-muted-foreground ml-1">
            #{mv.prevImportId} ({fmtDate(mv.prevDate)}) → #{mv.currImportId} ({fmtDate(mv.currDate)})
            · {mv.trackedMarks.toLocaleString()} tracked · {mv.forwardMoves.toLocaleString()} forward
            · identity: {mv.identityKey}
          </span>
        );

        return (
          <>
            {/* DC12 — backward movement */}
            <Card className="border-border">
              <div
                className={`flex items-start gap-3 px-4 py-3 ${mv.backwardMoves > 0 ? "cursor-pointer select-none" : ""}`}
                onClick={() => mv.backwardMoves > 0 && setExpanded12((v) => !v)}
              >
                <div className="mt-0.5 shrink-0">
                  {mv.backwardMoves > 0
                    ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                    : <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC12</span>
                    <span className={`text-xs font-semibold ${mv.backwardMoves > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {mv.backwardMoves} mark{mv.backwardMoves !== 1 ? "s" : ""} moved backward
                    </span>
                    {mv.backwardMoves > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {fmtMt(mv.backwardWeightMt)} MT (rework — warning only)
                      </span>
                    )}
                    {importStrip}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Marks whose activity moved backwards since the previous import. Backward movement is rework — it is
                    expected and legitimate. Watch for sudden spikes in count or weight.
                  </p>
                </div>
                {mv.backwardMoves > 0 && (
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    {expanded12 ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </div>
                )}
              </div>
              {expanded12 && mv.backwardTransitions.length > 0 && (
                <div className="border-t border-border/40 px-4 py-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Backward transitions (ordered by weight):</p>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/40">
                        <th className="text-left px-2 py-1 font-medium">From</th>
                        <th className="text-left px-2 py-1 font-medium">To</th>
                        <th className="text-right px-2 py-1 font-medium">Marks</th>
                        <th className="text-right px-2 py-1 font-medium">MT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mv.backwardTransitions.map((t, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                          <td className="px-2 py-1 font-mono">{t.from}</td>
                          <td className="px-2 py-1 font-mono">{t.to}</td>
                          <td className="px-2 py-1 text-right">{t.count}</td>
                          <td className="px-2 py-1 text-right font-mono">{fmtMt(t.weightMt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* DC13 — marks leaving FG */}
            <Card className="border-border">
              <div
                className={`flex items-start gap-3 px-4 py-3 ${mv.leavingFgCount > 0 ? "cursor-pointer select-none" : ""}`}
                onClick={() => mv.leavingFgCount > 0 && setExpanded13((v) => !v)}
              >
                <div className="mt-0.5 shrink-0">
                  {mv.leavingFgCount > 0
                    ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                    : <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC13</span>
                    <span className={`text-xs font-semibold ${mv.leavingFgCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {mv.leavingFgCount} mark{mv.leavingFgCount !== 1 ? "s" : ""} left Finished Goods
                    </span>
                    {mv.leavingFgCount > 0 && (
                      <span className="text-xs text-muted-foreground">{fmtMt(mv.leavingFgWeightMt)} MT</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    FG is terminal — material should leave it by being dispatched (disappearing from the file), not
                    by moving to an earlier activity. A non-zero count may indicate same-day corrections or data
                    entry errors.
                  </p>
                </div>
                {mv.leavingFgCount > 0 && (
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    {expanded13 ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </div>
                )}
              </div>
              {expanded13 && mv.leavingFgTransitions.length > 0 && (
                <div className="border-t border-border/40 px-4 py-3">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/40">
                        <th className="text-left px-2 py-1 font-medium">From</th>
                        <th className="text-left px-2 py-1 font-medium">To</th>
                        <th className="text-right px-2 py-1 font-medium">Marks</th>
                        <th className="text-right px-2 py-1 font-medium">MT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mv.leavingFgTransitions.map((t, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                          <td className="px-2 py-1 font-mono">{t.from}</td>
                          <td className="px-2 py-1 font-mono">{t.to}</td>
                          <td className="px-2 py-1 text-right">{t.count}</td>
                          <td className="px-2 py-1 text-right font-mono">{fmtMt(t.weightMt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* DC14 — marks vanished before FG */}
            <Card className="border-border">
              <div
                className={`flex items-start gap-3 px-4 py-3 ${mv.vanishedCount > 0 ? "cursor-pointer select-none" : ""}`}
                onClick={() => mv.vanishedCount > 0 && setExpanded14((v) => !v)}
              >
                <div className="mt-0.5 shrink-0">
                  {mv.vanishedCount > 0
                    ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                    : <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC14</span>
                    <span className={`text-xs font-semibold ${mv.vanishedCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {mv.vanishedCount} mark{mv.vanishedCount !== 1 ? "s" : ""} vanished before FG
                    </span>
                    {mv.vanishedCount > 0 && (
                      <span className="text-xs text-muted-foreground">{fmtMt(mv.vanishedWeightMt)} MT</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Marks present in the previous import but absent in the current one without having reached FG.
                    Possible causes: cancellation, re-numbering, or dispatch without passing through Finished Goods.
                  </p>
                </div>
                {mv.vanishedCount > 0 && (
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    {expanded14 ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </div>
                )}
              </div>
              {expanded14 && mv.vanishedByLastActivity.length > 0 && (
                <div className="border-t border-border/40 px-4 py-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">By last-known activity:</p>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/40">
                        <th className="text-left px-2 py-1 font-medium">Last Activity</th>
                        <th className="text-right px-2 py-1 font-medium">Marks</th>
                        <th className="text-right px-2 py-1 font-medium">MT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mv.vanishedByLastActivity.map((a, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                          <td className="px-2 py-1 font-mono">{a.activity}</td>
                          <td className="px-2 py-1 text-right">{a.count}</td>
                          <td className="px-2 py-1 text-right font-mono">{fmtMt(a.weightMt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source Column Watch — descriptive-only panel. NOT a DC rule: no pass/fail,
// never touches the banner. Its job is to notice the day a watched ERP
// pass-through column starts carrying real information (a new distinct value
// or a shifted split). Extensible: the API sends a list of watched columns;
// this renders whatever arrives — adding a third column requires no UI change.
// ---------------------------------------------------------------------------

const swBlankLabel = (v: string | null) => v ?? "(blank)";

function SourceColumnWatchSection({ watch }: { watch: DcSourceColumnWatch }) {
  const fmtDate = (d: string | null) => (d ? formatDate(d) : "—");
  // Union of column keys across current + previous so a column that disappears
  // outright is still shown.
  const keys: string[] = [];
  for (const c of [...(watch.current ?? []), ...(watch.previous ?? [])]) {
    if (!keys.includes(c.key)) keys.push(c.key);
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
        Source Column Watch — descriptive only, no pass/fail
      </h3>
      <p className="text-xs text-muted-foreground px-1">
        Watched ERP pass-through columns on import #{watch.currImportId} ({fmtDate(watch.currDayKey)})
        {watch.prevImportId != null && (
          <> · compared with #{watch.prevImportId} ({fmtDate(watch.prevDayKey)})</>
        )}
        . The point is to notice the day a new distinct value appears or the split moves — that is when these columns become worth building on.
      </p>

      {watch.current === null && (
        <Card className="border-border">
          <CardContent className="p-4 text-sm text-muted-foreground">
            Import #{watch.currImportId} predates the source-column snapshot — the watched columns are not present in this file.
          </CardContent>
        </Card>
      )}

      {keys.map((key) => {
        const curr = watch.current?.find((c) => c.key === key) ?? null;
        const prev = watch.previous?.find((c) => c.key === key) ?? null;
        if (!curr && !prev) return null;
        const header = (curr ?? prev)!.header;
        return (
          <SourceColumnWatchCard
            key={key}
            header={header}
            curr={curr}
            prev={prev}
            prevImportId={watch.prevImportId}
            prevDayKey={watch.prevDayKey}
          />
        );
      })}
    </div>
  );
}

function SourceColumnWatchCard({
  header,
  curr,
  prev,
  prevImportId,
  prevDayKey,
}: {
  header: string;
  curr: SourceWatchColumn | null;
  prev: SourceWatchColumn | null;
  prevImportId: number | null;
  prevDayKey: string | null;
}) {
  const currPresent = curr?.present ?? false;
  const prevPresent = prev?.present ?? false;
  // Older snapshots predate the explicit watch mode and were all
  // distributions, so retain that rendering as their backwards-compatible
  // default.
  const mode = curr?.mode ?? prev?.mode ?? "distribution";
  const currValues = currPresent ? curr!.values : [];
  const prevValues = prevPresent ? prev!.values : [];
  const currPopulatedCount =
    curr?.populatedCount ??
    currValues.filter((value) => value.value != null).reduce((sum, value) => sum + value.marks, 0);
  const totalMarks = currValues.reduce((s, v) => s + v.marks, 0);
  const prevTotalMarks = prevValues.reduce((s, v) => s + v.marks, 0);
  const prevByValue = new Map(prevValues.map((v) => [swBlankLabel(v.value), v]));
  const currLabels = new Set(currValues.map((v) => swBlankLabel(v.value)));

  // Comparison: only meaningful when BOTH imports carried the column.
  const comparable = mode === "distribution" && currPresent && prevPresent;
  const newValues = comparable
    ? currValues.filter((v) => !prevByValue.has(swBlankLabel(v.value)))
    : [];
  const goneValues = comparable
    ? prevValues.filter((v) => !currLabels.has(swBlankLabel(v.value)))
    : [];

  const pct = (marks: number, total: number) =>
    total > 0 ? ((marks / total) * 100).toFixed(marks > 0 && (marks / total) * 100 < 0.1 ? 2 : 1) : "0";

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">{header}</span>
          {!currPresent && (
            <span className="text-xs text-muted-foreground">not present in this file</span>
          )}
          {currPresent && comparable && newValues.length > 0 && (
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 border border-amber-400/60 px-1.5 py-0.5 rounded">
              NEW VALUE{newValues.length > 1 ? "S" : ""}: {newValues.map((v) => swBlankLabel(v.value)).join(", ")}
            </span>
          )}
          {currPresent && !prevPresent && prevImportId != null && (
            <span className="text-xs text-muted-foreground">
              newly appeared — not present in #{prevImportId} ({prevDayKey ? formatDate(prevDayKey) : "—"})
            </span>
          )}
        </div>

        {currPresent && mode === "coverage" && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {currPopulatedCount.toLocaleString()}
            </span>
            {" "}populated row{currPopulatedCount === 1 ? "" : "s"}.
          </p>
        )}

        {currPresent && mode === "numeric" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded bg-muted/60 px-3 py-2">
              <div className="text-muted-foreground">Populated</div>
              <div className="font-semibold tabular-nums">{currPopulatedCount.toLocaleString()}</div>
            </div>
            {curr?.numericSummary ? (
              <>
                <div className="rounded bg-muted/60 px-3 py-2">
                  <div className="text-muted-foreground">Min</div>
                  <div className="font-semibold tabular-nums">{curr.numericSummary.min.toFixed(4)}</div>
                </div>
                <div className="rounded bg-muted/60 px-3 py-2">
                  <div className="text-muted-foreground">Max</div>
                  <div className="font-semibold tabular-nums">{curr.numericSummary.max.toFixed(4)}</div>
                </div>
                <div className="rounded bg-muted/60 px-3 py-2">
                  <div className="text-muted-foreground">Mean</div>
                  <div className="font-semibold tabular-nums">{curr.numericSummary.mean.toFixed(4)}</div>
                </div>
              </>
            ) : (
              <div className="col-span-3 rounded bg-muted/60 px-3 py-2 text-muted-foreground">
                No numeric values in this file.
              </div>
            )}
          </div>
        )}

        {currPresent && mode === "distribution" && currValues.length === 1 && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{swBlankLabel(currValues[0].value)}</span>
            {" "}on all {currValues[0].marks.toLocaleString()} rows — no variation, carries no information yet.
          </p>
        )}

        {currPresent && mode === "distribution" && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left py-1 pr-4 font-medium">Value</th>
                  <th className="text-right py-1 pr-4 font-medium">Marks</th>
                  <th className="text-right py-1 pr-4 font-medium">Weight (MT)</th>
                  <th className="text-right py-1 pr-4 font-medium">Share</th>
                  {comparable && <th className="text-right py-1 font-medium">Prev share</th>}
                </tr>
              </thead>
              <tbody>
                {currValues.map((v) => {
                  const label = swBlankLabel(v.value);
                  const prevEntry = prevByValue.get(label);
                  const isNew = comparable && !prevEntry;
                  return (
                    <tr key={label} className={`border-b border-border/50 ${isNew ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}>
                      <td className="py-1 pr-4 font-mono">
                        {label}
                        {isNew && <span className="ml-2 text-amber-700 dark:text-amber-400 font-semibold">← new</span>}
                      </td>
                      <td className="py-1 pr-4 text-right tabular-nums">{v.marks.toLocaleString()}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{v.weightMt.toFixed(3)}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{pct(v.marks, totalMarks)}%</td>
                      {comparable && (
                        <td className="py-1 text-right tabular-nums text-muted-foreground">
                          {prevEntry ? `${pct(prevEntry.marks, prevTotalMarks)}%` : "—"}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {goneValues.map((v) => (
                  <tr key={`gone-${swBlankLabel(v.value)}`} className="border-b border-border/50 text-muted-foreground">
                    <td className="py-1 pr-4 font-mono line-through">{swBlankLabel(v.value)}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">0</td>
                    <td className="py-1 pr-4 text-right tabular-nums">—</td>
                    <td className="py-1 pr-4 text-right tabular-nums">0%</td>
                    <td className="py-1 text-right tabular-nums">{pct(v.marks, prevTotalMarks)}% — value disappeared</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {currPresent && mode === "distribution" && curr!.crossTab.length > 0 && (
          <div>
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
              Cross-tab · Order Nature × {header}
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1 pr-4 font-medium">Order Nature</th>
                    <th className="text-left py-1 pr-4 font-medium">Value</th>
                    <th className="text-right py-1 font-medium">Marks</th>
                  </tr>
                </thead>
                <tbody>
                  {curr!.crossTab.map((c, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-1 pr-4">{c.orderNature}</td>
                      <td className="py-1 pr-4 font-mono">{swBlankLabel(c.value)}</td>
                      <td className="py-1 text-right tabular-nums">{c.marks.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// DC17 — Order vs WIP gap section
// ---------------------------------------------------------------------------

const DC17_CAT_INFO: Record<
  string,
  { label: string; desc: string; group: "lag" | "investigate" }
> = {
  A: { label: "A — Not yet in production",              desc: "W=0, Q=0. Work order raised; no job card issued, nothing shipped.",                          group: "lag"       },
  B: { label: "B — Left WIP without despatch record",   desc: "W=0, Q>0. Material gone from the floor but the order book shows a shortfall.",               group: "investigate"},
  C: { label: "C — In production, WIP short",           desc: "W>0, Q=0. Job cards exist but balance weight falls short of the work order.",                group: "lag"       },
  D: { label: "D — Partly shipped, WIP short",          desc: "W>0, Q>0. Partially despatched but WIP + despatch still falls short.",                       group: "lag"       },
  E: { label: "E — Marks with no work order",           desc: "J=0. WIP marks exist for this structure but the order book has no matching work order.",      group: "investigate"},
  F: { label: "F — Fully despatched per OR, WIP pending", desc: "|J−Q|≤50 kg. OR shows fully shipped, yet WIP marks remain on the floor.",                  group: "investigate"},
  G: { label: "G — Shop holds more than order expects", desc: "Negative gap not matching E or F — WIP+despatch exceeds the work order.",                     group: "investigate"},
};
const DC17_LAG_CATS = ["A", "C", "D"] as const;
const DC17_INV_CATS = ["B", "E", "F", "G"] as const;

function Dc17Section({ dc17 }: { dc17: Dc17Result }) {
  const lagRows = dc17.flagged.filter((r) => (DC17_LAG_CATS as readonly string[]).includes(r.category));
  const invRows = dc17.flagged.filter((r) => (DC17_INV_CATS as readonly string[]).includes(r.category));

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
        Order vs WIP Gap — DC17
      </h3>

      {/* Summary card */}
      <Card className="border-border">
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">DC17</span>
            <span className="text-xs font-semibold">
              {dc17.flagged.length.toLocaleString()} flagged
            </span>
            <span className="text-xs text-muted-foreground">
              of {dc17.structuresCompared.toLocaleString()} structures compared ·{" "}
              {dc17.structuresClean.toLocaleString()} clean (within 50 kg)
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Per-structure gap: WO Order Qty (J) − Progress Despatch (Q) − WIP pending weight (W). Structures
            outside ±50 kg are classified A–G. A, C, D are likely job-card lag. B, E, F, G need investigation.
          </p>
          {/* Per-category badge grid */}
          <div className="grid grid-cols-7 gap-1.5">
            {(["A","B","C","D","E","F","G"] as const).map((cat) => {
              const byCat = dc17.byCategory[cat];
              const isInv = (DC17_INV_CATS as readonly string[]).includes(cat);
              return (
                <div
                  key={cat}
                  className={`text-center rounded-md p-2 border ${
                    isInv
                      ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
                      : "bg-muted/40 border-border"
                  }`}
                >
                  <div className={`text-xs font-bold font-mono ${isInv ? "text-amber-700 dark:text-amber-400" : ""}`}>
                    {cat}
                  </div>
                  <div className="text-sm font-semibold mt-0.5">{byCat?.count ?? 0}</div>
                  <div className={`text-[10px] font-mono leading-tight mt-0.5 ${
                    byCat && byCat.totalMt < 0 ? "text-destructive" : "text-muted-foreground"
                  }`}>
                    {byCat ? (byCat.totalMt >= 0 ? "+" : "") + byCat.totalMt.toFixed(1) : "—"} MT
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Likely job-card lag group */}
      {lagRows.length > 0 && (
        <Dc17Group
          title="Likely job-card lag — A, C, D"
          rows={lagRows}
          cats={DC17_LAG_CATS as unknown as string[]}
          dc17={dc17}
          highlight={false}
        />
      )}

      {/* Needs investigation group */}
      {invRows.length > 0 && (
        <Dc17Group
          title="Needs investigation — B, E, F, G"
          rows={invRows}
          cats={DC17_INV_CATS as unknown as string[]}
          dc17={dc17}
          highlight
        />
      )}
    </div>
  );
}

function Dc17Group({
  title,
  rows,
  cats,
  dc17,
  highlight,
}: {
  title: string;
  rows: Dc17StructureRow[];
  cats: string[];
  dc17: Dc17Result;
  highlight: boolean;
}) {
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const groupMt = rows.reduce((s, r) => s + r.gap, 0);

  return (
    <Card className={`border ${highlight ? "border-amber-400/60" : "border-border"}`}>
      <div className="px-4 py-2.5 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
        <span className={`text-xs font-semibold ${highlight ? "text-amber-700 dark:text-amber-400" : ""}`}>
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          {rows.length} structures · {groupMt >= 0 ? "+" : ""}{groupMt.toFixed(3)} MT
        </span>
      </div>

      {cats.map((cat) => {
        const catRows = rows.filter((r) => r.category === cat);
        if (catRows.length === 0) return null;
        const info = DC17_CAT_INFO[cat];
        const byCat = dc17.byCategory[cat];
        const isExpanded = expandedCat === cat;

        return (
          <div key={cat} className="border-b border-border/20 last:border-0">
            <div
              className="flex items-start gap-3 px-4 py-2.5 cursor-pointer select-none hover:bg-muted/20"
              onClick={() => setExpandedCat(isExpanded ? null : cat)}
            >
              <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">
                {cat}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold">{info.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {byCat?.count ?? 0} structures ·{" "}
                    {byCat && byCat.totalMt >= 0 ? "+" : ""}
                    {byCat?.totalMt.toFixed(3) ?? "0.000"} MT
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{info.desc}</p>
              </div>
              <div className="shrink-0 text-muted-foreground mt-0.5">
                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </div>
            </div>

            {isExpanded && (
              <div className="border-t border-border/20 px-4 py-3">
                <div className="overflow-auto max-h-96">
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border/40 bg-muted/40">
                        <th className="text-left px-2 py-1 font-medium">Project</th>
                        <th className="text-left px-2 py-1 font-medium">Structure</th>
                        <th className="text-right px-2 py-1 font-medium whitespace-nowrap">J (WO Qty)</th>
                        <th className="text-right px-2 py-1 font-medium whitespace-nowrap">Q (Despatch)</th>
                        <th className="text-right px-2 py-1 font-medium whitespace-nowrap">W (WIP)</th>
                        <th className="text-right px-2 py-1 font-medium whitespace-nowrap">Gap (MT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catRows.map((r, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                          <td className="px-2 py-1">{r.project}</td>
                          <td className="px-2 py-1">{r.structure}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.j.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.q.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.w.toFixed(3)}</td>
                          <td className={`px-2 py-1 text-right font-mono font-semibold ${
                            r.gap < 0 ? "text-destructive" : ""
                          }`}>
                            {r.gap >= 0 ? "+" : ""}{r.gap.toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function DcWarningRow({ warning }: { warning: DcWarning }) {
  const isSignificant = warning.structureCount > 0;
  return (
    <Card className="border-border">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="mt-0.5 shrink-0">
          {isSignificant
            ? <AlertTriangle className="h-4 w-4 text-amber-500" />
            : <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">{warning.id}</span>
            <span className={`text-xs font-semibold ${isSignificant ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
              {warning.structureCount.toLocaleString()} structure{warning.structureCount !== 1 ? "s" : ""}
            </span>
            {warning.markCount != null && (
              <span className="text-xs text-muted-foreground">
                · {warning.markCount.toLocaleString()} mark{warning.markCount !== 1 ? "s" : ""}
              </span>
            )}
            {isSignificant && (
              <>
                <span className="text-xs text-muted-foreground">
                  Σ {warning.totalMt.toFixed(3)} MT
                </span>
                <span className="text-xs text-muted-foreground">
                  · worst: {warning.worstProject} / {warning.worstStructure} ({warning.worstMt.toFixed(3)} MT)
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{warning.label}</p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ERP Rules Content
// ---------------------------------------------------------------------------

const ERP_RULES_QUERY_KEY = ["erp-rules"] as const;

async function fetchErpRules(): Promise<ErpRulesResponse> {
  const r = await fetch("/api/reports/erp-rules", { credentials: "include" });
  if (!r.ok) throw new Error(`ERP rules fetch failed: ${r.status}`);
  return r.json() as Promise<ErpRulesResponse>;
}

// ---------------------------------------------------------------------------
// Job Templates — named project sets for the global Jobs filter
// ---------------------------------------------------------------------------
interface JTTemplate { id: number; name: string; category: string; sortOrder: number; members: string[] }
interface JTProjects { tlt: string[]; ntlt: string[]; tltQty?: Record<string, number> }

/** Returns the next available P-number label (P1, P2, …) for a category's template list. */
function nextPLabel(templates: JTTemplate[]): string {
  const used = new Set(
    templates
      .map((t) => { const m = t.name.match(/P(\d+)$/); return m ? parseInt(m[1], 10) : NaN; })
      .filter((n) => !isNaN(n)),
  );
  for (let i = 1; ; i++) { if (!used.has(i)) return `P${i}`; }
}

function JobTemplatesContent() {
  const [localCategory, setLocalCategory] = useState<"TLT" | "NTLT">("TLT");
  const [dragState, setDragState] = useState<{ code: string; fromTemplateId: number | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | "pool" | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allTemplates = [], isLoading: tLoading } = useQuery<JTTemplate[]>({
    queryKey: ["job-templates"],
    queryFn: () => fetch("/api/job-templates", { credentials: "include" }).then((r) => r.json()),
    staleTime: 15_000,
  });

  const { data: projects } = useQuery<JTProjects>({
    queryKey: ["job-templates-projects"],
    queryFn: () => fetch("/api/job-templates/projects", { credentials: "include" }).then((r) => r.json()),
    staleTime: 60_000,
  });

  const catTemplates = allTemplates.filter((t) => t.category === localCategory);
  const allProjectsForCategory = localCategory === "TLT" ? (projects?.tlt ?? []) : (projects?.ntlt ?? []);
  const assignedSet = new Set(catTemplates.flatMap((t) => t.members));
  const available = allProjectsForCategory.filter((p) => !assignedSet.has(p));
  // WO qty map for TLT batches (qty → number of pieces for that job-batch combo).
  const tltQty = projects?.tltQty ?? {};

  async function saveMembers(templateId: number, members: string[]) {
    setSaving(true);
    try {
      await fetch(`/api/job-templates/${templateId}/members`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
      });
      queryClient.invalidateQueries({ queryKey: ["job-templates"] });
    } finally {
      setSaving(false);
    }
  }

  async function createTemplate() {
    setSaving(true);
    try {
      const r = await fetch("/api/job-templates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: localCategory }),
      });
      const created: JTTemplate = await r.json();
      queryClient.invalidateQueries({ queryKey: ["job-templates"] });
      toast({ title: `${created.name} created` });
    } finally {
      setSaving(false);
    }
  }

  async function deleteTemplate(t: JTTemplate) {
    if (!confirm(`Delete "${t.name}"? Its ${t.members.length} project(s) will return to the available pool.`)) return;
    setSaving(true);
    try {
      await fetch(`/api/job-templates/${t.id}`, { method: "DELETE", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: ["job-templates"] });
      toast({ title: `${t.name} deleted` });
    } finally {
      setSaving(false);
    }
  }

  function onDragStart(code: string, fromTemplateId: number | null) {
    setDragState({ code, fromTemplateId });
  }

  function onDrop(targetId: number | "pool") {
    if (!dragState) return;
    const { code, fromTemplateId } = dragState;

    if (targetId === "pool") {
      if (fromTemplateId !== null) {
        const src = catTemplates.find((t) => t.id === fromTemplateId);
        if (src) saveMembers(fromTemplateId, src.members.filter((m) => m !== code));
      }
    } else {
      const target = catTemplates.find((t) => t.id === targetId);
      if (!target) return;
      const newMembers = [...new Set([...target.members, code])].sort();
      if (fromTemplateId !== null && fromTemplateId !== targetId) {
        const src = catTemplates.find((t) => t.id === fromTemplateId);
        if (src) saveMembers(fromTemplateId, src.members.filter((m) => m !== code));
      }
      saveMembers(targetId, newMembers);
    }

    setDragState(null);
    setDropTarget(null);
  }

  const nextLabel = nextPLabel(catTemplates);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Job Templates</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Named project sets for the global Jobs filter. Drag projects from the available pool into a template,
            or drag them back to unassign. Templates appear in the Jobs dropdown on every page.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            value={localCategory}
            onChange={(v) => v && setLocalCategory(v as "TLT" | "NTLT")}
            options={[{ value: "TLT", label: "TLT" }, { value: "NTLT", label: "NTLT" }]}
          />
          <Button size="sm" onClick={createTemplate} disabled={saving} className="gap-1.5 h-9">
            <PlusCircle className="w-3.5 h-3.5" />
            Add {localCategory} Job {nextLabel}
          </Button>
        </div>
      </div>

      {/* Two-panel drag-and-drop area */}
      <div className="flex gap-4 overflow-x-auto pb-2 items-start min-h-[320px]">

        {/* Available pool — left panel */}
        <div
          className={`shrink-0 w-64 rounded-lg border-2 transition-colors ${
            dropTarget === "pool" ? "border-primary bg-primary/5" : "border-border bg-muted/20"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDropTarget("pool"); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
          onDrop={(e) => { e.preventDefault(); onDrop("pool"); }}
        >
          <div className="px-3 py-2.5 border-b">
            <h3 className="text-sm font-semibold">Available Batches</h3>
            <p className="text-xs text-muted-foreground">{available.length} unassigned</p>
          </div>
          <div className="p-2 space-y-1 max-h-[58vh] overflow-y-auto">
            {tLoading ? (
              <p className="text-xs text-muted-foreground text-center py-4">Loading…</p>
            ) : available.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6 leading-relaxed px-2">
                {allProjectsForCategory.length === 0
                  ? "No projects found in the latest WIP import."
                  : "All projects have been assigned."}
              </p>
            ) : (
              available.map((code) => (
                <div
                  key={code}
                  draggable
                  onDragStart={() => onDragStart(code, null)}
                  onDragEnd={() => { setDragState(null); setDropTarget(null); }}
                  className="px-2 py-1 rounded text-xs font-mono bg-background border cursor-grab hover:bg-accent select-none flex items-center justify-between gap-1"
                >
                  <span className="truncate">{code}</span>
                  {tltQty[code] != null && (
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {Math.round(tltQty[code]).toLocaleString()}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Template columns */}
        {catTemplates.length === 0 ? (
          <div className="flex items-center justify-center border-2 border-dashed rounded-lg w-64 h-32 text-sm text-muted-foreground self-center text-center px-3">
            Click Add to create a template
          </div>
        ) : (
          catTemplates.map((template) => (
            <div
              key={template.id}
              className={`shrink-0 w-64 rounded-lg border-2 transition-colors ${
                dropTarget === template.id ? "border-primary bg-primary/5" : "border-border bg-background"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDropTarget(template.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
              onDrop={(e) => { e.preventDefault(); onDrop(template.id); }}
            >
              <div className="px-3 py-2.5 border-b flex items-center justify-between gap-1">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate">{template.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {template.members.length} batch{template.members.length !== 1 ? "es" : ""}
                  </p>
                </div>
                <button
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  onClick={() => deleteTemplate(template)}
                  title="Delete template"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-2 space-y-1 max-h-[58vh] overflow-y-auto">
                {template.members.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    Drop batches here
                  </p>
                ) : (
                  template.members.map((code) => (
                    <div
                      key={code}
                      draggable
                      onDragStart={() => onDragStart(code, template.id)}
                      onDragEnd={() => { setDragState(null); setDropTarget(null); }}
                      className="px-2 py-1 rounded text-xs font-mono bg-primary/10 border border-primary/20 cursor-grab hover:bg-primary/15 select-none flex items-center gap-1"
                    >
                      <span className="truncate">{code}</span>
                      {tltQty[code] != null && (
                        <span className="text-primary/60 shrink-0 tabular-nums">
                          {Math.round(tltQty[code]).toLocaleString()}
                        </span>
                      )}
                      <button
                        className="text-muted-foreground hover:text-destructive shrink-0 leading-none text-base ml-auto"
                        onClick={(e) => { e.stopPropagation(); saveMembers(template.id, template.members.filter((m) => m !== code)); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title="Remove from template"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {dragState && (
        <p className="text-xs text-muted-foreground">
          Dragging <span className="font-mono font-medium">{dragState.code}</span> — drop it onto a template to assign, or onto "Available Batches" to unassign.
        </p>
      )}
    </div>
  );
}

function ErpRulesContent() {
  const [nature, setNature] = useState<"TLT" | "NTLT">("TLT");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ERP_RULES_QUERY_KEY,
    queryFn: fetchErpRules,
    staleTime: 60_000,
  });

  const universalRules = data?.rules.filter((r) => r.scope === "UNIVERSAL") ?? [];
  const tltRules = data?.rules.filter((r) => r.scope === "TLT") ?? [];
  const allVisible = nature === "TLT" ? [...universalRules, ...tltRules] : universalRules;
  const visibleFailing = allVisible.filter((r) => !r.pass).length;
  const visiblePassing = allVisible.filter((r) => r.pass).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">ERP Integrity Rules</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Rules the WIP file is expected to satisfy. A failure means a calculation
            somewhere is about to be wrong.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      <div className="flex gap-2">
        {(["TLT", "NTLT"] as const).map((n) => (
          <button
            key={n}
            onClick={() => setNature(n)}
            className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
              nature === n
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:bg-muted"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      {nature === "NTLT" && (
        <Card className="border-border">
          <CardContent className="p-8 text-center text-muted-foreground">
            <Info className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">NTLT rules to be defined</p>
            <p className="text-xs mt-1">
              NTLT project and alias fields are always blank by design (inverse of TLT
              rules T2/T3). Rule authoring will begin once NTLT scope is agreed.
            </p>
          </CardContent>
        </Card>
      )}

      {nature === "TLT" && (
        <>
          {isLoading && (
            <Card className="border-border">
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                Checking rules…
              </CardContent>
            </Card>
          )}

          {error && (
            <Card className="border-destructive bg-destructive/5">
              <CardContent className="p-4 flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Failed to load rules: {String(error)}
              </CardContent>
            </Card>
          )}

          {data && !isLoading && (
            <>
              {/* typeColumnMissing notice */}
              {(data as ErpRulesResponse & { typeColumnMissing?: boolean }).typeColumnMissing && (
                <div className="flex items-start gap-2 rounded-md px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-300">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">WIP file pre-dates the Type column (Col A)</p>
                    <p className="text-xs mt-0.5">
                      Rules will evaluate fully once a new-format WIP file is uploaded. All rules are shown as N/A below.
                    </p>
                  </div>
                </div>
              )}

              {/* Summary banner (only when type column present) */}
              {!(data as ErpRulesResponse & { typeColumnMissing?: boolean }).typeColumnMissing && (
                visibleFailing === 0 ? (
                  <div className="flex items-center gap-2 rounded-md px-4 py-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300">
                    <CircleCheck className="h-4 w-4 shrink-0" />
                    <span className="text-sm font-medium">
                      {visiblePassing} of {allVisible.length} ERP rules holding
                      {data.asOnDate ? ` — import ${formatDate(data.asOnDate)}` : ""}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-md px-4 py-3 bg-destructive/10 border border-destructive/30 text-destructive">
                    <CircleX className="h-4 w-4 shrink-0" />
                    <span className="text-sm font-bold">
                      {visibleFailing} rule{visibleFailing !== 1 ? "s" : ""} VIOLATED — calculations may be unreliable.{" "}
                      {visiblePassing} of {allVisible.length} passing.
                    </span>
                  </div>
                )
              )}

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  Section 1 — Universal (all rows)
                </h3>
                {universalRules.map((rule) => (
                  <ErpRuleRow key={rule.id} rule={rule} />
                ))}
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  Section 2 — TLT Only (Order Nature = "Structure")
                </h3>
                {tltRules.map((rule) => (
                  <ErpRuleRow key={rule.id} rule={rule} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ErpRuleRow({ rule }: { rule: ErpRuleResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasSamples = rule.sampleRows.length > 0;
  const isNA = !!(rule as ErpRuleResult & { notApplicable?: boolean }).notApplicable;

  return (
    <Card
      className={`border ${
        isNA
          ? "border-border opacity-60"
          : rule.pass
            ? "border-border"
            : "border-destructive/50 bg-destructive/5 dark:bg-destructive/10"
      }`}
    >
      <div
        className={`flex items-start gap-3 px-4 py-3 ${hasSamples ? "cursor-pointer select-none" : ""}`}
        onClick={() => hasSamples && setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0">
          {isNA ? (
            <Info className="h-4 w-4 text-muted-foreground" />
          ) : rule.pass ? (
            <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CircleX className="h-4 w-4 text-destructive" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold font-mono bg-muted px-1.5 py-0.5 rounded">
              {rule.id}
            </span>
            <span
              className={`text-xs font-semibold ${
                isNA
                  ? "text-muted-foreground"
                  : rule.pass
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-destructive"
              }`}
            >
              {isNA ? "N/A" : rule.pass ? "PASS" : "FAIL"}
            </span>
            {!rule.pass && !isNA && (
              <span className="text-xs text-muted-foreground">
                {rule.violatingRowCount.toLocaleString()} row
                {rule.violatingRowCount !== 1 ? "s" : ""}
                {" · "}
                {rule.violatingWeightMt.toFixed(3)} MT
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {rule.label}
          </p>
        </div>

        {hasSamples && (
          <div className="shrink-0 text-muted-foreground mt-0.5">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        )}
      </div>

      {!rule.pass && expanded && hasSamples && (
        <div className="border-t border-border/40 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Sample offending rows (up to 10):
          </p>
          <div className="overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border/40 bg-muted/40">
                  <th className="text-left px-2 py-1 font-medium">Project</th>
                  <th className="text-left px-2 py-1 font-medium">Structure</th>
                  <th className="text-left px-2 py-1 font-medium">Mark No.</th>
                  {Object.keys(rule.sampleRows[0]?.fields ?? {}).map((k) => (
                    <th key={k} className="text-left px-2 py-1 font-medium">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rule.sampleRows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-border/20 hover:bg-muted/20"
                  >
                    <td className="px-2 py-1">{row.project}</td>
                    <td className="px-2 py-1">{row.structure}</td>
                    <td className="px-2 py-1">{row.markNo}</td>
                    {Object.values(row.fields).map((v, j) => (
                      <td key={j} className="px-2 py-1 font-mono">
                        {v != null ? v : <span className="text-muted-foreground italic">blank</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rule.violatingRowCount > 10 && (
            <p className="text-xs text-muted-foreground mt-2">
              … and {(rule.violatingRowCount - 10).toLocaleString()} more rows not shown.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bucket List Dates — per-(project, mfcBatch) colour + date management tab.
//
// Shows the same rows as the Bucket List page (inventory_mfc_batch_color):
//   Project | MFC Batch | Colour | Date of Client MFC | Project Start Date | Edit | Delete
//
// Data source: inventory_mfc_batch_color (upload-independent).
// ---------------------------------------------------------------------------

const MFC_COLOR_OPTS = ["white", "yellow", "green", "blue"] as const;
type BldColorName = typeof MFC_COLOR_OPTS[number];

const BLD_DOT_STYLE: Record<BldColorName, React.CSSProperties> = {
  white:  { background: "#ffffff", border: "1.5px solid #aaa" },
  yellow: { background: "#fde047" },
  green:  { background: "#4ade80" },
  blue:   { background: "#60a5fa" },
};

const BLD_COLOR_LABEL: Record<BldColorName, string> = {
  white: "White", yellow: "Yellow", green: "Green", blue: "Blue",
};

function BldColorDot({ color }: { color: string }) {
  const c = color as BldColorName;
  const style = BLD_DOT_STYLE[c] ?? { background: "#ccc" };
  return (
    <span
      className="inline-block w-3 h-3 rounded-full shrink-0"
      style={style}
      title={BLD_COLOR_LABEL[c] ?? color}
    />
  );
}

// Row for a (project, mfcBatch) pair that has WIP marks but no colour assigned yet.
function UnassignedBldRow({
  project,
  mfcBatch,
  onSaved,
  isSaving,
}: {
  project: string;
  mfcBatch: string;
  onSaved: (project: string, mfcBatch: string, color: BldColorName) => void;
  isSaving: boolean;
}) {
  const [color, setColor] = useState<BldColorName>("yellow");
  const [open, setOpen] = useState(false);

  const handleSave = () => {
    onSaved(project, mfcBatch, color);
    setOpen(false);
  };

  return (
    <tr className="hover:bg-muted/30">
      <td className="px-3 py-2 font-mono font-medium">{project}</td>
      <td className="px-3 py-2">
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground">
          {mfcBatch}
        </span>
      </td>
      {open ? (
        <>
          <td className="px-3 py-1.5" colSpan={2}>
            <div className="flex items-center gap-2 flex-wrap">
              {MFC_COLOR_OPTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={BLD_COLOR_LABEL[c]}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors
                    ${color === c ? "border-primary bg-primary/10 font-semibold" : "border-border/60 hover:bg-muted/40"}`}
                >
                  <BldColorDot color={c} />
                  {BLD_COLOR_LABEL[c]}
                </button>
              ))}
            </div>
          </td>
          <td className="px-2 py-1.5">
            <div className="flex gap-1">
              <Button size="sm" className="h-6 text-[11px] px-2" onClick={handleSave} disabled={isSaving}>
                Save
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </td>
        </>
      ) : (
        <>
          <td className="px-3 py-2 text-muted-foreground text-[11px] italic">No colour</td>
          <td />
          <td className="px-2 py-1.5">
            <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => setOpen(true)}>
              Assign colour
            </Button>
          </td>
        </>
      )}
    </tr>
  );
}

function BucketListDatesContent() {
  const { toast } = useToast();
  const { data: authStatus } = useGetAuthStatus({ query: { queryKey: getGetAuthStatusQueryKey() } });
  const canEdit = authStatus?.role === "admin";

  const { data: entries = [], isLoading } = useListInventoryMfcBatchColors({
    query: { queryKey: getListInventoryMfcBatchColorsQueryKey() },
  });

  // All (project, mfcBatch) pairs that have live WIP marks.
  const { data: bucketsData, isLoading: bucketsLoading } = useGetInventoryBuckets({
    query: { queryKey: getGetInventoryBucketsQueryKey() },
  });

  const upsertMutation = useUpsertInventoryMfcBatchColor({
    mutation: {
      onSuccess: () => toast({ title: "Entry updated" }),
      onError: () => toast({ variant: "destructive", title: "Save failed" }),
    },
  });

  const deleteMutation = useDeleteInventoryMfcBatchColor({
    mutation: {
      onSuccess: () => toast({ title: "Entry deleted" }),
      onError: () => toast({ variant: "destructive", title: "Delete failed" }),
    },
  });

  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const handleDelete = (project: string, mfcBatch: string) => {
    const key = `${project}\u0001${mfcBatch}`;
    setDeletingKey(key);
    deleteMutation.mutate(
      { params: { project, mfcBatch } },
      { onSettled: () => setDeletingKey(null) },
    );
  };

  const handleSave = (entry: InventoryMfcBatchColor, patch: { color: string; dateOfClientMfc: string; projectStartDate: string }) => {
    upsertMutation.mutate({
      data: {
        project: entry.project,
        mfcBatch: entry.mfcBatch,
        color: patch.color as InventoryMfcBatchColor["color"],
        dateOfClientMfc: patch.dateOfClientMfc || undefined,
        projectStartDate: patch.projectStartDate || undefined,
      },
    });
  };

  const sorted = useMemo(
    () => [...entries].sort((a, b) => a.project.localeCompare(b.project) || a.mfcBatch.localeCompare(b.mfcBatch)),
    [entries],
  );

  // Pairs with live WIP marks that have no colour entry yet.
  const unassigned = useMemo(() => {
    const assignedKeys = new Set(entries.map((e) => `${e.project}\u0001${e.mfcBatch}`));
    const seen = new Set<string>();
    const result: { project: string; mfcBatch: string }[] = [];
    for (const r of (bucketsData?.rows ?? [])) {
      if (!r.hasWipMarks) continue;
      const key = `${r.project}\u0001${r.mfcBatch}`;
      if (assignedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      result.push({ project: r.project, mfcBatch: r.mfcBatch });
    }
    return result.sort((a, b) => a.project.localeCompare(b.project) || a.mfcBatch.localeCompare(b.mfcBatch));
  }, [bucketsData, entries]);

  const handleAssignNew = (project: string, mfcBatch: string, color: BldColorName) => {
    upsertMutation.mutate({
      data: { project, mfcBatch, color, dateOfClientMfc: undefined, projectStartDate: undefined },
    });
  };

  const missingCount = sorted.filter((e) => !e.dateOfClientMfc || !e.projectStartDate).length;

  if (isLoading || bucketsLoading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {/* ── Unassigned (no colour yet) ── */}
      {unassigned.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base uppercase tracking-wider text-destructive/80">
              {unassigned.length} Project{unassigned.length !== 1 ? "s / Batches" : " / Batch"} — No Colour Assigned
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-destructive/5 text-muted-foreground uppercase tracking-wider border-b border-border">
                    <th className="text-left px-3 py-2 font-semibold">Project</th>
                    <th className="text-left px-3 py-2 font-semibold">MFC Batch</th>
                    <th className="text-left px-3 py-2 font-semibold">Colour</th>
                    <th className="px-3 py-2" colSpan={2} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {unassigned.map((r) => (
                    <UnassignedBldRow
                      key={`${r.project}\u0001${r.mfcBatch}`}
                      project={r.project}
                      mfcBatch={r.mfcBatch}
                      onSaved={handleAssignNew}
                      isSaving={upsertMutation.isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Assigned entries ── */}
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            Bucket List — Colour &amp; Date Entries
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Per-(project, MFC batch) colour and milestone date entries. Dates and colours are
            stored permanently and are never rebuilt from an import.
          </p>
          {missingCount > 0 && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {missingCount} entr{missingCount !== 1 ? "ies" : "y"} missing at least one date — shown with amber highlight.
            </div>
          )}
          {sorted.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No colour entries yet. Use the &quot;Assign colour&quot; button above to add one.
            </p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-semibold">Project</th>
                    <th className="text-left px-3 py-2 font-semibold">MFC Batch</th>
                    <th className="text-left px-3 py-2 font-semibold">Colour</th>
                    <th className="text-left px-3 py-2 font-semibold">Date of Client MFC</th>
                    <th className="text-left px-3 py-2 font-semibold">Project Start Date</th>
                    {canEdit && <th className="px-2 py-2 w-16" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map((entry) => {
                    const key = `${entry.project}\u0001${entry.mfcBatch}`;
                    const missing = !entry.dateOfClientMfc || !entry.projectStartDate;
                    return (
                      <BldRow
                        key={key}
                        entry={entry}
                        canEdit={canEdit}
                        isMissing={missing}
                        deletingKey={deletingKey}
                        onDelete={handleDelete}
                        onSave={handleSave}
                        isSaving={upsertMutation.isPending}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BldRow({
  entry,
  canEdit,
  isMissing,
  deletingKey,
  onDelete,
  onSave,
  isSaving,
}: {
  entry: InventoryMfcBatchColor;
  canEdit: boolean;
  isMissing: boolean;
  deletingKey: string | null;
  onDelete: (project: string, mfcBatch: string) => void;
  onSave: (entry: InventoryMfcBatchColor, patch: { color: string; dateOfClientMfc: string; projectStartDate: string }) => void;
  isSaving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState(entry.color as string);
  const [mfcDate, setMfcDate] = useState(entry.dateOfClientMfc ?? "");
  const [startDate, setStartDate] = useState(entry.projectStartDate ?? "");

  const handleEdit = () => {
    setColor(entry.color as string);
    setMfcDate(entry.dateOfClientMfc ?? "");
    setStartDate(entry.projectStartDate ?? "");
    setEditing(true);
  };

  const handleSave = () => {
    onSave(entry, { color, dateOfClientMfc: mfcDate, projectStartDate: startDate });
    setEditing(false);
  };

  const rowKey = `${entry.project}\u0001${entry.mfcBatch}`;
  const isDeleting = deletingKey === rowKey;

  return (
    <tr className={`hover:bg-muted/30 ${isMissing ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}`}>
      {/* Project */}
      <td className="px-3 py-2 font-mono font-medium">{entry.project}</td>
      {/* MFC Batch */}
      <td className="px-3 py-2">
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground">
          {entry.mfcBatch}
        </span>
      </td>

      {editing ? (
        <>
          {/* Colour select */}
          <td className="px-3 py-1.5">
            <div className="flex gap-1.5 flex-wrap">
              {MFC_COLOR_OPTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={BLD_COLOR_LABEL[c]}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors
                    ${color === c
                      ? "border-primary bg-primary/10 font-semibold"
                      : "border-border/60 hover:bg-muted/40"}`}
                >
                  <BldColorDot color={c} />
                  {BLD_COLOR_LABEL[c]}
                </button>
              ))}
            </div>
          </td>
          {/* Date of Client MFC */}
          <td className="px-3 py-1.5">
            <input
              type="date"
              value={mfcDate}
              onChange={(e) => setMfcDate(e.target.value)}
              className="h-7 rounded border border-border bg-background px-2 text-xs w-36"
            />
          </td>
          {/* Project Start Date */}
          <td className="px-3 py-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-7 rounded border border-border bg-background px-2 text-xs w-36"
            />
          </td>
          {canEdit && (
            <td className="px-2 py-1.5">
              <div className="flex gap-1">
                <Button size="sm" className="h-6 text-[11px] px-2" onClick={handleSave} disabled={isSaving}>
                  Save
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </td>
          )}
        </>
      ) : (
        <>
          {/* Colour dot + label */}
          <td className="px-3 py-2">
            <span className="flex items-center gap-1.5">
              <BldColorDot color={entry.color as string} />
              <span>{BLD_COLOR_LABEL[entry.color as BldColorName] ?? entry.color}</span>
            </span>
          </td>
          {/* Date of Client MFC */}
          <td className="px-3 py-2 text-muted-foreground">
            {entry.dateOfClientMfc
              ? formatDate(entry.dateOfClientMfc)
              : <span className="text-amber-600 dark:text-amber-400 font-semibold">—</span>}
          </td>
          {/* Project Start Date */}
          <td className="px-3 py-2 text-muted-foreground">
            {entry.projectStartDate
              ? formatDate(entry.projectStartDate)
              : <span className="text-amber-600 dark:text-amber-400 font-semibold">—</span>}
          </td>
          {canEdit && (
            <td className="px-2 py-1.5">
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleEdit}
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={isDeleting}
                  onClick={() => onDelete(entry.project, entry.mfcBatch)}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </td>
          )}
        </>
      )}
    </tr>
  );
}
