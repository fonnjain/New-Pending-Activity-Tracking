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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Boxes, ChevronRight, ChevronDown, Trash2, AlertTriangle, FileSpreadsheet, ArrowRightLeft } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet, type XlsxSummaryRow, type XlsxBlockGroup } from "@/lib/export";

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

const SIDE_LABELS: Record<InventorySide, string> = {
  in_house: "In-House",
  out_vendor: "Out-Vendor",
};

type BucketId = "b" | "c" | "d";

const BUCKET_SOURCE_LABEL: Record<BucketId, string> = {
  b: "B",
  c: "C",
  d: "D",
};

function makeBucketSelKey(bucket: BucketId, side: InventorySide, project: string) {
  return `${bucket}|${side}|${project}`;
}

function parseBucketSelKey(key: string): { bucket: BucketId; side: InventorySide; project: string } {
  const idx1 = key.indexOf("|");
  const idx2 = key.indexOf("|", idx1 + 1);
  return {
    bucket: key.slice(0, idx1) as BucketId,
    side: key.slice(idx1 + 1, idx2) as InventorySide,
    project: key.slice(idx2 + 1),
  };
}

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

function groupByMfcBatch(
  rows: InventoryStructureCard[],
): { mfcBatch: string; rows: InventoryStructureCard[] }[] {
  const map = new Map<string, InventoryStructureCard[]>();
  for (const r of rows) {
    if (!map.has(r.mfcBatch)) map.set(r.mfcBatch, []);
    map.get(r.mfcBatch)!.push(r);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === "Z") return 1;
      if (b === "Z") return -1;
      return a.localeCompare(b);
    })
    .map(([mfcBatch, bRows]) => ({ mfcBatch, rows: bRows }));
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
  bucket,
  side,
  rows,
  columns,
  clampRelease,
  groupByMfc,
  selectedKeys,
  onToggle,
}: {
  bucket: BucketId;
  side: InventorySide;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  clampRelease: boolean;
  groupByMfc: boolean;
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mfcGroups = useMemo(() => groupByMfcBatch(rows), [rows]);
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
        {rows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No structures.
          </div>
        ) : groupByMfc ? (
          mfcGroups.map(({ mfcBatch, rows: mfcRows }) => (
            <MfcTopRow
              key={mfcBatch}
              mfcBatch={mfcBatch}
              rows={mfcRows}
              columns={columns}
              getChecked={(project) => selectedKeys.has(makeBucketSelKey(bucket, side, project))}
              onToggle={(project) => onToggle(makeBucketSelKey(bucket, side, project))}
            />
          ))
        ) : (
          groups.map((g) => (
            <ProjectRow
              key={g.project}
              group={g}
              columns={columns}
              checked={selectedKeys.has(makeBucketSelKey(bucket, side, g.project))}
              onToggle={() => onToggle(makeBucketSelKey(bucket, side, g.project))}
            />
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
  checked,
  onToggle,
}: {
  group: ProjectGroup;
  columns: ColumnDef[];
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mfcGroups = useMemo(() => groupByMfcBatch(group.rows), [group.rows]);
  return (
    <div>
      <div className="flex items-center hover:bg-muted/30">
        <label
          className="flex items-center px-2.5 py-1.5 cursor-pointer shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={checked}
            onChange={() => onToggle()}
          />
        </label>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between pr-3 py-1.5 text-sm gap-2 min-w-0"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium truncate">{group.project}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {group.count} str
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
      </div>
      {open && (
        <div className="pl-6 pb-0.5">
          {mfcGroups.map(({ mfcBatch, rows: mfcRows }) => (
            <div
              key={mfcBatch}
              className="flex items-center justify-between gap-2 px-2 py-1 text-xs border-t first:border-t-0"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="shrink-0 text-[10px] font-medium px-1 py-px rounded border border-border/60 text-muted-foreground">
                  {mfcBatch}
                </span>
                <span className="text-muted-foreground shrink-0">{mfcRows.length} str</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                {columns.map((col) => (
                  <span key={col.key} className="tabular-nums text-right">
                    <span className="text-muted-foreground mr-1">{col.label}</span>
                    {mt(sumColumnOrNull(mfcRows, col.get))}
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

function MfcTopRow({
  mfcBatch,
  rows,
  columns,
  getChecked,
  onToggle,
}: {
  mfcBatch: string;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  getChecked: (project: string) => boolean;
  onToggle: (project: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const projectGroups = useMemo(() => groupByProject(rows), [rows]);
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
          <span className="font-medium shrink-0">MFC {mfcBatch}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {projectGroups.length} proj · {rows.length} str
          </span>
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {columns.map((col) => (
            <span key={col.key} className="text-[11px] tabular-nums text-right">
              <span className="text-muted-foreground mr-1">{col.label}</span>
              {mt(sumColumnOrNull(rows, col.get))}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="pl-6 pb-0.5">
          {projectGroups.map((g) => (
            <div
              key={g.project}
              className="flex items-center gap-1 border-t first:border-t-0 hover:bg-muted/20"
            >
              <label
                className="flex items-center px-2 py-1 cursor-pointer shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-primary"
                  checked={getChecked(g.project)}
                  onChange={() => onToggle(g.project)}
                />
              </label>
              <div className="flex-1 flex items-center justify-between gap-2 pr-2 py-1 text-xs min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="font-medium truncate">{g.project}</span>
                  <span className="text-muted-foreground shrink-0">{g.count} str</span>
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  {columns.map((col) => (
                    <span key={col.key} className="tabular-nums text-right">
                      <span className="text-muted-foreground mr-1">{col.label}</span>
                      {mt(sumColumnOrNull(g.rows, col.get))}
                    </span>
                  ))}
                </span>
              </div>
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
  projectMfcBatches,
}: {
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
  showWeight?: boolean;
  projectMfcBatches?: Map<string, string[]>;
}) {
  if (entries.length === 0) {
    return <div className="py-4 text-center text-xs text-muted-foreground">No entries.</div>;
  }
  return (
    <div className="divide-y">
      {entries.map((e) => {
        const batch = e.mfcBatch ?? null;
        const agg = rawRows
          ? aggregateProjectColumns(rawRows, e.projectCode, batch ?? undefined)
          : null;
        // Flag entries whose batch no longer appears in the project's current WIP.
        const stale =
          batch != null &&
          projectMfcBatches != null &&
          !projectMfcBatches.get(e.projectCode)?.includes(batch);
        return (
          <div key={e.id} className="flex flex-col gap-1 px-3 py-1.5 text-sm">
            <div className="flex items-center justify-between gap-1">
              <span className="flex items-center gap-1.5 min-w-0 truncate">
                <span className="truncate">{e.projectCode}</span>
                {batch && (
                  <span className={`shrink-0 text-[10px] font-medium px-1 py-px rounded border ${stale ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : "border-border/60 text-muted-foreground"}`}>
                    {batch}
                    {stale && " (not in WIP)"}
                  </span>
                )}
              </span>
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
  projectMfcBatches,
}: {
  side: InventorySide;
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
  showWeight?: boolean;
  summary?: BucketSummary;
  projectMfcBatches?: Map<string, string[]>;
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
        projectMfcBatches={projectMfcBatches}
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
  projectMfcBatches,
  onAdd,
  isPending,
}: {
  mode: "a" | "e";
  knownProjects: string[];
  /** Per-project batch lists for the cascading MFC dropdown (mode "e" only). */
  projectMfcBatches?: Map<string, string[]>;
  onAdd: (projectCode: string, side: InventorySide, woOrderQtyMt: number | null, mfcBatch?: string) => void;
  isPending: boolean;
}) {
  const [projectCode, setProjectCode] = useState("");
  const [mfcBatch, setMfcBatch] = useState("");
  const [side, setSide] = useState<InventorySide>("in_house");
  const [woOrderQtyMt, setWoOrderQtyMt] = useState<number | "">("");

  // Reset MFC batch whenever the project changes.
  const handleProjectChange = (v: string | null) => {
    setProjectCode(v ?? "");
    setMfcBatch("");
  };

  const batchOptions = mode === "e" && projectCode
    ? (projectMfcBatches?.get(projectCode) ?? [])
    : [];

  const submit = () => {
    const code = projectCode.trim();
    if (!code) return;
    if (mode === "a" && woOrderQtyMt === "") return;
    if (mode === "e" && !mfcBatch) return;
    onAdd(code, side, mode === "a" ? (woOrderQtyMt as number) : null, mode === "e" ? mfcBatch : undefined);
    setProjectCode("");
    setMfcBatch("");
    setWoOrderQtyMt("");
  };

  const canSubmit =
    !!projectCode.trim() &&
    (mode === "a" ? woOrderQtyMt !== "" : !!mfcBatch) &&
    !isPending;

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
        <>
          <div className="w-44">
            <SearchableSelect
              value={projectCode || null}
              onChange={handleProjectChange}
              options={knownProjects}
              allLabel="Select project..."
            />
          </div>
          <div className="w-36">
            <SearchableSelect
              value={mfcBatch || null}
              onChange={(v) => setMfcBatch(v ?? "")}
              options={batchOptions}
              allLabel={projectCode ? "Select batch..." : "Select project first"}
              disabled={!projectCode || batchOptions.length === 0}
            />
          </div>
        </>
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
        disabled={!canSubmit}
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
  const { available, asOnDate, isLoading, rawRows, buckets, manualA, manualE, projectMfcBatches } = useInventoryData();
  const { data: authStatus } = useGetAuthStatus();
  const canEdit = !!authStatus?.authenticated;

  /** Controls grouping mode for Buckets B, C, D (not A or E). */
  const [groupByMfc, setGroupByMfc] = useState(false);

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

  // ----- Bucket B/C/D row-selection state for the Move dialog -----
  const [bucketSelection, setBucketSelection] = useState<Set<string>>(new Set());
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveSide, setMoveSide] = useState<InventorySide>("in_house");
  const [moveBucket, setMoveBucket] = useState<"e" | "a">("e");
  const [moveMfcBatch, setMoveMfcBatch] = useState("");
  const [moveWoQty, setMoveWoQty] = useState<number | "">("");

  const toggleBucketItem = (key: string) =>
    setBucketSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const clearBucketSelection = () => setBucketSelection(new Set());

  const selectedBucketItems = useMemo(
    () => [...bucketSelection].map(parseBucketSelKey),
    [bucketSelection],
  );

  const uniqueSelectedProjects = useMemo(
    () => [...new Set(selectedBucketItems.map((i) => i.project))],
    [selectedBucketItems],
  );

  const moveBatchOptions = useMemo(() => {
    const batches = new Set<string>();
    for (const proj of uniqueSelectedProjects) {
      for (const b of projectMfcBatches?.get(proj) ?? []) batches.add(b);
    }
    return [...batches].sort((a, b) => {
      if (a === "Z") return 1;
      if (b === "Z") return -1;
      return a.localeCompare(b);
    });
  }, [uniqueSelectedProjects, projectMfcBatches]);

  const openMoveDialog = () => {
    const inHouseCount = selectedBucketItems.filter((i) => i.side === "in_house").length;
    setMoveSide(inHouseCount >= selectedBucketItems.length / 2 ? "in_house" : "out_vendor");
    setMoveBucket("e");
    setMoveMfcBatch(moveBatchOptions.length === 1 ? moveBatchOptions[0] : "");
    setMoveWoQty("");
    setMoveDialogOpen(true);
  };

  const applyMove = () => {
    const canApply = moveBucket === "a" ? typeof moveWoQty === "number" : !!moveMfcBatch;
    if (!canApply) return;
    for (const proj of uniqueSelectedProjects) {
      if (moveBucket === "e") {
        addE(proj, moveSide, moveMfcBatch);
      } else {
        addA(proj, moveSide, typeof moveWoQty === "number" ? moveWoQty : null);
      }
    }
    setMoveDialogOpen(false);
    clearBucketSelection();
  };
  // ---------------------------------------------------------------

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
  const addE = (projectCode: string, side: InventorySide, mfcBatch: string) => {
    upsertE.mutate(
      { data: { projectCode, side, mfcBatch } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListInventoryManualEQueryKey() }) },
    );
  };
  const addESlot = (projectCode: string, side: InventorySide, _woOrderQtyMt: number | null, mfcBatch?: string) =>
    addE(projectCode, side, mfcBatch ?? "Z");

  const manualAWeightSum = manualA.reduce((s, e) => s + (e.woOrderQtyMt ?? 0), 0);
  const manualEInHouseSummary = useMemo(
    () =>
      computeManualESummary(
        manualE
          .filter((e) => e.side === "in_house")
          .map((e) => aggregateProjectColumns(rawRows, e.projectCode, e.mfcBatch ?? undefined)),
      ),
    [manualE, rawRows],
  );
  const manualEOutVendorSummary = useMemo(
    () =>
      computeManualESummary(
        manualE
          .filter((e) => e.side === "out_vendor")
          .map((e) => aggregateProjectColumns(rawRows, e.projectCode, e.mfcBatch ?? undefined)),
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

  // Export grain: one row per (project, mfcBatch). sortMfcFirst=true orders
  // MFC->Project (mirrors Group-by-MFC mode); false orders Project->MFC
  // (mirrors Group-by-Project mode).
  const projectMfcRows = (
    side: InventorySide,
    rows: InventoryStructureCard[],
    columns: ColumnDef[],
    sortMfcFirst: boolean,
  ): Record<string, string | number | null>[] => {
    const map = new Map<string, Record<string, string | number | null>>();
    for (const r of rows) {
      const key = `${r.project}\u0001${r.mfcBatch}`;
      const existing = map.get(key);
      if (!existing) {
        const row: Record<string, string | number | null> = {
          side: SIDE_LABELS[side],
          project: r.project,
          mfcBatch: r.mfcBatch,
          structureCount: 1,
        };
        for (const col of columns) row[col.key] = col.get(r) ?? 0;
        map.set(key, row);
      } else {
        (existing.structureCount as number) += 1;
        for (const col of columns) {
          const val = col.get(r);
          if (val !== null) {
            existing[col.key] = ((existing[col.key] as number) ?? 0) + val;
          }
        }
      }
    }
    const result = [...map.values()];
    if (sortMfcFirst) {
      result.sort((a, b) => {
        const ma = a.mfcBatch as string;
        const mb = b.mfcBatch as string;
        if (ma === "Z" && mb !== "Z") return 1;
        if (mb === "Z" && ma !== "Z") return -1;
        const cmp = ma.localeCompare(mb);
        if (cmp !== 0) return cmp;
        return (a.project as string).localeCompare(b.project as string);
      });
    } else {
      result.sort((a, b) => {
        const pa = a.project as string;
        const pb = b.project as string;
        const cmp = pa.localeCompare(pb);
        if (cmp !== 0) return cmp;
        const ma = a.mfcBatch as string;
        const mb = b.mfcBatch as string;
        if (ma === "Z" && mb !== "Z") return 1;
        if (mb === "Z" && ma !== "Z") return -1;
        return ma.localeCompare(mb);
      });
    }
    return result;
  };

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
    mfcFirst: boolean,
  ): XlsxSheet => {
    // Column order mirrors the active grouping:
    // Project-grouped → Side, Project, MFC Batch, data…, Structures
    // MFC-grouped     → Side, MFC Batch, Project, data…, Structures
    const baseColumns = mfcFirst
      ? [
          { label: "Side", field: "side" },
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Project", field: "project" },
        ]
      : [
          { label: "Side", field: "side" },
          { label: "Project", field: "project" },
          { label: "MFC Batch", field: "mfcBatch" },
        ];
    const dataColumns = [
      ...columns.map((c) => ({
        label: c.label,
        field: c.key,
        numeric: true,
        decimals: 3,
        total: true,
      })),
      { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
    ];
    return {
      name,
      columns: [...baseColumns, ...dataColumns],
      sections: [
        {
          rows: projectMfcRows("in_house", inHouse, columns, mfcFirst),
          summaryRows: summaryToRows("In-House", computeBucketSummary(inHouse, clampRelease)),
        },
        {
          rows: projectMfcRows("out_vendor", outVendor, columns, mfcFirst),
          summaryRows: summaryToRows("Out-Vendor", computeBucketSummary(outVendor, clampRelease)),
        },
      ],
    };
  };

  const manualBucketRows = (entries: InventoryManualEntry[], includeAgg: boolean) =>
    entries.map((e) => {
      const batch = e.mfcBatch ?? undefined;
      const agg = includeAgg ? aggregateProjectColumns(rawRows, e.projectCode, batch) : null;
      return {
        side: SIDE_LABELS[e.side as InventorySide],
        project: e.projectCode,
        mfcBatch: batch ?? "",
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
      autoBucketSheet("B - Raw Material Incomplete", bInHouse, bOutVendor, BUCKET_B_COLUMNS, false, groupByMfc),
      autoBucketSheet("C - RM Complete", cInHouse, cOutVendor, BUCKET_CD_COLUMNS, true, groupByMfc),
      autoBucketSheet("D - Dispatch Clearance", dInHouse, dOutVendor, BUCKET_CD_COLUMNS, true, groupByMfc),
      {
        name: "E - Ready Not Dispatched",
        columns: [
          { label: "Side", field: "side" },
          { label: "Project", field: "project" },
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Release Balance (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
          { label: "Fab+Galva (MT)", field: "fabGalvaMt", numeric: true, decimals: 3, total: true },
          { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ],
        rows: manualBucketRows(filteredManualE, true),
      },
    ];

    // Combined sheet: InHouse blocks side-by-side on top, OutVendor below.
    // B/C/D use projectMfcRows (project-first ordering in the combined sheet).
    const allManualA = manualBucketRows(filteredManualA, false);
    const allManualE = manualBucketRows(filteredManualE, true);
    const aRowsIH = allManualA.filter((r) => r.side === SIDE_LABELS.in_house);
    const aRowsOV = allManualA.filter((r) => r.side === SIDE_LABELS.out_vendor);
    const eRowsIH = allManualE.filter((r) => r.side === SIDE_LABELS.in_house);
    const eRowsOV = allManualE.filter((r) => r.side === SIDE_LABELS.out_vendor);

    // blockCols: used in the Combined sheet; no "Side" column (side is the band label).
    // Column order mirrors the active grouping toggle.
    const blockCols = (cols: ColumnDef[]) => groupByMfc
      ? [
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Project", field: "project" },
          ...cols.map((c) => ({ label: c.label, field: c.key, numeric: true, decimals: 3, total: true })),
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ]
      : [
          { label: "Project", field: "project" },
          { label: "MFC Batch", field: "mfcBatch" },
          ...cols.map((c) => ({ label: c.label, field: c.key, numeric: true, decimals: 3, total: true })),
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ];

    const aCols: XlsxBlockGroup["columns"] = [
      { label: "Project", field: "project" },
      { label: "WO Qty (MT)", field: "woOrderQtyMt", numeric: true, decimals: 3, total: true },
    ];
    const eCols: XlsxBlockGroup["columns"] = groupByMfc
      ? [
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Project", field: "project" },
          { label: "Release Bal. (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
          { label: "Fab+Galva (MT)", field: "fabGalvaMt", numeric: true, decimals: 3, total: true },
          { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ]
      : [
          { label: "Project", field: "project" },
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Release Bal. (MT)", field: "releaseBalanceMt", numeric: true, decimals: 3, total: true },
          { label: "Fab+Galva (MT)", field: "fabGalvaMt", numeric: true, decimals: 3, total: true },
          { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ];

    const combined = {
      inHouse: [
        { label: "A - " + BUCKET_LABELS.a.slice(0, 26), columns: aCols, rows: aRowsIH },
        {
          label: "B - Raw Material Incomplete",
          columns: blockCols(BUCKET_B_COLUMNS),
          rows: projectMfcRows("in_house", bInHouse, BUCKET_B_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("In-House", computeBucketSummary(bInHouse, false)),
        },
        {
          label: "C - RM Complete",
          columns: blockCols(BUCKET_CD_COLUMNS),
          rows: projectMfcRows("in_house", cInHouse, BUCKET_CD_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("In-House", computeBucketSummary(cInHouse, true)),
        },
        {
          label: "D - Dispatch Clearance",
          columns: blockCols(BUCKET_CD_COLUMNS),
          rows: projectMfcRows("in_house", dInHouse, BUCKET_CD_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("In-House", computeBucketSummary(dInHouse, true)),
        },
        { label: "E - Ready Not Dispatched", columns: eCols, rows: eRowsIH },
      ] satisfies XlsxBlockGroup[],
      outVendor: [
        { label: "A - " + BUCKET_LABELS.a.slice(0, 26), columns: aCols, rows: aRowsOV },
        {
          label: "B - Raw Material Incomplete",
          columns: blockCols(BUCKET_B_COLUMNS),
          rows: projectMfcRows("out_vendor", bOutVendor, BUCKET_B_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("Out-Vendor", computeBucketSummary(bOutVendor, false)),
        },
        {
          label: "C - RM Complete",
          columns: blockCols(BUCKET_CD_COLUMNS),
          rows: projectMfcRows("out_vendor", cOutVendor, BUCKET_CD_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("Out-Vendor", computeBucketSummary(cOutVendor, true)),
        },
        {
          label: "D - Dispatch Clearance",
          columns: blockCols(BUCKET_CD_COLUMNS),
          rows: projectMfcRows("out_vendor", dOutVendor, BUCKET_CD_COLUMNS, groupByMfc),
          summaryRows: summaryToRows("Out-Vendor", computeBucketSummary(dOutVendor, true)),
        },
        { label: "E - Ready Not Dispatched", columns: eCols, rows: eRowsOV },
      ] satisfies XlsxBlockGroup[],
    };

    const date = new Date().toISOString().slice(0, 10);
    const baseTag = isCurrentJobs ? "current-jobs" : jobFilter ? jobFilter.replace(/[^\w-]+/g, "-") : "all";
    const tag = selectedProjects !== null ? `${baseTag}-filtered` : baseTag;
    void exportToXlsxSheets(`inventory_${tag}_${date}.xlsx`, sheets, combined);
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

      {available && buckets.excludedCompletedCount > 0 && (
        <div className="text-xs text-muted-foreground px-1">
          {buckets.excludedCompletedCount} completed structure
          {buckets.excludedCompletedCount === 1 ? "" : "s"} excluded (no remaining WIP marks).
        </div>
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

      {/* Selection action bar — appears when any B/C/D project rows are checked */}
      {bucketSelection.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-primary/5 border border-primary/20 rounded-md">
          <span className="text-sm font-medium">
            {bucketSelection.size} project{bucketSelection.size === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={clearBucketSelection}>
              Clear
            </Button>
            {canEdit && (
              <Button size="sm" className="h-8 gap-1.5" onClick={openMoveDialog}>
                <ArrowRightLeft className="h-3.5 w-3.5" /> Move to bucket
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Group-by toggle for Buckets B / C / D */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Group by</span>
        <Segmented
          value={groupByMfc ? "mfc" : "project"}
          onChange={(v) => setGroupByMfc(v === "mfc")}
          options={[
            { value: "project", label: "Project" },
            { value: "mfc", label: "MFC Batch" },
          ]}
        />
        <span className="text-xs text-muted-foreground">(applies to B, C, D)</span>
      </div>

      {/* Move dialog */}
      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move selected projects</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Selected summary */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                Selected ({selectedBucketItems.length})
              </p>
              <div className="border rounded-md divide-y max-h-36 overflow-auto">
                {selectedBucketItems.map((item) => (
                  <div
                    key={`${item.bucket}|${item.side}|${item.project}`}
                    className="flex items-center justify-between px-2.5 py-1 text-xs"
                  >
                    <span className="font-medium truncate">{item.project}</span>
                    <span className="text-muted-foreground shrink-0 ml-2">
                      Bucket {BUCKET_SOURCE_LABEL[item.bucket]} · {SIDE_LABELS[item.side]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Target side */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Target side</p>
              <Segmented
                value={moveSide}
                onChange={(v) => setMoveSide(v as InventorySide)}
                options={[
                  { value: "in_house", label: "In-House" },
                  { value: "out_vendor", label: "Out-Vendor" },
                ]}
              />
            </div>

            {/* Target bucket */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Target bucket</p>
              <Select value={moveBucket} onValueChange={(v) => setMoveBucket(v as "e" | "a")}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="e">E — {BUCKET_LABELS.e}</SelectItem>
                  <SelectItem value="a">A — {BUCKET_LABELS.a}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Bucket-specific extra field */}
            {moveBucket === "e" && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">MFC Batch</p>
                {moveBatchOptions.length > 0 ? (
                  <SearchableSelect
                    value={moveMfcBatch || null}
                    onChange={(v) => setMoveMfcBatch(v ?? "")}
                    options={moveBatchOptions}
                    allLabel="Select batch..."
                  />
                ) : (
                  <Input
                    placeholder="Batch code (e.g. Z)"
                    value={moveMfcBatch}
                    onChange={(e) => setMoveMfcBatch(e.target.value)}
                    className="h-8"
                  />
                )}
              </div>
            )}

            {moveBucket === "a" && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">WO Qty (MT)</p>
                <NumberInput
                  placeholder="Weight (MT)"
                  value={moveWoQty}
                  onValueChange={(raw) => setMoveWoQty(raw === "" ? "" : Number(raw))}
                  className="h-8 w-36"
                />
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                (moveBucket === "e" ? !moveMfcBatch : typeof moveWoQty !== "number") ||
                upsertA.isPending ||
                upsertE.isPending
              }
              onClick={applyMove}
            >
              Move {uniqueSelectedProjects.length} project
              {uniqueSelectedProjects.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <AutoBucketSide bucket="b" side="in_house" rows={bInHouse} columns={BUCKET_B_COLUMNS} clampRelease={false} groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
              <AutoBucketSide bucket="b" side="out_vendor" rows={bOutVendor} columns={BUCKET_B_COLUMNS} clampRelease={false} groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
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
              <AutoBucketSide bucket="c" side="in_house" rows={cInHouse} columns={BUCKET_CD_COLUMNS} clampRelease groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
              <AutoBucketSide bucket="c" side="out_vendor" rows={cOutVendor} columns={BUCKET_CD_COLUMNS} clampRelease groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
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
              <AutoBucketSide bucket="d" side="in_house" rows={dInHouse} columns={BUCKET_CD_COLUMNS} clampRelease groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
              <AutoBucketSide bucket="d" side="out_vendor" rows={dOutVendor} columns={BUCKET_CD_COLUMNS} clampRelease groupByMfc={groupByMfc} selectedKeys={bucketSelection} onToggle={toggleBucketItem} />
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
            <ManualAddForm mode="e" knownProjects={knownProjects} projectMfcBatches={projectMfcBatches} onAdd={addESlot} isPending={upsertE.isPending} />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ManualBucketSide side="in_house" entries={manualE} onDelete={removeE} canEdit={canEdit} deletingId={deletingEId} rawRows={rawRows} summary={manualEInHouseSummary} projectMfcBatches={projectMfcBatches} />
            <ManualBucketSide side="out_vendor" entries={manualE} onDelete={removeE} canEdit={canEdit} deletingId={deletingEId} rawRows={rawRows} summary={manualEOutVendorSummary} projectMfcBatches={projectMfcBatches} />
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
