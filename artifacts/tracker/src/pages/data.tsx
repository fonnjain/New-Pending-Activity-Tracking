import { useListSnapshots, useUploadSnapshot, useGetSnapshotRecords, useDeleteSnapshot, getListSnapshotsQueryKey, getGetSnapshotRecordsQueryKey } from "@workspace/api-client-react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileDown, CheckCircle2, Trash2, DownloadCloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToCsv, exportToJson } from "@/lib/export";
import { useQueryClient } from "@tanstack/react-query";

export default function DataView() {
  const { data: snapshots = [], refetch } = useListSnapshots();
  const { selectedSnapshotId, setSelectedSnapshotId } = useTracker();
  const upload = useUploadSnapshot();
  const deleteSnap = useDeleteSnapshot();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: allRecords } = useGetSnapshotRecords(selectedSnapshotId as number, {
    query: { enabled: !!selectedSnapshotId, queryKey: getGetSnapshotRecordsQueryKey(selectedSnapshotId as number) }
  });
  const filteredRecords = useFilteredRecords(allRecords);

  const selectedSnapshot = snapshots.find(s => s.id === selectedSnapshotId);
  
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    upload.mutate({ data: { file } }, {
      onSuccess: (res) => {
        toast({ title: "Upload complete", description: `Processed ${res.snapshot.summary.rowsRead} rows.` });
        refetch();
        setSelectedSnapshotId(res.snapshot.id);
        queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Upload failed", description: err?.data?.error || err?.message || "Unknown error" });
      }
    });
  };

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this snapshot?")) return;
    deleteSnap.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Snapshot deleted" });
        refetch();
        if (selectedSnapshotId === id) setSelectedSnapshotId(null);
        queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
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
    exportToJson(`snapshot_${selectedSnapshotId}.json`, { snapshot: selectedSnapshot, records: allRecords });
  };

  return (
    <div className="space-y-6">
      <div className="bg-primary/10 border border-primary/20 rounded-md p-4 flex gap-4 text-sm items-start">
        <div className="text-primary mt-0.5 font-bold">i</div>
        <p className="text-primary-foreground/90 font-medium">
          Activity, balances and routes come straight from the source file. Ageing is computed live (today − Assign Date).
        </p>
      </div>

      <Card className="border-dashed border-2 bg-muted/10">
        <CardContent className="flex flex-col items-center justify-center p-12 text-center">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-4">
            <Upload className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold mb-2">Upload Report</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Upload an Excel (.xlsx) balance/activity report. Re-uploading with the same date/label replaces the existing one.
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

      {selectedSnapshot && (
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
                <span className="font-bold text-lg tabular-nums">{selectedSnapshot.summary.rowsRead.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Deduplicated Marks</span>
                <span className="font-bold text-lg tabular-nums text-primary">{selectedSnapshot.summary.marksAfterDedupe.toLocaleString()}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Projects Found</span>
                <span className="font-bold text-lg tabular-nums">{selectedSnapshot.summary.projectsFound}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Missing Contractor</span>
                <span className="font-bold text-lg tabular-nums">{selectedSnapshot.summary.missingContractor}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Missing Date</span>
                <span className="font-bold text-lg tabular-nums">{selectedSnapshot.summary.missingDate}</span>
              </div>
              <div>
                <span className="block text-muted-foreground text-xs uppercase mb-1">Duplicates Collapsed</span>
                <span className="font-bold text-lg tabular-nums">{selectedSnapshot.summary.duplicateMarksCollapsed}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Available Snapshots</h3>
        <div className="grid gap-3">
          {snapshots.map(s => (
            <Card 
              key={s.id} 
              className={`transition-all ${selectedSnapshotId === s.id ? 'border-primary ring-1 ring-primary shadow-md' : 'hover:border-primary/50'}`}
            >
              <CardContent className="p-4 flex items-center justify-between">
                <div 
                  className="flex-1 cursor-pointer flex flex-col gap-1"
                  onClick={() => setSelectedSnapshotId(s.id)}
                >
                  <div className="font-bold flex items-center gap-2">
                    {s.label || s.sourceFilename}
                    {selectedSnapshotId === s.id && <CheckCircle2 className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="text-xs text-muted-foreground flex gap-3">
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    <span>{s.summary.marksAfterDedupe.toLocaleString()} marks</span>
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
          {snapshots.length === 0 && <div className="text-center p-8 text-sm text-muted-foreground border rounded-lg border-dashed">No snapshots uploaded yet.</div>}
        </div>
      </div>
    </div>
  );
}
