import { useMemo, useState } from "react";
import {
  useListRsjThickness,
  useUpsertRsjThickness,
  useDeleteRsjThickness,
  useListManualThickness,
  useUpsertManualThickness,
  useDeleteManualThickness,
  useGetImportRecords,
  getListRsjThicknessQueryKey,
  getListManualThicknessQueryKey,
  getGetImportRecordsQueryKey,
  type Record as TrackerRecord,
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
import { Input } from "@/components/ui/input";
import { Layers, Trash2, Check } from "lucide-react";

const SOURCE_LABEL: Record<string, string> = {
  tlt_angle: "Angle (section)",
  tlt_plate: "Plate (section)",
  rsj_lookup: "RSJ lookup",
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

function ThicknessContent() {
  const { selectedImportId } = useTracker();
  const queryClient = useQueryClient();

  const { data: rsjRows } = useListRsjThickness({
    query: { queryKey: getListRsjThicknessQueryKey() },
  });
  const { data: manualRows } = useListManualThickness({
    query: { queryKey: getListManualThicknessQueryKey() },
  });
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });
  const records = useFilteredRecords(allRecords);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListRsjThicknessQueryKey() });
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
            RSJ uses the lookup table below; General is entered manually. Nothing
            here changes quantities, activity, or ageing.
          </p>
        </div>
        <LogoutButton />
      </div>

      <RsjThicknessCard
        rsjRows={rsjRows ?? []}
        records={records}
        onChanged={invalidateAll}
      />

      <UnsetWorklistCard
        records={records}
        manualRows={manualRows ?? []}
        hasImport={!!selectedImportId}
        onChanged={invalidateAll}
      />
    </div>
  );
}

function RsjThicknessCard({
  rsjRows,
  records,
  onChanged,
}: {
  rsjRows: { groupKey: string; thicknessMm: number }[];
  records: TrackerRecord[];
  onChanged: () => void;
}) {
  const upsert = useUpsertRsjThickness();
  const del = useDeleteRsjThickness();
  const [newKey, setNewKey] = useState("");
  const [newMm, setNewMm] = useState<number | null>(null);

  const known = useMemo(
    () => new Set(rsjRows.map((r) => r.groupKey)),
    [rsjRows],
  );

  // RSJ group keys present in the data but not yet configured.
  const missingKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of records) {
      if (r.ntltSubtype === "RSJ" && r.groupKey && !known.has(r.groupKey)) {
        keys.add(r.groupKey);
      }
    }
    return Array.from(keys).sort();
  }, [records, known]);

  const save = (groupKey: string, thicknessMm: number) => {
    if (!groupKey.trim() || !(thicknessMm > 0)) return;
    upsert.mutate(
      { data: { groupKey: groupKey.trim().toUpperCase(), thicknessMm } },
      { onSuccess: onChanged },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">RSJ Types &amp; Thickness</CardTitle>
        <p className="text-sm text-muted-foreground">
          Maps each cleaned &quot;RSJ &lt;dims&gt;&quot; section type to a
          thickness. RSJ marks auto-fill from this table (never derived from the
          section dimensions).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              RSJ type (group key)
            </label>
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="RSJ 150X150"
              className="w-56"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              Thickness (mm)
            </label>
            <NumberInput
              value={newMm ?? ""}
              onValueChange={(raw) => setNewMm(raw === "" ? null : Number(raw))}
              className="w-32"
              min={0}
            />
          </div>
          <Button
            onClick={() => {
              if (newKey.trim() && newMm && newMm > 0) {
                save(newKey, newMm);
                setNewKey("");
                setNewMm(null);
              }
            }}
            disabled={!newKey.trim() || !newMm || newMm <= 0 || upsert.isPending}
          >
            Add / update
          </Button>
        </div>

        {missingKeys.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="text-sm font-medium mb-2">
              {missingKeys.length} RSJ type
              {missingKeys.length === 1 ? "" : "s"} in the current data have no
              thickness yet
            </div>
            <div className="flex flex-wrap gap-2">
              {missingKeys.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setNewKey(k)}
                  className="rounded bg-secondary px-2 py-1 text-xs font-mono hover:bg-secondary/70"
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}

        {rsjRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No RSJ types configured yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>RSJ type</TableHead>
                <TableHead className="text-right">Thickness (mm)</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rsjRows.map((r) => (
                <RsjRow
                  key={r.groupKey}
                  row={r}
                  onSave={save}
                  onDelete={() =>
                    del.mutate(
                      { params: { groupKey: r.groupKey } },
                      { onSuccess: onChanged },
                    )
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RsjRow({
  row,
  onSave,
  onDelete,
}: {
  row: { groupKey: string; thicknessMm: number };
  onSave: (groupKey: string, mm: number) => void;
  onDelete: () => void;
}) {
  const [mm, setMm] = useState<number | null>(row.thicknessMm);
  const dirty = mm !== row.thicknessMm && mm != null && mm > 0;
  return (
    <TableRow>
      <TableCell className="font-mono">{row.groupKey}</TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <NumberInput
            value={mm ?? ""}
            onValueChange={(raw) => setMm(raw === "" ? null : Number(raw))}
            className="w-28"
            min={0}
          />
          {dirty && (
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => mm != null && onSave(row.groupKey, mm)}
            >
              <Check className="w-4 h-4" />
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </TableCell>
    </TableRow>
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
          have no thickness ({counts.rsj} RSJ &middot; {counts.general} General
          &middot; {counts.other} other). RSJ resolves once its type is added
          above; General and anything unparseable can be pinned manually here.
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
