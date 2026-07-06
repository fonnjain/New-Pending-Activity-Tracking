import { useEffect, useMemo, useState } from "react";
import { useTracker, useCurrentJobsSet, CURRENT_JOBS_FILTER_VALUE } from "@/lib/store";
import {
  useGetAuthStatus,
  useListInventoryManualA,
  useListInventoryManualE,
  useUpsertInventoryManualA,
  useDeleteInventoryManualA,
  useUpsertInventoryManualE,
  useDeleteInventoryManualE,
  getListInventoryManualAQueryKey,
  getListInventoryManualEQueryKey,
  type InventoryManualEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useInventoryData,
  BUCKET_LABELS,
  releaseBalanceDisplay,
  fabPlusGalva,
  sumColumnOrNull,
  aggregateProjectColumns,
  computeBucketSummary,
  computeManualESummary,
  type InventoryStructureCard,
  type InventorySide,
  type BucketSummary,
} from "@/lib/inventory";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { Boxes, ChevronRight, ChevronDown, Trash2, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet, type XlsxSummaryRow } from "@/lib/export";

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

const SIDE_LABELS: Record<InventorySide, string> = {
  in_house: "In-House",
  out_vendor: "Out-Vendor",
};

interface ProjectGroup {
  project: string;
  rows: InventoryStructureCard[];
  count: number;
  weightMt: number;
}

function groupByProject(rows: InventoryStructureCard[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const r of rows) {
    let g = map.get(r.project);
    if (!g) {
      g = { project: r.project, rows: [], count: 0, weightMt: 0 };
      map.set(r.project, g);
    }
    g.rows.push(r);
    g.count += 1;
    g.weightMt += r.weightMt ?? 0;
  }
  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

// Per-bucket data column definitions (spec-mandated). B shows the raw Release
// Balance (always > 0 there) + a combined Fab+Galva; C/D show the CLAMPED
// Release Balance (display-only; never affects bucket membership) + Fab and
// Galva as separate columns. Yard (Progress Galvanising, Col N) is on every
// auto bucket.
interface ColumnDef {
  key: string;
  label: string;
  get: (r: InventoryStructureCard) => number | null;
}

const YARD_COLUMN: ColumnDef = { key: "yard", label: "Yard", get: (r) => r.galvMt };

const BUCKET_B_COLUMNS: ColumnDef[] = [
  {
    key: "release",
    label: "Rel. Bal.",
    get: (r) => releaseBalanceDisplay(r.fileBalReleaseMt, false),
  },
  { key: "fabGalva", label: "Fab+Galva", get: (r) => fabPlusGalva(r.balFabMt, r.balGalvMt) },
  YARD_COLUMN,
];

const BUCKET_CD_COLUMNS: ColumnDef[] = [
  {
    key: "release",
    label: "Rel. Bal.",
    get: (r) => releaseBalanceDisplay(r.fileBalReleaseMt, true),
  },
  { key: "fab", label: "Fab", get: (r) => r.balFabMt },
  { key: "galva", label: "Galva", get: (r) => r.balGalvMt },
  YARD_COLUMN,
];

// Five-line footer shown on every side of Buckets B/C/D/E (spec-mandated).
// Total Release Balance, Under Production (Fab+Galva), Total Yard, Operation
// Weight (Under Production + Yard), Grand Total (Release Balance + Operation).
// Shown PER SIDE (not combined) because mixed structures legitimately appear
// on both sides, so a naive combined total would double-count them.
function SummaryFooter({ summary }: { summary: BucketSummary }) {
  const lines: [string, number][] = [
    ["Total Release Balance", summary.releaseBalanceMt],
    ["Under Production", summary.underProductionMt],
    ["Total Yard", summary.yardMt],
    ["Operation Weight", summary.operationWeightMt],
    ["Grand Total Weight", summary.grandTotalMt],
  ];
  return (
    <div className="px-3 py-2 border-t bg-muted/20 space-y-0.5">
      {lines.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums font-medium">{mt(value)} MT</span>
        </div>
      ))}
    </div>
  );
}

function AutoBucketSide({
  side,
  rows,
  columns,
  clampRelease,
}: {
  side: InventorySide;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  clampRelease: boolean;
}) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const totalWeight = groups.reduce((s, g) => s + g.weightMt, 0);
  const totalCount = groups.reduce((s, g) => s + g.count, 0);
  const summary = useMemo(() => computeBucketSummary(rows, clampRelease), [rows, clampRelease]);

  return (
    <div className="border rounded-md">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">
          {SIDE_LABELS[side]}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalCount} structure{totalCount === 1 ? "" : "s"} · {mt(totalWeight)} MT
        </span>
      </div>
      <div className="max-h-96 overflow-auto divide-y">
        {groups.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No structures.
          </div>
        ) : (
          groups.map((g) => (
            <ProjectRow key={g.project} group={g} columns={columns} />
          ))
        )}
      </div>
      <SummaryFooter summary={summary} />
    </div>
  );
}

function ProjectRow({
  group,
  columns,
}: {
  group: ProjectGroup;
  columns: ColumnDef[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-muted/30 gap-2"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="font-medium truncate">{group.project}</span>
          <span className="text-[10px] uppercase text-muted-foreground shrink-0">
            {group.count}
          </span>
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {columns.map((col) => (
            <span key={col.key} className="text-[11px] tabular-nums text-right">
              <span className="text-muted-foreground mr-1">{col.label}</span>
              {mt(sumColumnOrNull(group.rows, col.get))}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="pl-6 pb-1">
          {group.rows.map((r) => (
            <div
              key={`${r.project}-${r.structure}`}
              className="flex items-center justify-between gap-2 px-2 py-1 text-xs border-t first:border-t-0"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate">{r.structure ?? "-"}</span>
                {r.subType && (
                  <span className="text-muted-foreground shrink-0">({r.subType})</span>
                )}
                {r.mixed && (
                  <span className="text-amber-600 dark:text-amber-400 shrink-0">(mixed)</span>
                )}
                {r.notInLatest && (
                  <span className="text-rose-600 dark:text-rose-400 shrink-0">not in latest</span>
                )}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                {columns.map((col) => (
                  <span key={col.key} className="tabular-nums text-right">
                    <span className="text-muted-foreground mr-1">{col.label}</span>
                    {mt(col.get(r))}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Bucket E aggregates the same Release Balance / Fab+Galva / Yard data
// columns as C/D, but rolled up per-project across ALL of the project's
// structures in the latest Order Review (rawRows), not per manual entry.
function ManualEntryList({
  entries,
  onDelete,
  canEdit,
  deletingId,
  rawRows,
  showWeight,
}: {
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
  showWeight?: boolean;
}) {
  if (entries.length === 0) {
    return <div className="py-4 text-center text-xs text-muted-foreground">No entries.</div>;
  }
  return (
    <div className="divide-y">
      {entries.map((e) => {
        const agg = rawRows ? aggregateProjectColumns(rawRows, e.projectCode) : null;
        return (
          <div key={e.id} className="flex flex-col gap-1 px-3 py-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="truncate">{e.projectCode}</span>
              <div className="flex items-center gap-2 shrink-0">
                {showWeight && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {mt(e.woOrderQtyMt)} MT
                  </span>
                )}
                {e.note && <span className="text-xs text-muted-foreground">{e.note}</span>}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={deletingId === e.id}
                    onClick={() => onDelete(e.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
            {agg && (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
                <span>
                  Rel. Bal. <span className="text-foreground">{mt(agg.releaseBalanceMt)}</span>
                </span>
                <span>
                  Fab+Galva <span className="text-foreground">{mt(agg.fabGalvaMt)}</span>
                </span>
                <span>
                  Yard <span className="text-foreground">{mt(agg.yardMt)}</span>
                </span>
                <span>({agg.structureCount} structures)</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ManualBucketSide({
  side,
  entries,
  onDelete,
  canEdit,
  deletingId,
  rawRows,
  showWeight,
  summary,
}: {
  side: InventorySide;
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
  showWeight?: boolean;
  summary?: BucketSummary;
}) {
  const filtered = entries.filter((e) => e.side === side);
  return (
    <div className="border rounded-md">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">
          {SIDE_LABELS[side]}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {filtered.length} project{filtered.length === 1 ? "" : "s"}
        </span>
      </div>
      <ManualEntryList
        entries={filtered}
        onDelete={onDelete}
        canEdit={canEdit}
        deletingId={deletingId}
        rawRows={rawRows}
        showWeight={showWeight}
      />
      {summary && <SummaryFooter summary={summary} />}
    </div>
  );
}

function ProjectCheckboxFilter({
  projects,
  selected,
  onChange,
}: {
  projects: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
}) {
  if (projects.length === 0) return null;

  const allSelected = selected === null;
  const selectedCount = allSelected ? projects.length : selected.size;

  const toggle = (project: string) => {
    const current = allSelected ? new Set(projects) : new Set(selected);
    if (current.has(project)) current.delete(project);
    else current.add(project);
    onChange(current.size === projects.length ? null : current);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">
            Projects{" "}
            <span className="text-muted-foreground font-normal">
              ({selectedCount}/{projects.length} selected)
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange(null)}
              disabled={allSelected}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange(new Set())}
              disabled={selectedCount === 0}
            >
              Clear all
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-4 gap-y-2 max-h-48 overflow-auto pr-1">
          {projects.map((p) => {
            const checked = allSelected || selected.has(p);
            return (
              <label
                key={p}
                className="flex items-center gap-1.5 text-sm cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary shrink-0"
                  checked={checked}
                  onChange={() => toggle(p)}
                />
                <span className="truncate">{p}</span>
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ManualAddForm({
  mode,
  knownProjects,
  onAdd,
  isPending,
}: {
  mode: "a" | "e";
  knownProjects: string[];
  onAdd: (projectCode: string, side: InventorySide, woOrderQtyMt: number | null) => void;
  isPending: boolean;
}) {
  const [projectCode, setProjectCode] = useState("");
  const [side, setSide] = useState<InventorySide>("in_house");
  const [woOrderQtyMt, setWoOrderQtyMt] = useState<number | "">("");

  const submit = () => {
    const code = projectCode.trim();
    if (!code) return;
    if (mode === "a" && woOrderQtyMt === "") return;
    onAdd(code, side, mode === "a" ? (woOrderQtyMt as number) : null);
    setProjectCode("");
    setWoOrderQtyMt("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b">
      {mode === "a" ? (
        <>
          <Input
            placeholder="Project code"
            value={projectCode}
            onChange={(e) => setProjectCode(e.target.value)}
            className="h-8 w-40"
          />
          <NumberInput
            placeholder="WO Qty (MT)"
            value={woOrderQtyMt}
            onValueChange={(raw) => setWoOrderQtyMt(raw === "" ? "" : Number(raw))}
            className="h-8 w-28"
          />
        </>
      ) : (
        <div className="w-52">
          <SearchableSelect
            value={projectCode || null}
            onChange={(v) => setProjectCode(v ?? "")}
            options={knownProjects}
            allLabel="Select project..."
          />
        </div>
      )}
      <Segmented
        value={side}
        onChange={(v) => setSide(v as InventorySide)}
        options={[
          { value: "in_house", label: "In-House" },
          { value: "out_vendor", label: "Out-Vendor" },
        ]}
      />
      <Button
        size="sm"
        className="h-8"
        disabled={!projectCode.trim() || (mode === "a" && woOrderQtyMt === "") || isPending}
        onClick={submit}
      >
        Add
      </Button>
    </div>
  );
}

export default function InventoryView() {
  const { filters } = useTracker();
  const queryClient = useQueryClient();
  const { available, asOnDate, isLoading, rawRows, buckets, manualA, manualE } = useInventoryData();
  const { data: authStatus } = useGetAuthStatus();
  const canEdit = !!authStatus?.authenticated;

  const jobFilter = filters.job;
  const isCurrentJobs = jobFilter === CURRENT_JOBS_FILTER_VALUE;
  const { set: currentJobsSet, meta: currentJobsMeta } = useCurrentJobsSet();

  // Distinct projects present under the current Job filter (before the
  // project-checkbox refinement below). Drives the checkbox list so it
  // always reflects the active All/single-project/Current-Jobs scope.
  const jobScopedProjects = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) {
      if (isCurrentJobs) {
        if (currentJobsSet.has(r.project)) set.add(r.project);
      } else if (jobFilter) {
        if (r.project === jobFilter) set.add(r.project);
      } else {
        set.add(r.project);
      }
    }
    return Array.from(set).sort();
  }, [rawRows, jobFilter, isCurrentJobs, currentJobsSet]);

  // Further, user-controlled refinement on top of the Job filter. `null`
  // means "no refinement" (everything the Job filter allows is shown).
  const [selectedProjects, setSelectedProjects] = useState<Set<string> | null>(null);

  // Reset the refinement whenever the underlying Job-filter scope changes so
  // a stale per-project selection from a previous scope can't silently hide
  // data in the new one.
  useEffect(() => {
    setSelectedProjects(null);
  }, [jobFilter]);

  const matchesProjectSelection = (project: string): boolean =>
    selectedProjects === null || selectedProjects.has(project);

  const applyJobFilter = (rows: InventoryStructureCard[]): InventoryStructureCard[] => {
    let out = rows;
    if (isCurrentJobs) out = out.filter((r) => currentJobsSet.has(r.project));
    else if (jobFilter) out = out.filter((r) => r.project === jobFilter);
    return out.filter((r) => matchesProjectSelection(r.project));
  };

  const bInHouse = applyJobFilter(buckets.b.inHouse);
  const bOutVendor = applyJobFilter(buckets.b.outVendor);
  const cInHouse = applyJobFilter(buckets.c.inHouse);
  const cOutVendor = applyJobFilter(buckets.c.outVendor);
  const dInHouse = applyJobFilter(buckets.d.inHouse);
  const dOutVendor = applyJobFilter(buckets.d.outVendor);

  const knownProjects = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.project);
    return Array.from(set).sort();
  }, [rawRows]);

  const upsertA = useUpsertInventoryManualA();
  const deleteA = useDeleteInventoryManualA();
  const upsertE = useUpsertInventoryManualE();
  const deleteE = useDeleteInventoryManualE();
  const [deletingAId, setDeletingAId] = useState<number | null>(null);
  const [deletingEId, setDeletingEId] = useState<number | null>(null);

  const addA = (projectCode: string, side: InventorySide, woOrderQtyMt: number | null) => {
    upsertA.mutate(
      { data: { projectCode, side, woOrderQtyMt } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListInventoryManualAQueryKey() }) },
    );
  };
  const removeA = (id: number) => {
    setDeletingAId(id);
    deleteA.mutate(
      { params: { id } },
      {
        onSettled: () => {
          setDeletingAId(null);
          queryClient.invalidateQueries({ queryKey: getListInventoryManualAQueryKey() });
        },
      },
    );
  };
  const addE = (projectCode: string, side: InventorySide) => {
    upsertE.mutate(
      { data: { projectCode, side } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListInventoryManualEQueryKey() }) },
    );
  };
  const addESlot = (projectCode: string, side: InventorySide, _woOrderQtyMt: number | null) =>
    addE(projectCode, side);

  const manualAWeightSum = manualA.reduce((s, e) => s + (e.woOrderQtyMt ?? 0), 0);
  const manualEInHouseSummary = useMemo(
    () =>
      computeManualESummary(
        manualE
          .filter((e) => e.side === "in_house")
          .map((e) => aggregateProjectColumns(rawRows, e.projectCode)),
      ),
    [manualE, rawRows],
  );
  const manualEOutVendorSummary = useMemo(
    () =>
      computeManualESummary(
        manualE
          .filter((e) => e.side === "out_vendor")
          .map((e) => aggregateProjectColumns(rawRows, e.projectCode)),
      ),
    [manualE, rawRows],
  );
  const removeE = (id: number) => {
    setDeletingEId(id);
    deleteE.mutate(
      { params: { id } },
      {
        onSettled: () => {
          setDeletingEId(null);
          queryClient.invalidateQueries({ queryKey: getListInventoryManualEQueryKey() });
        },
      },
    );
  };

  // Export honours the current Job filter (applyJobFilter is already applied
  // to buckets B/C/D above); manual Buckets A/E are filtered the same way so
  // a filtered export never leaks other projects' manual entries.
  const applyJobFilterManual = (entries: InventoryManualEntry[]): InventoryManualEntry[] => {
    let out = entries;
    if (isCurrentJobs) out = out.filter((e) => currentJobsSet.has(e.projectCode));
    else if (jobFilter) out = out.filter((e) => e.projectCode === jobFilter);
    return out.filter((e) => matchesProjectSelection(e.projectCode));
  };

  const structureRows = (side: InventorySide, rows: InventoryStructureCard[], columns: ColumnDef[]) =>
    rows.map((r) => {
      const row: Record<string, string | number | null> = {
        side: SIDE_LABELS[side],
        project: r.project,
        structure: r.structure ?? "",
        subType: r.subType ?? "",
        mixed: r.mixed ? "Yes" : "",
        notInLatest: r.notInLatest ? "Yes" : "",
      };
      for (const col of columns) row[col.key] = col.get(r);
      return row;
    });

  const summaryToRows = (label: string, summary: BucketSummary): XlsxSummaryRow[] => [
    { label: `${label} SUMMARY`, values: {} },
    { label: "Total Release Balance", values: { release: summary.releaseBalanceMt, fab: summary.releaseBalanceMt } },
    { label: "Under Production", values: { fabGalva: summary.underProductionMt, fab: summary.underProductionMt } },
    { label: "Total Yard", values: { yard: summary.yardMt } },
    { label: "Operation Weight", values: { fab: summary.operationWeightMt, fabGalva: summary.operationWeightMt } },
    { label: "Grand Total Weight", values: { fab: summary.grandTotalMt, fabGalva: summary.grandTotalMt } },
  ];

  const autoBucketSheet = (
    name: string,
    inHouse: InventoryStructureCard[],
    outVendor: InventoryStructureCard[],
    columns: ColumnDef[],
    clampRelease: boolean,
  ): XlsxSheet => {
    const baseColumns = [
      { label: "Side", field: "side" },
      { label: "Project", field: "project" },
      { label: "Structure", field: "structure" },
      { label: "Sub Type", field: "subType" },
      { label: "Mixed", field: "mixed" },
      { label: "Not In Latest", field: "notInLatest" },
    ];
    const dataColumns = columns.map((c) => ({
      label: c.label,
      field: c.key,
      numeric: true,
      decimals: 3,
      total: true,
    }));
    return {
      name,
      columns: [...baseColumns, ...dataColumns],
      rows: [
        ...structureRows("in_house", inHouse, columns),
        ...structureRows("out_vendor", outVendor, columns),
      ],
      summaryRows: [
        ...summaryToRows("In-House", computeBucketSummary(inHouse, clampRelease)),
        ...summaryToRows("Out-Vendor", computeBucketSummary(outVendor, clampRelease)),
      ],
    };
  };

  const manualBucketRows = (entries: InventoryManualEntry[], includeAgg: boolean) =>
    entries.map((e) => {
      const agg = includeAgg ? aggregateProjectColumns(rawRows, e.projectCode) : null;
      return {
        side: SIDE_LABELS[e.side as InventorySide],
        project: e.projectCode,
        woOrderQtyMt: e.woOrderQtyMt,
        note: e.note ?? "",
        releaseBalanceMt: agg?.releaseBalanceMt ?? null,
        fabGalvaMt: agg?.fabGalvaMt ?? null,
        yardMt: agg?.yardMt ?? null,
        structureCount: agg?.structureCount ?? null,
      };
    });

  const handleExport = () => {
    const filteredManualA = applyJobFilterManual(manualA);
    const filteredManualE = applyJobFilterManual(manualE);
    const sheets: XlsxSheet[] = [
      {
        name: "A - " + BUCKET_LABELS.a.slice(0, 28),
        columns: [
          { label: "Side", field: "side" },
          { label: "Project", field: "project" },
          { label: "WO Qty (MT)", field: "woOrderQtyMt", numeric: true, decimals: 3, total: true },
          { label: "Note", field: "note" },
        ],
        rows: manualBucketRows(filteredManualA, false),
      },
      autoBucketSheet("B - Raw Material Incomplete", bInHouse, bOutVendor, BUCKET_B_COLUMNS, false),
      autoBucketSheet("C - RM Complete", cInHouse, cOutVendor, BUCKET_CD_COLUMNS, true),
      autoBucketSheet("D - Dispatch Clearance", dInHouse, dOutVendor, BUCKET_CD_COLUMNS, true),
      {
        name: "E - Ready Not Dispatched",
        columns: [
          { label: "Side", field: "side" },
          { label: "Project", field: "project" },
          { label: "Release Balance (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
          { label: "Fab+Galva (MT)", field: "fabGalvaMt", numeric: true, decimals: 3, total: true },
          { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ],
        rows: manualBucketRows(filteredManualE, true),
      },
    ];
    const date = new Date().toISOString().slice(0, 10);
    const baseTag = isCurrentJobs ? "current-jobs" : jobFilter ? jobFilter.replace(/[^\w-]+/g, "-") : "all";
    const tag = selectedProjects !== null ? `${baseTag}-filtered` : baseTag;
    void exportToXlsxSheets(`inventory_${tag}_${date}.xlsx`, sheets);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Boxes className="h-5 w-5 text-primary" />
          Bucket List
        </h1>
        <div className="flex items-center gap-3">
          {asOnDate && (
            <span className="text-xs text-muted-foreground">Order Review as on {asOnDate}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            onClick={handleExport}
            disabled={isLoading}
          >
            <FileSpreadsheet className="h-4 w-4" /> Export Excel
          </Button>
        </div>
      </div>

      <ProjectCheckboxFilter
        projects={jobScopedProjects}
        selected={selectedProjects}
        onChange={setSelectedProjects}
      />

      {isCurrentJobs && currentJobsSet.size === 0 && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              No Current Jobs list has been uploaded (or it&apos;s empty), so
              the Current Jobs filter matches nothing. Upload a project-code
              list on the Data page.
            </span>
          </CardContent>
        </Card>
      )}

      {!available && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              No Order Review file has been ingested yet. Buckets B, C and D need
              the Order Review upload (Data page) to compute — Buckets A and E
              below are manual and work regardless.
            </span>
          </CardContent>
        </Card>
      )}

      {available && (buckets.excludedNullReleaseCount > 0 || buckets.excludedNullInspectionCount > 0) && (
        <Card className="border-amber-500/40">
          <CardContent className="py-3 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              {buckets.excludedNullReleaseCount > 0 && (
                <>
                  {buckets.excludedNullReleaseCount} structure
                  {buckets.excludedNullReleaseCount === 1 ? "" : "s"} excluded from
                  Bucket B/C (no Balance Release value).{" "}
                </>
              )}
              {buckets.excludedNullInspectionCount > 0 && (
                <>
                  {buckets.excludedNullInspectionCount} structure
                  {buckets.excludedNullInspectionCount === 1 ? "" : "s"} excluded
                  from Bucket D (no Inspection value).
                </>
              )}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Bucket A */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">A — {BUCKET_LABELS.a}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canEdit && (
            <ManualAddForm mode="a" knownProjects={knownProjects} onAdd={addA} isPending={upsertA.isPending} />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ManualBucketSide side="in_house" entries={manualA} onDelete={removeA} canEdit={canEdit} deletingId={deletingAId} showWeight />
            <ManualBucketSide side="out_vendor" entries={manualA} onDelete={removeA} canEdit={canEdit} deletingId={deletingAId} showWeight />
          </div>
          <div className="flex items-center justify-between text-xs px-1">
            <span className="text-muted-foreground">Under Production Weight</span>
            <span className="tabular-nums font-medium">{mt(manualAWeightSum)} MT</span>
          </div>
        </CardContent>
      </Card>

      {/* Bucket B */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">B — {BUCKET_LABELS.b}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AutoBucketSide side="in_house" rows={bInHouse} columns={BUCKET_B_COLUMNS} clampRelease={false} />
              <AutoBucketSide side="out_vendor" rows={bOutVendor} columns={BUCKET_B_COLUMNS} clampRelease={false} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bucket C */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">C — {BUCKET_LABELS.c}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AutoBucketSide side="in_house" rows={cInHouse} columns={BUCKET_CD_COLUMNS} clampRelease />
              <AutoBucketSide side="out_vendor" rows={cOutVendor} columns={BUCKET_CD_COLUMNS} clampRelease />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bucket D */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">D — {BUCKET_LABELS.d}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AutoBucketSide side="in_house" rows={dInHouse} columns={BUCKET_CD_COLUMNS} clampRelease />
              <AutoBucketSide side="out_vendor" rows={dOutVendor} columns={BUCKET_CD_COLUMNS} clampRelease />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bucket E */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">E — {BUCKET_LABELS.e}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canEdit && (
            <ManualAddForm mode="e" knownProjects={knownProjects} onAdd={addESlot} isPending={upsertE.isPending} />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ManualBucketSide side="in_house" entries={manualE} onDelete={removeE} canEdit={canEdit} deletingId={deletingEId} rawRows={rawRows} summary={manualEInHouseSummary} />
            <ManualBucketSide side="out_vendor" entries={manualE} onDelete={removeE} canEdit={canEdit} deletingId={deletingEId} rawRows={rawRows} summary={manualEOutVendorSummary} />
          </div>
        </CardContent>
      </Card>

      {!canEdit && (
        <p className="text-xs text-muted-foreground text-center">
          Sign in (Data page) to add or remove manual Bucket A / E entries.
        </p>
      )}
    </div>
  );
}
