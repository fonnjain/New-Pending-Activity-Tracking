import { useMemo, useState, Fragment } from "react";
import { useListImports, useGetImportRecords, useDeleteImport, useDeleteAllImports, useDeleteOrderImport, getListImportsQueryKey, getGetImportRecordsQueryKey, useGetOrderStatus, getGetOrderStatusQueryKey, getGetMilestonesQueryKey, useAdminRecompute, useGetCurrentJobs, useUploadCurrentJobs, useClearCurrentJobs, getGetCurrentJobsQueryKey, useGetReleaseBalance, getGetReleaseBalanceQueryKey, useGetAuthStatus, useListUsers, useCreateUser, useResetUserPassword, useUpdateUserRole, useDeleteUser, useGetUserActivity, useListDeletionLog, getGetAuthStatusQueryKey, getListUsersQueryKey, getGetUserActivityQueryKey, type CommitResult, type DispatchReconciliationRow, type BalanceReconciliationRow, type AppUser, type UserSessionEntry } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor, useCurrentJobsSet, CURRENT_JOBS_FILTER_VALUE, MULTI_JOBS_FILTER_VALUE } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useFgRows, type FgComputedRow } from "@/lib/fg";
import { contractorCategoryLabel } from "@workspace/domain";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileDown, CheckCircle2, Trash2, FileSpreadsheet, AlertTriangle, RefreshCw, ListChecks, ChevronDown, ChevronRight, UserPlus, RotateCcw, ShieldCheck, Shield, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsx, exportToJson, type XlsxColumn } from "@/lib/export";
import { formatDate } from "@/lib/utils";
import { AiSanitizePanel } from "@/components/ai-sanitize-panel";
import { AiReviewPanel } from "@/components/ai-review-panel";
import { StagedUploadPanel } from "@/components/staged-upload-panel";
import { AccessDenied, LogoutButton } from "@/components/login-gate";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Segmented } from "@/components/ui/segmented";
import { ContractorSetupContent } from "@/pages/contractor-setup";
import { WarningParametersContent } from "@/pages/warning-parameters";
import { ThicknessContent } from "@/pages/thickness";

const ADMIN_TABS = [
  { path: "/data", label: "Data" },
  { path: "/computed-fg", label: "Computed FG" },
  { path: "/order-reconciliation", label: "Order Reconciliation" },
  { path: "/release-balance", label: "Release Balance" },
  { path: "/order-review-generated", label: "Order Review (Gen.)" },
  { path: "/contractor-setup", label: "Contractor Setup" },
  { path: "/warning-parameters", label: "Warning Parameters" },
  { path: "/thickness", label: "Thickness" },
  { path: "/users", label: "Users" },
] as const;

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
          options={ADMIN_TABS.map((t) => ({ value: t.path, label: t.label }))}
        />
      </div>
      {active === "/computed-fg" ? (
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

      <CurrentJobsCard />

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
function CurrentJobsCard() {
  const { data, refetch } = useGetCurrentJobs();
  const upload = useUploadCurrentJobs();
  const clear = useClearCurrentJobs();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const meta = data?.meta ?? null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    upload.mutate(
      { data: { file } },
      {
        onSuccess: (res) => {
          toast({
            title: "Current Jobs list uploaded",
            description: `${res.codeCount.toLocaleString()} codes, ${res.matchedCount.toLocaleString()} matched known projects${res.unmatched.length > 0 ? `, ${res.unmatched.length.toLocaleString()} unmatched` : ""}.`,
          });
          queryClient.invalidateQueries({ queryKey: getGetCurrentJobsQueryKey() });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not upload Current Jobs list",
            description: err?.data?.error || err?.message || "Unknown error",
          });
        },
      },
    );
    e.target.value = "";
  };

  const handleClear = () => {
    if (!confirm("Clear the Current Jobs list? The \"Current Jobs\" Job filter will then match nothing until a new list is uploaded.")) return;
    clear.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Current Jobs list cleared" });
        queryClient.invalidateQueries({ queryKey: getGetCurrentJobsQueryKey() });
        refetch();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Clear failed", description: err?.message || "Unknown error" });
      },
    });
  };

  return (
    <Card className="border-emerald-500/40 bg-emerald-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <ListChecks className="w-4 h-4" /> Current Jobs
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Upload a plain list of project codes (.xlsx/.xls). This powers a "Current Jobs" option in the
          Job filter that restricts every page to only these projects. Each upload replaces the previous list.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild className="h-9 gap-2" disabled={upload.isPending}>
            <label className="cursor-pointer">
              <ListChecks className="w-4 h-4" />
              {upload.isPending ? "Uploading..." : "Upload Current Jobs list"}
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
                disabled={upload.isPending}
              />
            </label>
          </Button>
          {meta && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              onClick={handleClear}
              disabled={clear.isPending}
            >
              <Trash2 className="w-4 h-4" />
              {clear.isPending ? "Clearing..." : "Clear list"}
            </Button>
          )}
        </div>
        {meta ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm pt-1">
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">File</span>
              <span className="font-bold truncate block" title={meta.fileName}>{meta.fileName}</span>
            </div>
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">Uploaded</span>
              <span className="font-bold tabular-nums">{formatDate(meta.uploadedAt)}</span>
            </div>
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">Codes</span>
              <span className="font-bold text-lg tabular-nums text-primary">{meta.codeCount.toLocaleString()}</span>
            </div>
            <div>
              <span className="block text-muted-foreground text-xs uppercase mb-1">Matched Known Projects</span>
              <span className="font-bold text-lg tabular-nums">{meta.matchedCount.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No Current Jobs list uploaded yet.</p>
        )}
        {meta && meta.unmatched.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {meta.unmatched.length.toLocaleString()} code{meta.unmatched.length === 1 ? "" : "s"} did not match any
              known project from the latest WIP or Order Review import (still stored and usable by the filter):{" "}
              <span className="font-mono">{meta.unmatched.join(", ")}</span>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReleaseBalanceContent() {
  // No importId param — defaults to the latest import on the server side,
  // which is what the comparison page needs (it is not import-selector-scoped).
  const { data, isLoading } = useGetReleaseBalance(undefined, {
    query: { queryKey: getGetReleaseBalanceQueryKey() },
  });
  const { filters } = useTracker();
  const { set: currentJobsSet } = useCurrentJobsSet();
  const activeJobSet = useMemo(() => {
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) return currentJobsSet;
    if (filters.job === MULTI_JOBS_FILTER_VALUE)
      return filters.selectedJobs.length > 0 ? new Set(filters.selectedJobs) : null;
    if (filters.job) return new Set([filters.job]);
    return null;
  }, [filters.job, filters.selectedJobs, currentJobsSet]);
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

// ─── Generated Order Review ──────────────────────────────────────────────────

const GEN_FAB_PROG = new Set(["G", "GB", "Y"]);
const GEN_FAB_BAL  = new Set(["C", "HG", "RFI", "NH", "B", "HAB", "W", "Q", "TS"]);
const GEN_GALV_BAL = new Set(["C", "HG", "RFI", "NH", "B", "HAB", "W", "Q", "TS", "G", "GB"]);

type GenStructRow = {
  structure: string; subType: string | null; mfcBatch: string; markCount: number;
  L: number; M: number; N: number; S: number; T: number; U: number; V: number;
  orL: number | null; orS: number | null; hasDiff: boolean;
};
type GenProjGroup = {
  project: string; releasePct: number; structures: GenStructRow[];
  totals: { L: number; M: number; N: number; S: number; T: number; U: number; V: number };
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

  // Project-level OR summary: project → { releaseMt, woQtyMt }
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
    // TLT / Structure marks only, with a real project code and a structure
    const tlt = records.filter(
      (r) =>
        (r.category === "TLT" || (r.orderNature ?? "").trim().toUpperCase() === "STRUCTURE") &&
        r.job && r.job !== "(Unassigned)",
    );

    // Group: project → structure → marks[]
    type Rec = typeof tlt[number];
    const byProj = new Map<string, Map<string, Rec[]>>();
    for (const r of tlt) {
      const struct = (r.structure ?? "").trim();
      if (!struct) continue;
      if (!byProj.has(r.job)) byProj.set(r.job, new Map());
      const sm = byProj.get(r.job)!;
      if (!sm.has(struct)) sm.set(struct, []);
      sm.get(struct)!.push(r);
    }

    const groups: GenProjGroup[] = [];
    for (const [proj, structMap] of byProj) {
      const orS      = orProjSummary.get(proj);
      const projWoQty   = orS?.woQtyMt   ?? 0;
      const projRelease = orS?.releaseMt  ?? 0;
      const releasePct  = projWoQty > 0 ? (projRelease / projWoQty) * 100 : 0;
      // Skip projects that are beyond the trust boundary (>= 5% released)
      if (projWoQty > 0 && releasePct >= 5) continue;

      const structures: GenStructRow[] = [];
      for (const [struct, marks] of structMap) {
        const actOf   = (r: Rec) => (r.activity ?? "").toUpperCase().trim();
        const sum     = (arr: Rec[]) => arr.reduce((s, r) => s + (r.balanceWt ?? 0), 0);
        const toMt    = (kg: number) => kg / 1000;
        const nonInit = marks.filter((r) => !r.isInitialCutting);

        const L = toMt(sum(nonInit));
        const S = toMt(sum(marks.filter((r) =>  r.isInitialCutting)));
        const M = toMt(sum(nonInit.filter((r) => GEN_FAB_PROG.has(actOf(r)))));
        const T = toMt(sum(nonInit.filter((r) => GEN_FAB_BAL.has(actOf(r)))));
        const N = toMt(sum(nonInit.filter((r) => actOf(r) === "Y")));
        const U = toMt(sum(nonInit.filter((r) => GEN_GALV_BAL.has(actOf(r)))));
        const V = toMt(sum(nonInit.filter((r) => actOf(r) !== "Y")));

        const orRow = orByKey.get(`${proj}|${struct}`);
        const orL   = orRow?.releaseMt       ?? null;
        const orSv  = orRow?.fileBalReleaseMt ?? null;
        const diffL = orL  != null ? Math.abs(L - orL)  : null;
        const diffS = orSv != null ? Math.abs(S - orSv) : null;

        structures.push({
          structure: struct,
          subType: marks[0]?.towerSubType ?? null,
          mfcBatch: marks[0]?.mfcBatch ?? "Z",
          markCount: marks.length,
          L, M, N, S, T, U, V,
          orL, orS: orSv,
          hasDiff: (diffL != null && diffL > 0.5) || (diffS != null && diffS > 0.5),
        });
      }
      structures.sort((a, b) => a.structure.localeCompare(b.structure));

      const sf = (f: keyof Pick<GenStructRow, "L"|"M"|"N"|"S"|"T"|"U"|"V">) =>
        structures.reduce((s, r) => s + r[f], 0);
      groups.push({
        project: proj, releasePct, structures,
        totals: { L: sf("L"), M: sf("M"), N: sf("N"), S: sf("S"), T: sf("T"), U: sf("U"), V: sf("V") },
      });
    }
    groups.sort((a, b) => a.project.localeCompare(b.project));
    return groups;
  }, [allRecordsRaw, orByKey, orProjSummary]);

  const grand = useMemo(() => ({
    L: projectGroups.reduce((s, g) => s + g.totals.L, 0),
    M: projectGroups.reduce((s, g) => s + g.totals.M, 0),
    N: projectGroups.reduce((s, g) => s + g.totals.N, 0),
    S: projectGroups.reduce((s, g) => s + g.totals.S, 0),
    T: projectGroups.reduce((s, g) => s + g.totals.T, 0),
    U: projectGroups.reduce((s, g) => s + g.totals.U, 0),
    V: projectGroups.reduce((s, g) => s + g.totals.V, 0),
  }), [projectGroups]);

  const handleExport = () => {
    const rows = projectGroups.flatMap((pg) =>
      pg.structures.map((s) => ({
        project: pg.project, structure: s.structure,
        subType: s.subType ?? "", mfcBatch: s.mfcBatch, marks: s.markCount,
        L: s.L, M: s.M, N: s.N, S: s.S, T: s.T, U: s.U, V: s.V,
        orL: s.orL, orS: s.orS,
      })),
    );
    exportToXlsx(
      `generated_order_review_${new Date().toISOString().slice(0, 10)}.xlsx`,
      [
        { label: "Project",                           field: "project"  },
        { label: "Structure",                         field: "structure" },
        { label: "Sub Type",                          field: "subType"  },
        { label: "MFC Batch",                         field: "mfcBatch" },
        { label: "Marks",                             field: "marks",   numeric: true },
        { label: "Progress Release L [Gen] (MT)",     field: "L", numeric: true, decimals: 3, total: true },
        { label: "Progress Fab M [Gen] (MT)",         field: "M", numeric: true, decimals: 3, total: true },
        { label: "Progress Galv N [Gen] (MT)",        field: "N", numeric: true, decimals: 3, total: true },
        { label: "Balance Release S [Gen] (MT)",      field: "S", numeric: true, decimals: 3, total: true },
        { label: "Balance Fab T [Gen] (MT)",          field: "T", numeric: true, decimals: 3, total: true },
        { label: "Balance Galv U [Gen] (MT)",         field: "U", numeric: true, decimals: 3, total: true },
        { label: "Balance Insp V [Gen] (MT)",         field: "V", numeric: true, decimals: 3, total: true },
        { label: "OR File – Progress Release L (MT)", field: "orL", numeric: true, decimals: 3 },
        { label: "OR File – Balance Release S (MT)",  field: "orS", numeric: true, decimals: 3 },
      ] as XlsxColumn[],
      rows,
      { sheetName: "Generated Order Review" },
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
            Reconstructed from WIP for newly started projects (Progress Release &lt; 5% of WO Qty).
            Accurate only while a project is new; beyond 5% released, completed marks have left WIP and
            the figures would be wrong. This view is read-only and does not affect the imported Order
            Review anywhere in the app. Where OR file values are available, differences &gt; 0.5 MT are
            flagged.
          </p>
        </div>
        {projectGroups.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleExport} className="shrink-0">
            <FileDown className="h-4 w-4 mr-1.5" />
            Export
          </Button>
        )}
      </div>

      {projectGroups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No newly started projects — this view populates when a project's marks first appear in WIP
            (Progress Release &lt; 5% of WO Qty).
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary chips */}
          <div className="flex gap-3 flex-wrap text-sm">
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {projectGroups.length} project{projectGroups.length !== 1 ? "s" : ""}
            </span>
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {structCount} structure{structCount !== 1 ? "s" : ""}
            </span>
            <span className="rounded-md bg-muted px-3 py-1 font-medium">
              {markCount.toLocaleString()} marks
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
                      <th className="px-3 py-2 text-left font-semibold min-w-[70px]" rowSpan={2}>Sub Type</th>
                      <th className="px-3 py-2 text-left font-semibold min-w-[55px]" rowSpan={2}>MFC</th>
                      <th className="px-3 py-2 text-right font-semibold min-w-[50px]" rowSpan={2}>Marks</th>
                      <th className="px-3 py-2 text-center font-semibold border-l text-blue-700 dark:text-blue-400" colSpan={3}>
                        Progress (MT)
                      </th>
                      <th className="px-3 py-2 text-center font-semibold border-l text-orange-700 dark:text-orange-400" colSpan={4}>
                        Balance (MT)
                      </th>
                    </tr>
                    <tr className="bg-muted/60 border-b text-[11px]">
                      <th className="px-3 py-1.5 text-right font-medium border-l min-w-[95px] text-blue-700 dark:text-blue-400">
                        Release L
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium min-w-[65px]">Fab M</th>
                      <th className="px-3 py-1.5 text-right font-medium min-w-[65px]">Galv N</th>
                      <th className="px-3 py-1.5 text-right font-medium border-l min-w-[95px] text-orange-700 dark:text-orange-400">
                        Release S
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium min-w-[65px]">Fab T</th>
                      <th className="px-3 py-1.5 text-right font-medium min-w-[65px]">Galv U</th>
                      <th className="px-3 py-1.5 text-right font-medium min-w-[65px]">Insp V</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {projectGroups.map((pg) => (
                      <Fragment key={pg.project}>
                        {pg.structures.map((s, si) => (
                          <tr
                            key={s.structure}
                            className={`hover:bg-muted/20 ${s.hasDiff ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}
                          >
                            {si === 0 && (
                              <td
                                className="px-3 py-2 font-bold align-top border-r bg-muted/10"
                                rowSpan={pg.structures.length + 1}
                              >
                                <span className="font-mono text-sm">{pg.project}</span>
                                <br />
                                <span className="text-muted-foreground font-normal text-[10px]">
                                  {pg.structures.length} structure{pg.structures.length !== 1 ? "s" : ""}
                                  {" · "}
                                  {pct1(pg.releasePct)} released
                                </span>
                              </td>
                            )}
                            <td className="px-3 py-1.5 font-mono">{s.structure}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{s.subType ?? "-"}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{s.mfcBatch}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{s.markCount}</td>
                            {/* Progress Release L — with OR comparison */}
                            <td className="px-3 py-1.5 text-right tabular-nums border-l">
                              <span className={s.orL != null && Math.abs(s.L - s.orL) > 0.5 ? "text-amber-600 font-semibold" : ""}>
                                {mt3(s.L)}
                              </span>
                              {s.orL != null && (
                                <span className="block text-[10px] text-muted-foreground leading-tight">
                                  OR: {mt3(s.orL)}
                                  {Math.abs(s.L - s.orL) > 0.5 && (
                                    <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5 text-amber-500" />
                                  )}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{mt3(s.M)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{mt3(s.N)}</td>
                            {/* Balance Release S — with OR comparison */}
                            <td className="px-3 py-1.5 text-right tabular-nums border-l">
                              <span className={s.orS != null && Math.abs(s.S - s.orS) > 0.5 ? "text-amber-600 font-semibold" : ""}>
                                {mt3(s.S)}
                              </span>
                              {s.orS != null && (
                                <span className="block text-[10px] text-muted-foreground leading-tight">
                                  OR: {mt3(s.orS)}
                                  {Math.abs(s.S - s.orS) > 0.5 && (
                                    <AlertTriangle className="inline h-2.5 w-2.5 ml-0.5 text-amber-500" />
                                  )}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{mt3(s.T)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{mt3(s.U)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{mt3(s.V)}</td>
                          </tr>
                        ))}
                        {/* Per-project subtotal */}
                        <tr className="bg-muted/40 font-semibold border-t border-b-2 text-[11px]">
                          {/* project col already spanned */}
                          <td className="px-3 py-1.5 text-muted-foreground uppercase tracking-wide" colSpan={4}>
                            Subtotal
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums border-l">{mt3(pg.totals.L)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{mt3(pg.totals.M)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{mt3(pg.totals.N)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums border-l">{mt3(pg.totals.S)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{mt3(pg.totals.T)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{mt3(pg.totals.U)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{mt3(pg.totals.V)}</td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/60 font-bold border-t-2 text-[11px]">
                      <td className="px-3 py-2 uppercase tracking-wide">Grand Total</td>
                      <td colSpan={4} className="px-3 py-2 text-muted-foreground">
                        {projectGroups.length} projects · {structCount} structures · {markCount.toLocaleString()} marks
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums border-l">{mt3(grand.L)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(grand.M)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(grand.N)}</td>
                      <td className="px-3 py-2 text-right tabular-nums border-l">{mt3(grand.S)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(grand.T)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(grand.U)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mt3(grand.V)}</td>
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
  const { set: currentJobsSet } = useCurrentJobsSet();
  const activeJobSet = useMemo(() => {
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) return currentJobsSet;
    if (filters.job === MULTI_JOBS_FILTER_VALUE)
      return filters.selectedJobs.length > 0 ? new Set(filters.selectedJobs) : null;
    if (filters.job) return new Set([filters.job]);
    return null;
  }, [filters.job, filters.selectedJobs, currentJobsSet]);

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
