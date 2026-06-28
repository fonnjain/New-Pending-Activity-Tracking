import { useListImports, useGetImportRecords, useDeleteImport, useDeleteAllImports, getListImportsQueryKey, getGetImportRecordsQueryKey, useGetOrderStatus, getGetOrderStatusQueryKey, type CommitResult, type DispatchReconciliationRow } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor } from "@/lib/store";
import { contractorCategoryLabel } from "@workspace/domain";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileDown, CheckCircle2, Trash2, FileSpreadsheet, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsx, exportToJson, type XlsxColumn } from "@/lib/export";
import { AiSanitizePanel } from "@/components/ai-sanitize-panel";
import { AiReviewPanel } from "@/components/ai-review-panel";
import { StagedUploadPanel } from "@/components/staged-upload-panel";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Segmented } from "@/components/ui/segmented";
import { ContractorSetupContent } from "@/pages/contractor-setup";
import { WarningParametersContent } from "@/pages/warning-parameters";
import { ThicknessContent } from "@/pages/thickness";

const ADMIN_TABS = [
  { path: "/data", label: "Data" },
  { path: "/order-reconciliation", label: "Order Reconciliation" },
  { path: "/contractor-setup", label: "Contractor Setup" },
  { path: "/warning-parameters", label: "Warning Parameters" },
  { path: "/thickness", label: "Thickness" },
] as const;

export default function DataView() {
  return (
    <LoginGate>
      <AdminTabbedPage />
    </LoginGate>
  );
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
      {active === "/order-reconciliation" ? (
        <OrderReconciliationContent />
      ) : active === "/contractor-setup" ? (
        <ContractorSetupContent />
      ) : active === "/warning-parameters" ? (
        <WarningParametersContent />
      ) : active === "/thickness" ? (
        <ThicknessContent />
      ) : (
        <DataViewContent />
      )}
    </div>
  );
}

function DataViewContent() {
  const { data: imports = [], refetch } = useListImports();
  const { selectedImportId, setSelectedImportId } = useTracker();
  const deleteImport = useDeleteImport();
  const deleteAll = useDeleteAllImports();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const filteredRecords = useFilteredRecords(allRecords);
  const contractorCategories = useContractorCategoryMap();

  const selectedImport = imports.find(s => s.id === selectedImportId);

  const handleCommitted = (res: CommitResult) => {
    if (res.kind === "order-review") {
      const s = res.orderReviewImport.summary;
      toast({
        title: "Order Review imported",
        description: s
          ? `${s.rowsKept.toLocaleString()} order rows kept across ${s.projectsFound.toLocaleString()} projects.${res.seeded > 0 ? ` ${res.seeded.toLocaleString()} dispatch keys seeded.` : ""}`
          : "Order Review ingested.",
      });
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
      }
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
        <LogoutButton />
      </div>
      <div className="bg-primary/10 border border-primary/20 rounded-md p-4 flex gap-4 text-sm items-start">
        <div className="text-primary mt-0.5 font-bold">i</div>
        <p className="text-primary-foreground/90 font-medium">
          Every upload is added as a new import. Rows are kept as-is (in-sheet duplicates included) and deduplicated only across uploads. Ageing is computed live (today − Last Production Entry Date).
        </p>
      </div>

      <StagedUploadPanel onCommitted={handleCommitted} />

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
            </div>
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
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
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
          {imports.length === 0 && <div className="text-center p-8 text-sm text-muted-foreground border rounded-lg border-dashed">No imports uploaded yet.</div>}
        </div>
      </div>
    </div>
  );
}

function mt3(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

function pct1(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(1)}%`;
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

function OrderReconciliationContent() {
  const { data: order, isLoading } = useGetOrderStatus({
    query: { queryKey: getGetOrderStatusQueryKey() },
  });

  const recon = order?.reconciliation;
  const rows = recon?.rows ?? [];

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
                    <span className="font-bold text-lg tabular-nums">{order.fileImport.asOnDate ?? "-"}</span>
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
                <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{recon?.matched ?? 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Mismatched</div>
                <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{recon?.mismatched ?? 0}</div>
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
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40">
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
        </>
      )}
    </div>
  );
}
