import { useMemo, useState } from "react";
import {
  useListManualThickness,
  useUpsertManualThickness,
  useDeleteManualThickness,
  useGetImportRecords,
  useListItemMasterThicknessRows,
  getListManualThicknessQueryKey,
  getGetImportRecordsQueryKey,
  getListItemMasterThicknessRowsQueryKey,
  type Record as TrackerRecord,
  type ItemMasterThicknessGroup,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Layers, Trash2, Check, ChevronDown, ChevronRight, BookOpen, Download } from "lucide-react";
// Note: Trash2 and Check are still used in UnsetWorklistCard; useMemo used in ManualRow.

const SOURCE_LABEL: Record<string, string> = {
  tlt_angle: "Angle (section)",
  tlt_plate: "Plate (section)",
  rsj_exact: "RSJ exact",
  rsj_base: "RSJ base match",
  rsj_default: "RSJ default 6.0",
  master: "Item master",
  manual: "Manual",
  unset: "Not set",
};

function sourceTag(source: string | null | undefined) {
  const label = SOURCE_LABEL[source ?? "unset"] ?? "Not set";
  const isUnset = (source ?? "unset") === "unset";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
        isUnset
          ? "bg-destructive/10 text-destructive"
          : "bg-secondary text-secondary-foreground"
      }`}
    >
      {label}
    </span>
  );
}

export default function ThicknessView() {
  return (
    <LoginGate>
      <ThicknessContent />
    </LoginGate>
  );
}

export function ThicknessContent() {
  const { selectedImportId } = useTracker();
  const queryClient = useQueryClient();

  const { data: manualRows } = useListManualThickness({
    query: { queryKey: getListManualThicknessQueryKey() },
  });
  const { data: masterGroups } = useListItemMasterThicknessRows({
    query: { queryKey: getListItemMasterThicknessRowsQueryKey() },
  });
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });
  const records = useFilteredRecords(allRecords);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListManualThicknessQueryKey() });
    if (selectedImportId) {
      queryClient.invalidateQueries({
        queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
      });
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="w-6 h-6 text-primary" /> Thickness
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Galvanizing thickness (mm). TLT and Earthing derive from the section;
            General is entered manually. Nothing here changes quantities, activity,
            or ageing.
          </p>
        </div>
        <LogoutButton />
      </div>

      <ItemMasterThicknessCard groups={masterGroups ?? []} />

      <UnsetWorklistCard
        records={records}
        manualRows={manualRows ?? []}
        hasImport={!!selectedImportId}
        onChanged={invalidateAll}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Master — read-only, collapsible by group, with CSV export
// ---------------------------------------------------------------------------
function exportItemMasterCsv(groups: ItemMasterThicknessGroup[]) {
  const lines = ["Category,Item Name,Item Code,Thickness (mm)"];
  for (const g of groups) {
    for (const item of g.items) {
      const cat = `"${g.groupName.replace(/"/g, '""')}"`;
      const name = `"${item.itemName.replace(/"/g, '""')}"`;
      const code = `"${(item.itemCode ?? "").replace(/"/g, '""')}"`;
      lines.push(`${cat},${name},${code},${item.thicknessMm}`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "item_master_thickness.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function ItemMasterThicknessCard({ groups }: { groups: ItemMasterThicknessGroup[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const totalRows = groups.reduce((s, g) => s + g.items.length, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              Item Master Thickness Reference
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {totalRows > 0
                ? `${totalRows} entries across ${groups.length} categories from the VTPL item master. Read-only — re-upload via the Data tab to update.`
                : "No item master loaded. Upload the VTPL item master XLS on the Data tab."}
            </p>
          </div>
          {groups.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => exportItemMasterCsv(groups)}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export CSV
            </Button>
          )}
        </div>
      </CardHeader>
      {groups.length > 0 && (
        <CardContent className="space-y-1 pt-0">
          {groups.map((g) => {
            const isOpen = open.has(g.groupName);
            return (
              <div key={g.groupName} className="rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggle(g.groupName)}
                  className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/60 transition-colors text-left"
                >
                  <span className="font-medium text-sm">{g.groupName}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
                    {isOpen
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </button>
                {isOpen && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Item name</TableHead>
                        <TableHead className="text-right pr-4 w-36">Thickness (mm)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.items.map((item) => (
                        <TableRow key={item.itemCode}>
                          <TableCell className="font-mono text-sm pl-4">{item.itemName}</TableCell>
                          <TableCell className="text-right pr-4 tabular-nums">{item.thicknessMm}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}

function UnsetWorklistCard({
  records,
  manualRows,
  hasImport,
  onChanged,
}: {
  records: TrackerRecord[];
  manualRows: { markId: string; thicknessMm: number }[];
  hasImport: boolean;
  onChanged: () => void;
}) {
  const upsert = useUpsertManualThickness();
  const del = useDeleteManualThickness();

  const manualByMark = useMemo(
    () => new Map(manualRows.map((m) => [m.markId, m.thicknessMm])),
    [manualRows],
  );

  // One row per distinct mark identity still without a thickness.
  const unset = useMemo(() => {
    const seen = new Map<string, TrackerRecord>();
    for (const r of records) {
      if ((r.thicknessSource ?? "unset") !== "unset") continue;
      if (!seen.has(r.markId)) seen.set(r.markId, r);
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.markId.localeCompare(b.markId),
    );
  }, [records]);

  const counts = useMemo(() => {
    let rsj = 0;
    let general = 0;
    let other = 0;
    for (const r of unset) {
      if (r.ntltSubtype === "RSJ") rsj++;
      else if (r.ntltSubtype === "GENERAL") general++;
      else other++;
    }
    return { rsj, general, other, total: unset.length };
  }, [unset]);

  if (!hasImport) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Thickness not set</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Select an import on the Data page to see unset-thickness marks.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Thickness not set</CardTitle>
        <p className="text-sm text-muted-foreground">
          {counts.total} mark{counts.total === 1 ? "" : "s"} in the current view
          have no thickness ({counts.general} General &middot; {counts.other}{" "}
          other). RSJ marks always resolve (exact, base match, or the 6.0
          default); General and anything unparseable can be pinned manually here.
        </p>
      </CardHeader>
      <CardContent>
        {unset.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every mark in the current view has a resolved thickness.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mark</TableHead>
                  <TableHead>Job / Section</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Manual mm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unset.slice(0, 300).map((r) => (
                  <UnsetRow
                    key={r.markId}
                    row={r}
                    pinned={manualByMark.get(r.markId) ?? null}
                    onSave={(mm) =>
                      upsert.mutate(
                        { data: { markId: r.markId, thicknessMm: mm } },
                        { onSuccess: onChanged },
                      )
                    }
                    onClear={() =>
                      del.mutate(
                        { params: { markId: r.markId } },
                        { onSuccess: onChanged },
                      )
                    }
                  />
                ))}
              </TableBody>
            </Table>
            {unset.length > 300 && (
              <p className="p-3 text-center text-xs text-muted-foreground">
                Showing first 300 of {unset.length.toLocaleString()}. Use the
                filters to narrow down.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UnsetRow({
  row,
  pinned,
  onSave,
  onClear,
}: {
  row: TrackerRecord;
  pinned: number | null;
  onSave: (mm: number) => void;
  onClear: () => void;
}) {
  const [mm, setMm] = useState<number | null>(pinned);
  const typeLabel =
    row.ntltSubtype ?? ((row.category || "TLT") === "TLT" ? "TLT" : "Unknown");
  return (
    <TableRow>
      <TableCell className="font-mono whitespace-nowrap">{row.markId}</TableCell>
      <TableCell className="max-w-[220px] truncate text-muted-foreground">
        {row.job || "(Unassigned)"}
        {row.section ? ` / ${row.section}` : ""}
      </TableCell>
      <TableCell>{sourceTag(row.thicknessSource)} {typeLabel}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <NumberInput
            value={mm ?? ""}
            onValueChange={(raw) => setMm(raw === "" ? null : Number(raw))}
            className="w-28"
            min={0}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!mm || mm <= 0}
            onClick={() => mm != null && mm > 0 && onSave(mm)}
          >
            Save
          </Button>
          {pinned != null && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-destructive"
              onClick={() => {
                setMm(null);
                onClear();
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
