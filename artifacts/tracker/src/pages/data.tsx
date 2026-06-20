import { useListImports, useUploadImport, useGetImportRecords, useDeleteImport, getListImportsQueryKey, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileDown, CheckCircle2, Trash2, DownloadCloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToCsv, exportToJson } from "@/lib/export";
import { useQueryClient } from "@tanstack/react-query";

export default function DataView() {
  const { data: imports = [], refetch } = useListImports();
  const { selectedImportId, setSelectedImportId } = useTracker();
  const upload = useUploadImport();
  const deleteImport = useDeleteImport();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const filteredRecords = useFilteredRecords(allRecords);

  const selectedImport = imports.find(s => s.id === selectedImportId);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    upload.mutate({ data: { file } }, {
      onSuccess: (res) => {
        const c = res.changeSet.counts;
        toast({
          title: "Import added",
          description: `${res.import.summary.rowsKept.toLocaleString()} rows kept. ${c.addedRows.toLocaleString()} new, ${c.completed.toLocaleString()} completed since the last upload.`,
        });
        refetch();
        setSelectedImportId(res.import.id);
        queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Upload failed", description: err?.data?.error || err?.message || "Unknown error" });
      }
    });
    // allow re-selecting the same file
    e.target.value = "";
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

  const doExportCsv = () => {
    if (!filteredRecords?.length) {
      toast({ variant: "destructive", title: "No data to export" });
      return;
    }
    exportToCsv(`tracker_export_${new Date().toISOString().slice(0,10)}.csv`, filteredRecords);
  };

  const doExportJson = () => {
    if (!allRecords?.length) {
      toast({ variant: "destructive", title: "No data to export" });
      return;
    }
    exportToJson(`import_${selectedImportId}.json`, { import: selectedImport, records: allRecords });
  };

  return (
    <div className="space-y-6">
      <div className="bg-primary/10 border border-primary/20 rounded-md p-4 flex gap-4 text-sm items-start">
        <div className="text-primary mt-0.5 font-bold">i</div>
        <p className="text-primary-foreground/90 font-medium">
          Every upload is added as a new import. Rows are kept as-is (in-sheet duplicates included) and deduplicated only across uploads. Ageing is computed live (today − Assign Date).
        </p>
      </div>

      <Card className="border-dashed border-2 bg-muted/10">
        <CardContent className="flex flex-col items-center justify-center p-12 text-center">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-4">
            <Upload className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold mb-2">Upload Report</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Upload an Excel (.xlsx) balance/activity report. It is appended as a new import and compared against the previous one. Re-uploading the same file is safe and registers zero changes.
          </p>
          <div className="relative">
            <input
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              disabled={upload.isPending}
            />
            <Button disabled={upload.isPending} className="px-8 font-bold text-primary-foreground">
              {upload.isPending ? "UPLOADING..." : "SELECT FILE"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {selectedImport && (
        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
              Current Parse Summary
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={doExportCsv} className="h-8 gap-2">
                  <DownloadCloud className="w-4 h-4" /> CSV (Filtered)
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
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Import History</h3>
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
