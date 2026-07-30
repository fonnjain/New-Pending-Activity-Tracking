import { useMemo, useState, Fragment } from "react";
import { useListImports, useGetImportRecords, useDeleteImport, useDeleteAllImports, useDeleteOrderImport, getListImportsQueryKey, getGetImportRecordsQueryKey, useGetOrderStatus, getGetOrderStatusQueryKey, getGetMilestonesQueryKey, useAdminRecompute, useGetReleaseBalance, getGetReleaseBalanceQueryKey, useGetAuthStatus, useListUsers, useCreateUser, useResetUserPassword, useUpdateUserRole, useDeleteUser, useGetUserActivity, useListDeletionLog, getGetAuthStatusQueryKey, getListUsersQueryKey, getGetUserActivityQueryKey, useListInventoryMfcBatchColors, getListInventoryMfcBatchColorsQueryKey, useUpsertInventoryMfcBatchColor, useDeleteInventoryMfcBatchColor, type InventoryMfcBatchColor, type CommitResult, type DispatchReconciliationRow, type BalanceReconciliationRow, type AppUser, type UserSessionEntry, type OrderStatusRow, type ErpRulesResponse, type ErpRuleResult } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor, useActiveJobSet, isNamedJobSetFilter, MULTI_JOBS_FILTER_VALUE } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useFgRows, type FgComputedRow } from "@/lib/fg";
import { contractorCategoryLabel } from "@workspace/domain";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileDown, CheckCircle2, Trash2, FileSpreadsheet, AlertTriangle, RefreshCw, PlusCircle, ChevronDown, ChevronRight, UserPlus, RotateCcw, ShieldCheck, Shield, History, CircleCheck, CircleX, Info, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsx, exportToJson, type XlsxColumn } from "@/lib/export";
import { formatDate } from "@/lib/utils";
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

const ADMIN_TABS: Array<{ path: string; label: string; disabled?: boolean }> = [
  { path: "/data", label: "Data" },
  { path: "/job-templates", label: "Job Templates", disabled: true },
  { path: "/computed-fg", label: "Computed FG" },
  { path: "/order-reconciliation", label: "Order Reconciliation" },
  { path: "/release-balance", label: "Release Balance" },
  { path: "/order-review-generated", label: "Order Review (Gen.)" },
  { path: "/contractor-setup", label: "Contractor Setup" },
  { path: "/warning-parameters", label: "Warning Parameters" },
  { path: "/thickness", label: "Thickness" },
  { path: "/erp-rules", label: "ERP Rules" },
  { path: "/bucket-list-dates", label: "Bucket List Dates" },
  { path: "/users", label: "Users" },
];

export default function DataView() {
  const { data: authStatus } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey() },
  });
  if (authStatus && authStatus.role !== "admin") {
    return <AccessDenied />;
  }
  return <AdminTabbedPage />;
}

function AdminTabbedPage() {
  const [location, setLocation] = useLocation();
  const active = ADMIN_TABS.find((t) => t.path === location)?.path ?? "/data";
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <Segmented
          value={active}
          onChange={(v) => v && setLocation(v)}
          options={ADMIN_TABS.map((t) => ({ value: t.path, label: t.label, disabled: t.disabled }))}
        />
      </div>
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
      ) : active === "/erp-rules" ? (
        <ErpRulesContent />
      ) : active === "/bucket-list-dates" ? (
        <BucketListDatesContent />
      ) : active === "/users" ? (
        <UsersContent />
      ) : (
        <DataViewContent />
      )}
    </div>
  );
}

function DataViewContent() {
  const { data: imports = [], refetch } = useListImports();
  const { data: orderStatus } = useGetOrderStatus({ query: { queryKey: getGetOrderStatusQueryKey() } });
  const orderImports = orderStatus?.imports ?? [];
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
  const { selectedImportId, setSelectedImportId } = useTracker();
  const [, setLocation] = useLocation();
  const deleteImport = useDeleteImport();
  const deleteAll = useDeleteAllImports();
  const deleteOrderImport = useDeleteOrderImport();
  const adminRecompute = useAdminRecompute();
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const filteredRecords = useFilteredRecords(allRecords);
  const contractorCategories = useContractorCategoryMap();

  const selectedImport = imports.find(s => s.id === selectedImportId);

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
    setSelectedImportId(res.import.id);
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
    if (!confirm("Delete this Order Review file from the history? The current order book is a merge of all uploads, so deleting one history entry does not change the current numbers. Deleting the last remaining entry clears the order book entirely.")) return;
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
    const date = new Date().toISOString().slice(0, 10);
    exportToJson(`import_${selectedImportId}_${date}.json`, { import: selectedImport, records: allRecords });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Data</h1>
        <div className="flex items-center gap-2">
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
                    <span className="font-bold text-lg tabular-nums">{(selectedImport.summary.ntltOrphanWtMt ?? 0).toFixed(3)} MT</span>
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
            </div>
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
                    <div className="font-bold flex items-center gap-2">
                      {s.label || s.sourceFilename}
                      {selectedImportId === s.id && <CheckCircle2 className="w-4 h-4 text-primary" />}
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
                      {o.changeLog && (
                        <>
                          <span className="text-emerald-600 dark:text-emerald-400">+{o.changeLog.inserted.length.toLocaleString()} added</span>
                          <span>{o.changeLog.updated.length.toLocaleString()} updated</span>
                          <span>{o.changeLog.unchanged.toLocaleString()} unchanged</span>
                        </>
                      )}
                      {o.summary.missingStructure > 0
                        ? <span className="text-destructive font-medium">{o.summary.missingStructure} orphaned row{o.summary.missingStructure === 1 ? "" : "s"}{o.summary.missingStructureWtMt != null ? ` · ${o.summary.missingStructureWtMt.toFixed(3)} MT` : ""} missing structure</span>
                        : <span>0 missing structure</span>
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
  const activeJobSet = useMemo(() => {
    if (isNamedJobSetFilter(filters.job)) return namedJobSet;
    if (filters.job === MULTI_JOBS_FILTER_VALUE)
      return filters.selectedJobs.length > 0 ? new Set(filters.selectedJobs) : null;
    if (filters.job) return new Set([filters.job]);
    return null;
  }, [filters.job, filters.selectedJobs, namedJobSet]);
  const allRows = useMemo(() => data?.rows ?? [], [data]);
  const rows = useMemo(
    () => (activeJobSet ? allRows.filter((r) => activeJobSet.has(r.project ?? "")) : allRows),
    [allRows, activeJobSet],
  );
  const totals = useMemo(() => {
    if (!activeJobSet) return data?.totals;
    return {
      releaseBalanceComputedMt: rows.reduce((s, r) => s + (r.releaseBalanceComputedMt ?? 0), 0),
      releaseBalanceOrderReviewMt: rows.reduce((s, r) => s + (r.releaseBalanceOrderReviewMt ?? 0), 0),
      diffMt: rows.reduce((s, r) => s + (r.diffMt ?? 0), 0),
      rowCount: rows.length,
    };
  }, [activeJobSet, data, rows]);

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
            No Release Balance data. Upload a WIP file in the newer format
            (with "Type" and "Job Card Status" columns) to populate this view.
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
// Activity sets for chain computation (per spec)
const GEN_FAB_ACTS  = new Set(["C","HG","RFI","NH","B","HAB","W","Q","TS"]);
const GEN_GALV_ACTS = new Set(["G","GB","Y"]);

type ConfTier = "high" | "medium" | "low";
interface GenStageSpec {
  key: string; label: string; shortLabel: string;
  genField: keyof GenStructRowData;
  orField: "releaseMt"|"fileFabMt"|"fileGalvMt"|"inspectionMt"|"fileDespatchMt"|null;
  tier: ConfTier;
}
const GEN_STAGES: GenStageSpec[] = [
  { key:"rel",  label:"Progress Release",     shortLabel:"Rel",  genField:"genProgRelease", orField:"releaseMt",     tier:"high"   },
  { key:"fab",  label:"Progress Fabrication", shortLabel:"Fab",  genField:"genProgFab",    orField:"fileFabMt",     tier:"high"   },
  { key:"galv", label:"Progress Galvanising", shortLabel:"Galv", genField:"genProgGalv",   orField:"fileGalvMt",    tier:"medium" },
  { key:"insp", label:"Progress Inspection",  shortLabel:"Insp", genField:"genProgInsp",   orField:"inspectionMt",  tier:"low"    },
  { key:"desp", label:"Progress Despatch",    shortLabel:"Desp", genField:"genProgDesp",   orField:"fileDespatchMt",tier:"low"    },
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
  genProgInsp: number;       // genProgGalv - fgWt
  totalWt: number;           // all marks weight (MT)
  genProgDesp: number | null;// woQty - totalWt (null if no woQty)
  // OR file comparison values
  orProgRelease: number | null; orProgFab: number | null;
  orProgGalv: number | null;    orProgInsp: number | null;
  orProgDesp: number | null;
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
  const isLoading = recLoading || orLoading;

  // OR lookup: "project|structure" → order status row
  const orByKey = useMemo(() => {
    const rows = orderStatus?.rows ?? [];
    return new Map(rows.map((r) => [`${r.project}|${r.structure}`, r]));
  }, [orderStatus]);

  // Project-level OR summary for release %
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
      const orS = orProjSummary.get(proj);
      const projWoQty   = orS?.woQtyMt  ?? 0;
      const projRelease = orS?.releaseMt ?? 0;
      const releasePct  = projWoQty > 0 ? (projRelease / projWoQty) * 100 : 0;
      // No longer filtering by 5% — include ALL structures present in WIP.
      // releasePct is preserved as a "New project" badge only.

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
        const orRow          = orByKey.get(`${proj}|${struct}`);
        const woQty          = orRow?.woOrderQtyMt ?? null;
        // genProgRelease requires woOrderQtyMt from OR file (per spec).
        // Fall back to sum(released) when OR is unavailable.
        const genProgRelease = woQty != null ? woQty - genBalRelease : toMt(sum(released));
        const genBalFab      = toMt(sum(released.filter((r) => GEN_FAB_ACTS.has(actOf(r)))));
        const genProgFab     = genProgRelease - genBalFab;
        const genBalGalv     = toMt(sum(released.filter((r) => GEN_GALV_ACTS.has(actOf(r)))));
        const genProgGalv    = genProgFab - genBalGalv;
        const fgWt           = toMt(sum(fg));
        const genProgInsp    = genProgGalv - fgWt;
        const totalWt        = toMt(sum(marks));
        const genProgDesp    = woQty != null ? woQty - totalWt : null;

        structures.push({
          structure: struct,
          subType: marks[0]?.towerSubType ?? null,
          mfcBatch: marks[0]?.mfcBatch ?? "Z",
          markCount: marks.length,
          isNew: projWoQty > 0 && releasePct < 5,
          woOrderQtyMt: woQty,
          genBalRelease, genProgRelease,
          genBalFab, genProgFab,
          genBalGalv, genProgGalv,
          fgWt, genProgInsp,
          totalWt, genProgDesp,
          orProgRelease: orRow?.releaseMt      ?? null,
          orProgFab:     orRow?.fileFabMt      ?? null,
          orProgGalv:    orRow?.fileGalvMt     ?? null,
          orProgInsp:    orRow?.inspectionMt   ?? null,
          orProgDesp:    orRow?.fileDespatchMt ?? null,
        });
      }
      structures.sort((a, b) => a.structure.localeCompare(b.structure));

      const sf = (f: keyof GenStructRowData) =>
        structures.reduce((s, r) => s + (typeof r[f] === "number" ? (r[f] as number) : 0), 0);
      groups.push({
        project: proj, releasePct, structures,
        totals: {
          genProgRelease: sf("genProgRelease"), genProgFab: sf("genProgFab"),
          genProgGalv: sf("genProgGalv"), genProgInsp: sf("genProgInsp"),
          genProgDesp: structures.reduce((s, r) => s + (r.genProgDesp ?? 0), 0),
        },
      });
    }
    groups.sort((a, b) => a.project.localeCompare(b.project));
    return groups;
  }, [allRecordsRaw, orByKey, orProjSummary]);

  // Per-stage match % summary (structures where |gen - or| <= 0.5 MT and OR is present)
  const stageStats = useMemo(() => {
    const allStructs = projectGroups.flatMap((g) => g.structures);
    return GEN_STAGES.map((stage) => {
      const withOr = allStructs.filter((s) => {
        const or = s[stage.orField as keyof GenStructRowData];
        return typeof or === "number" && or !== null;
      });
      const matching = withOr.filter((s) => {
        const gen = s[stage.genField] as number | null;
        const or  = s[stage.orField as keyof GenStructRowData] as number | null;
        return gen != null && or != null && Math.abs(gen - or) <= 0.5;
      });
      return { key: stage.key, total: withOr.length, matching: matching.length };
    });
  }, [projectGroups]);

  const handleExport = () => {
    const rows = projectGroups.flatMap((pg) =>
      pg.structures.map((s) => ({
        project: pg.project, structure: s.structure,
        subType: s.subType ?? "", mfcBatch: s.mfcBatch, marks: s.markCount,
        genProgRelease: s.genProgRelease, genProgFab: s.genProgFab,
        genProgGalv: s.genProgGalv, genProgInsp: s.genProgInsp,
        genProgDesp: s.genProgDesp,
        orProgRelease: s.orProgRelease, orProgFab: s.orProgFab,
        orProgGalv: s.orProgGalv, orProgInsp: s.orProgInsp,
        orProgDesp: s.orProgDesp,
      })),
    );
    exportToXlsx(
      `generated_order_review_${new Date().toISOString().slice(0, 10)}.xlsx`,
      [
        { label: "Project",                                    field: "project"  },
        { label: "Structure",                                  field: "structure" },
        { label: "Sub Type",                                   field: "subType"  },
        { label: "MFC Batch",                                  field: "mfcBatch" },
        { label: "Marks",                                      field: "marks",   numeric: true },
        { label: "Gen Progress Release (MT)",                  field: "genProgRelease", numeric: true, decimals: 3, total: true },
        { label: "Gen Progress Fabrication (MT)",              field: "genProgFab",    numeric: true, decimals: 3, total: true },
        { label: "Gen Progress Galvanising (MT)",              field: "genProgGalv",   numeric: true, decimals: 3, total: true },
        { label: "Gen Progress Inspection (MT)",               field: "genProgInsp",   numeric: true, decimals: 3, total: true },
        { label: "Gen Progress Despatch (MT)",                 field: "genProgDesp",   numeric: true, decimals: 3, total: true },
        { label: "OR Progress Release (MT)",                   field: "orProgRelease", numeric: true, decimals: 3 },
        { label: "OR Progress Fabrication (MT)",               field: "orProgFab",     numeric: true, decimals: 3 },
        { label: "OR Progress Galvanising (MT)",               field: "orProgGalv",    numeric: true, decimals: 3 },
        { label: "OR Progress Inspection (MT)",                field: "orProgInsp",    numeric: true, decimals: 3 },
        { label: "OR Progress Despatch (MT)",                  field: "orProgDesp",    numeric: true, decimals: 3 },
      ] as XlsxColumn[],
      rows,
      { sheetName: "Generated OR" },
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
            Chain reconstructed from WIP for every structure present in both WIP and the Order Review.
            Confidence varies by stage: Release and Fabrication reconstruct well across all projects;
            Inspection and Despatch are indicative only (low confidence — completed marks have left WIP).
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
          <div className="grid grid-cols-5 gap-3">
            {GEN_STAGES.map((stage) => {
              const stat = stageStats.find((s) => s.key === stage.key)!;
              const pct  = stat.total > 0 ? (stat.matching / stat.total) * 100 : null;
              const tierMeta = TIER_CLS[stage.tier];
              return (
                <div key={stage.key} className="space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold">{stage.shortLabel}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${tierMeta.badge}`}>
                      {stage.tier}
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
                  <thead>
                    <tr className="bg-muted/60 border-b">
                      <th className="px-3 py-2 text-left font-semibold min-w-[80px]" rowSpan={2}>Project</th>
                      <th className="px-3 py-2 text-left font-semibold min-w-[90px]" rowSpan={2}>Structure</th>
                      <th className="px-3 py-2 text-left font-semibold min-w-[50px]" rowSpan={2}>MFC</th>
                      <th className="px-3 py-2 text-right font-semibold min-w-[45px]" rowSpan={2}>Marks</th>
                      {GEN_STAGES.map((stage) => (
                        <th key={stage.key} className="px-3 py-1.5 text-center font-semibold border-l min-w-[90px]">
                          <div>{stage.shortLabel}</div>
                          <div className={`text-[10px] font-normal px-1 py-0.5 rounded mt-0.5 inline-block ${TIER_CLS[stage.tier].badge}`}>
                            {stage.tier}
                          </div>
                        </th>
                      ))}
                    </tr>
                    <tr className="bg-muted/40 border-b text-[10px] text-muted-foreground">
                      {/* spacer cells for fixed cols */}
                      <td colSpan={4} />
                      {GEN_STAGES.map((stage) => (
                        <td key={stage.key} className="px-3 py-1 border-l">
                          <span className="text-foreground/60">gen / OR (MT)</span>
                        </td>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {projectGroups.map((pg) => (
                      <Fragment key={pg.project}>
                        {pg.structures.map((s, si) => {
                          const anyDiff = GEN_STAGES.some((stage) => {
                            const gen = s[stage.genField] as number | null;
                            const or  = s[stage.orField as keyof GenStructRowData] as number | null;
                            return gen != null && or != null && Math.abs(gen - or) > 0.5;
                          });
                          return (
                            <tr key={s.structure} className={`hover:bg-muted/20 ${anyDiff ? "bg-amber-50/40 dark:bg-amber-950/15" : ""}`}>
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
                                      NEW &lt;5%
                                    </span>
                                  )}
                                </td>
                              )}
                              <td className="px-3 py-1.5 font-mono text-[11px]">{s.structure}</td>
                              <td className="px-3 py-1.5 text-muted-foreground text-[10px]">{s.mfcBatch}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{s.markCount}</td>
                              {GEN_STAGES.map((stage) => {
                                const gen = s[stage.genField] as number | null;
                                const or  = s[stage.orField as keyof GenStructRowData] as number | null;
                                const diff = gen != null && or != null ? Math.abs(gen - or) : null;
                                const flagged = diff != null && diff > 0.5;
                                return (
                                  <td key={stage.key} className="px-3 py-1.5 text-right tabular-nums border-l">
                                    <span className={flagged ? TIER_CLS[stage.tier].flag : ""}>
                                      {mt3(gen)}
                                    </span>
                                    {or != null && (
                                      <span className="block text-[10px] text-muted-foreground leading-tight">
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
                        <tr className="bg-muted/40 font-semibold border-t border-b-2 text-[11px]">
                          <td className="px-3 py-1.5 text-muted-foreground uppercase tracking-wide" colSpan={3}>
                            Subtotal
                          </td>
                          {GEN_STAGES.map((stage) => (
                            <td key={stage.key} className="px-3 py-1.5 text-right tabular-nums border-l">
                              {mt3(pg.totals[stage.genField as string])}
                            </td>
                          ))}
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/60 font-bold border-t-2 text-[11px]">
                      <td className="px-3 py-2 uppercase tracking-wide">Grand Total</td>
                      <td colSpan={3} className="px-3 py-2 text-muted-foreground">
                        {projectGroups.length} projects · {structCount} structures · {markCount.toLocaleString()} marks
                      </td>
                      {GEN_STAGES.map((stage) => (
                        <td key={stage.key} className="px-3 py-2 text-right tabular-nums border-l">
                          {mt3(projectGroups.reduce((s, g) => s + (g.totals[stage.genField as string] ?? 0), 0))}
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
        { label: "FG Overview Computed (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
        { label: "FG WIP (MT)", field: "fgWipMt", numeric: true, decimals: 3, total: true },
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
            Finished-goods figures per structure from the Order Review file.
            FG Overview Computed = Galvanising minus Despatch.
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
                      FG Overview Computed (MT){sortArrow("computedFgMt")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("fgWipMt")}>
                      FG WIP (MT){sortArrow("fgWipMt")}
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
    if (filters.job === MULTI_JOBS_FILTER_VALUE)
      return filters.selectedJobs.length > 0 ? new Set(filters.selectedJobs) : null;
    if (filters.job) return new Set([filters.job]);
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
  const [role, setRole] = useState<"user" | "admin">("user");
  const createUser = useCreateUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createUser.mutate(
      { data: { email: email.trim().toLowerCase(), displayName: displayName.trim() || undefined, role } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "User created", description: `${email} added with default password.` });
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
            The user will be created with the default password and must set a new one on first login.
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

      <LoginActivitySection />
    </div>
  );
}

// ── Login Activity ────────────────────────────────────────────────────────────

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

/** Derive the effective "end time" and duration for a session row. */
function sessionStatus(s: UserSessionEntry, now: number): {
  statusLabel: string;
  statusClass: string;
  endTime: string | null;
  durationSeconds: number | null;
} {
  if (s.logoutAt) {
    // Closed session
    return {
      statusLabel: formatTime(s.logoutAt),
      statusClass: "",
      endTime: s.logoutAt,
      durationSeconds: s.durationSeconds ?? null,
    };
  }

  // Open session — determine if still active or idle-ended
  const anchor = s.lastActivityAt ?? s.loginAt;
  const idleMs = now - new Date(anchor).getTime();
  const durationSeconds = Math.max(0, Math.round(
    (new Date(anchor).getTime() - new Date(s.loginAt).getTime()) / 1000,
  ));

  if (idleMs < SESSION_IDLE_MS) {
    // Heartbeat received recently → genuinely active
    return {
      statusLabel: "Active",
      statusClass: "text-green-600 font-medium",
      endTime: null,
      durationSeconds,
    };
  }

  // No heartbeat for >= 5 min → session effectively ended at last activity
  const idleMinutes = Math.floor(idleMs / 60_000);
  return {
    statusLabel: `Idle (${idleMinutes}m ago)`,
    statusClass: "text-muted-foreground",
    endTime: anchor,
    durationSeconds,
  };
}

function DayBlock({ date, sessions, now }: { date: string; sessions: UserSessionEntry[]; now: number }) {
  const [open, setOpen] = useState(true);

  // Parse date for display (YYYY-MM-DD → dd-mm-yyyy)
  const [y, m, d] = date.split("-");
  const displayDate = `${d}-${m}-${y}`;

  const uniqueUsers = new Set(sessions.map((s) => s.userId)).size;

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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">User</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Session Start</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Session End</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground">Active Duration</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const status = sessionStatus(s, now);
                return (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      <div className="font-medium text-sm">{s.displayName || <span className="italic text-muted-foreground">—</span>}</div>
                      <div className="text-xs text-muted-foreground">{s.email}</div>
                    </td>
                    <td className="py-2 px-3 text-xs tabular-nums">{formatTime(s.loginAt)}</td>
                    <td className={`py-2 px-3 text-xs tabular-nums ${status.statusClass}`}>
                      {status.statusLabel}
                    </td>
                    <td className="py-2 px-3 text-xs tabular-nums">{formatDuration(status.durationSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LoginActivitySection() {
  const { data, isLoading } = useGetUserActivity({ query: { queryKey: getGetUserActivityQueryKey() } });
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
              : `${totalSessions} session${totalSessions !== 1 ? "s" : ""} total — sessions split automatically after 5 min of inactivity`}
          </p>
        </div>
      </div>


      {isLoading ? (
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
interface JTProjects { tlt: string[]; ntlt: string[] }

function indexToAlphaLabel(i: number): string {
  let label = "";
  let n = i + 1;
  while (n > 0) { n--; label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26); }
  return label;
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

  const nextLabel = indexToAlphaLabel(catTemplates.length);

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
          className={`shrink-0 w-52 rounded-lg border-2 transition-colors ${
            dropTarget === "pool" ? "border-primary bg-primary/5" : "border-border bg-muted/20"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDropTarget("pool"); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
          onDrop={(e) => { e.preventDefault(); onDrop("pool"); }}
        >
          <div className="px-3 py-2.5 border-b">
            <h3 className="text-sm font-semibold">Available Projects</h3>
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
                  className="px-2 py-1 rounded text-xs font-mono bg-background border cursor-grab hover:bg-accent select-none"
                >
                  {code}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Template columns */}
        {catTemplates.length === 0 ? (
          <div className="flex items-center justify-center border-2 border-dashed rounded-lg w-52 h-32 text-sm text-muted-foreground self-center text-center px-3">
            Click Add to create a template
          </div>
        ) : (
          catTemplates.map((template) => (
            <div
              key={template.id}
              className={`shrink-0 w-52 rounded-lg border-2 transition-colors ${
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
                    {template.members.length} project{template.members.length !== 1 ? "s" : ""}
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
                    Drop projects here
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
                      <span className="flex-1 truncate">{code}</span>
                      <button
                        className="text-muted-foreground hover:text-destructive shrink-0 leading-none text-base"
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
          Dragging <span className="font-mono font-medium">{dragState.code}</span> — drop it onto a template to assign, or onto "Available Projects" to unassign.
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
                      {data.asOnDate ? ` — import ${data.asOnDate}` : ""}
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

function BucketListDatesContent() {
  const { toast } = useToast();
  const { data: authStatus } = useGetAuthStatus({ query: { queryKey: getGetAuthStatusQueryKey() } });
  const canEdit = authStatus?.role === "admin";

  const { data: entries = [], isLoading } = useListInventoryMfcBatchColors({
    query: { queryKey: getListInventoryMfcBatchColorsQueryKey() },
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

  const missingCount = sorted.filter((e) => !e.dateOfClientMfc || !e.projectStartDate).length;

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-4">
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
              No entries yet. Assign a colour on the Bucket List page first.
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
