import { useMemo, useState } from "react";
import { useListImports, useGetImportRecords, useDeleteImport, useDeleteAllImports, useDeleteOrderImport, getListImportsQueryKey, getGetImportRecordsQueryKey, useGetOrderStatus, getGetOrderStatusQueryKey, useGetAccumulatedWip, type CommitResult, type DispatchReconciliationRow, type BalanceReconciliationRow } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useFgRows, type FgComputedRow } from "@/lib/fg";
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
  { path: "/computed-fg", label: "Computed FG" },
  { path: "/order-reconciliation", label: "Order Reconciliation" },
  { path: "/accumulated-wip", label: "Accumulated" },
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
      {active === "/computed-fg" ? (
        <ComputedFgContent />
      ) : active === "/order-reconciliation" ? (
        <OrderReconciliationContent />
      ) : active === "/accumulated-wip" ? (
        <AccumulatedWipContent />
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
  const { data: orderStatus } = useGetOrderStatus({ query: { queryKey: getGetOrderStatusQueryKey() } });
  const orderImports = orderStatus?.imports ?? [];

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
  const { selectedImportId, setSelectedImportId } = useTracker();
  const deleteImport = useDeleteImport();
  const deleteAll = useDeleteAllImports();
  const deleteOrderImport = useDeleteOrderImport();
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
      }
    });
  };

  const handleDeleteOrder = (id: number) => {
    if (!confirm("Delete this Order Review file from the history? The current order book is a merge of all uploads, so deleting one history entry does not change the current numbers. Deleting the last remaining entry clears the order book entirely.")) return;
    deleteOrderImport.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Order Review file deleted" });
        queryClient.invalidateQueries({ queryKey: getGetOrderStatusQueryKey() });
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
        <LogoutButton />
      </div>
      <div className="bg-primary/10 border border-primary/20 rounded-md p-4 flex gap-4 text-sm items-start">
        <div className="text-primary mt-0.5 font-bold">i</div>
        <p className="text-primary-foreground/90 font-medium">
          Every upload is added as a new import. Rows are kept as-is (in-sheet duplicates included) and deduplicated only across uploads. Ageing is computed live (today − Last Production Entry Date).
        </p>
      </div>

      <CutoffCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <StagedUploadPanel expectedType="wip" onCommitted={handleCommitted} />
        <StagedUploadPanel
          expectedType="order-review"
          onCommitted={handleCommitted}
          locked={orderReviewLocked}
          lockedMessage={orderReviewLockedMessage}
          allowedDates={wipAsOnDates}
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
                      <span>{new Date(o.createdAt).toLocaleDateString()}</span>
                      {o.asOnDate && <span>as on {o.asOnDate}</span>}
                      <span>{o.summary.rowsKept.toLocaleString()} rows</span>
                      {o.changeLog && (
                        <>
                          <span className="text-emerald-600 dark:text-emerald-400">+{o.changeLog.inserted.length.toLocaleString()} added</span>
                          <span>{o.changeLog.updated.length.toLocaleString()} updated</span>
                          <span>{o.changeLog.unchanged.toLocaleString()} unchanged</span>
                        </>
                      )}
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

function AccumulatedWipContent() {
  const { data, isLoading } = useGetAccumulatedWip();
  const byProject = useMemo(() => data?.byProject ?? [], [data]);

  const handleExport = () => {
    exportToXlsx(
      "accumulated-wip.xlsx",
      [
        { label: "Project", field: "project" },
        { label: "Fabrication WIP Accumulated (MT)", field: "fabricationMt", numeric: true, decimals: 3, total: true },
        { label: "Galvanizing WIP Accumulated (MT)", field: "galvanizingMt", numeric: true, decimals: 3, total: true },
      ],
      byProject,
      { sheetName: "Accumulated WIP" },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Accumulated</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Two lifetime throughput totals, replayed from the full WIP import
            history: Fabrication WIP Accumulated (tonnage added each time a
            mark left TS into G, TLT projects only) and Galvanizing WIP
            Accumulated (tonnage added each time a mark left Y / was
            dispatched). A mark that re-enters and crosses the same boundary
            again later is counted again.
          </p>
        </div>
        {byProject.length > 0 && (
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
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Fabrication WIP Accumulated</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums">
                  {mt3(data?.overall.fabricationMt)} MT
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Galvanizing WIP Accumulated</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums">
                  {mt3(data?.overall.galvanizingMt)} MT
                </div>
              </CardContent>
            </Card>
          </div>

          {byProject.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground text-sm">
                No accumulated WIP yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By project</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-auto max-h-[70vh]">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted sticky top-0 z-10">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-semibold">Project</th>
                        <th className="px-3 py-2 font-semibold text-right">
                          Fabrication WIP Accumulated (MT)
                        </th>
                        <th className="px-3 py-2 font-semibold text-right">
                          Galvanizing WIP Accumulated (MT)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProject.map((r) => (
                        <tr key={r.project} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2">{r.project}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{mt3(r.fabricationMt)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{mt3(r.galvanizingMt)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 bg-muted font-semibold sticky bottom-0 z-10">
                      <tr>
                        <td className="px-3 py-2">Grand total ({byProject.length})</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(data?.overall.fabricationMt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(data?.overall.galvanizingMt)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
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
  | "computedFgWipMt";

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
            computedFgWipMt: acc.computedFgWipMt + (r.computedFgWipMt ?? 0),
          }),
          { releaseMt: 0, fileDespatchMt: 0, computedFgMt: 0, computedFgWipMt: 0 },
        );
        return { project, list: sorted, subtotal };
      });
  }, [rows, sortKey, sortDir]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          releaseMt: acc.releaseMt + (r.releaseMt ?? 0),
          fileDespatchMt: acc.fileDespatchMt + (r.fileDespatchMt ?? 0),
          computedFgMt: acc.computedFgMt + (r.computedFgMt ?? 0),
          computedFgWipMt: acc.computedFgWipMt + (r.computedFgWipMt ?? 0),
        }),
        { releaseMt: 0, fileDespatchMt: 0, computedFgMt: 0, computedFgWipMt: 0 },
      ),
    [rows],
  );

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
        { label: "Finished Good Overview Computed (MT)", field: "computedFgMt", numeric: true, decimals: 3, total: true },
        { label: "Finished Good WIP Computed (MT)", field: "computedFgWipMt", numeric: true, decimals: 3, total: true },
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
            Two finished-goods figures per structure, sourced from the latest
            Order Review file and, for the WIP figure, the selected WIP report:
            Finished Good Overview Computed (file Galvanising minus file
            Dispatch) and Finished Good WIP Computed (live WIP Galvanizing
            minus file Dispatch).
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
              Structures{asOnDate ? ` — file as on ${asOnDate}` : ""}
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
                      Finished Good Overview Computed (MT){sortArrow("computedFgMt")}
                    </th>
                    <th className="px-3 py-2 font-semibold text-right cursor-pointer select-none" onClick={() => toggleSort("computedFgWipMt")}>
                      Finished Good WIP Computed (MT){sortArrow("computedFgWipMt")}
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
                        <td className="px-3 py-2 text-right tabular-nums">{mt3(r.computedFgWipMt)}</td>
                      </tr>
                    ))}
                    <tr className="bg-muted/20 text-xs font-medium">
                      <td className="px-3 py-1.5 text-muted-foreground" colSpan={2}>
                        {g.project || "(Unassigned)"} subtotal ({g.list.length})
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.releaseMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.fileDespatchMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.computedFgMt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{mt3(g.subtotal.computedFgWipMt)}</td>
                    </tr>
                  </tbody>
                ))}
                <tfoot className="border-t-2 bg-muted font-semibold sticky bottom-0 z-10">
                  <tr>
                    <td className="px-3 py-2" colSpan={2}>Grand total ({rows.length})</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.releaseMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.fileDespatchMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.computedFgMt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{mt3(totals.computedFgWipMt)}</td>
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
                    <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{order.balanceReconciliation.releaseMatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Release Mismatched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{order.balanceReconciliation.releaseMismatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Dispatch Matched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-emerald-600 dark:text-emerald-400">{order.balanceReconciliation.dispatchMatched}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Dispatch Mismatched</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">{order.balanceReconciliation.dispatchMismatched}</div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-0">
                  {order.balanceReconciliation.rows.length === 0 ? (
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
                          {order.balanceReconciliation.rows.map((r: BalanceReconciliationRow) => {
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
