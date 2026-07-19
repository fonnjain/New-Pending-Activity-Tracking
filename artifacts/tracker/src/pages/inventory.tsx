import { useEffect, useMemo, useState, useCallback } from "react";
import { useTracker, useCurrentJobsSet, CURRENT_JOBS_FILTER_VALUE } from "@/lib/store";
import {
  useGetAuthStatus,
  useListInventoryManualE,
  useUpsertInventoryManualE,
  useDeleteInventoryManualE,
  useListInventoryMfcColors,
  useUpsertInventoryMfcColor,
  useDeleteInventoryMfcColor,
  getListInventoryManualEQueryKey,
  getListInventoryMfcColorsQueryKey,
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import {
  Boxes,
  ChevronRight,
  ChevronDown,
  Trash2,
  AlertTriangle,
  FileSpreadsheet,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsxSheets, type XlsxSheet, type XlsxSummaryRow } from "@/lib/export";

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

type MfcColorName = "green" | "white" | "yellow";

const MFC_COLOR_CSS: Record<MfcColorName, string> = {
  green: "#92D050",
  white: "#FFFFFF",
  yellow: "#FFFF00",
};

const MFC_COLOR_ARGB: Record<MfcColorName, string> = {
  green: "FF92D050",
  white: "FFFFFFFF",
  yellow: "FFFFFF00",
};

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

// Bucket A: read-only computed panel. Groups qualifying structures by project
// and shows project name, structure count, and summed Order Qty Weight (Col G).
function BucketAPanel({ rows }: { rows: InventoryStructureCard[] }) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const totalWeight = groups.reduce((s, g) => s + g.weightMt, 0);
  const totalCount = groups.reduce((s, g) => s + g.count, 0);

  if (groups.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No projects — all structures have WO Order Qty or Release Qty allocated.
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="divide-y max-h-80 overflow-auto">
        {groups.map((g) => (
          <div
            key={g.project}
            className="flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/30"
          >
            <span className="font-medium">{g.project}</span>
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>
                {g.count} structure{g.count === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums font-medium text-foreground">{mt(g.weightMt)} MT</span>
            </span>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t bg-muted/20 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">
          {groups.length} project{groups.length === 1 ? "" : "s"} &middot; {totalCount}{" "}
          structure{totalCount === 1 ? "" : "s"}
        </span>
        <span className="tabular-nums font-medium">{mt(totalWeight)} MT</span>
      </div>
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
  const mfcGroups = useMemo(() => groupByMfcBatch(group.rows), [group.rows]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-sm gap-2 min-w-0 hover:bg-muted/30"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="font-medium truncate">{group.project}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">{group.count} str</span>
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

const MFC_COLOR_NAMES: MfcColorName[] = ["green", "white", "yellow"];

function MfcTopRow({
  mfcBatch,
  rows,
  columns,
  currentColor,
  canEdit,
  onSetColor,
  onClearColor,
}: {
  mfcBatch: string;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  currentColor?: string;
  canEdit?: boolean;
  onSetColor?: (color: string) => void;
  onClearColor?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const projectGroups = useMemo(() => groupByProject(rows), [rows]);
  return (
    <div>
      <div className="w-full flex items-center justify-between hover:bg-muted/30 text-sm">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          className="flex items-center gap-1.5 min-w-0 px-3 py-1.5 cursor-pointer select-none flex-1"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          {currentColor && currentColor in MFC_COLOR_CSS && (
            <span
              style={{
                background: MFC_COLOR_CSS[currentColor as MfcColorName],
                border: currentColor === "white" ? "1px solid #9CA3AF" : "none",
              }}
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              title={`Backfill: ${currentColor}`}
            />
          )}
          <span className="font-medium shrink-0">MFC {mfcBatch}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {projectGroups.length} proj &middot; {rows.length} str
          </span>
        </div>
        <span className="flex items-center gap-3 shrink-0 px-3 py-1.5">
          {canEdit && (
            <span className="flex items-center gap-0.5" title="Set backfill colour">
              {MFC_COLOR_NAMES.map((c) => {
                const active = currentColor === c;
                return (
                  <button
                    key={c}
                    type="button"
                    title={c.charAt(0).toUpperCase() + c.slice(1)}
                    onClick={() => {
                      if (active) onClearColor?.();
                      else onSetColor?.(c);
                    }}
                    style={{
                      background: MFC_COLOR_CSS[c],
                      border: active
                        ? "2px solid #1F2937"
                        : c === "white"
                          ? "1px solid #9CA3AF"
                          : "1px solid transparent",
                    }}
                    className="w-5 h-5 rounded-full cursor-pointer"
                  />
                );
              })}
            </span>
          )}
          {columns.map((col) => (
            <span key={col.key} className="text-[11px] tabular-nums text-right">
              <span className="text-muted-foreground mr-1">{col.label}</span>
              {mt(sumColumnOrNull(rows, col.get))}
            </span>
          ))}
        </span>
      </div>
      {open && (
        <div className="pl-6 pb-0.5">
          {projectGroups.map((g) => (
            <div
              key={g.project}
              className="flex items-center border-t first:border-t-0 hover:bg-muted/20"
            >
              <div className="flex-1 flex items-center justify-between gap-2 px-3 py-1 text-xs min-w-0">
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

// Single flat panel for an auto-computed bucket (B, C, or D).
function AutoBucketPanel({
  rows,
  columns,
  clampRelease,
  groupByMfc,
  mfcColorMap,
  canEdit,
  onSetMfcColor,
  onClearMfcColor,
}: {
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  clampRelease: boolean;
  groupByMfc: boolean;
  mfcColorMap: Map<string, string>;
  canEdit: boolean;
  onSetMfcColor: (mfc: string, color: string) => void;
  onClearMfcColor: (mfc: string) => void;
}) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mfcGroups = useMemo(() => groupByMfcBatch(rows), [rows]);
  const totalWeight = groups.reduce((s, g) => s + g.weightMt, 0);
  const totalCount = groups.reduce((s, g) => s + g.count, 0);
  const summary = useMemo(() => computeBucketSummary(rows, clampRelease), [rows, clampRelease]);

  return (
    <div className="border rounded-md">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalCount} structure{totalCount === 1 ? "" : "s"} &middot; {mt(totalWeight)} MT
        </span>
      </div>
      <div className="max-h-96 overflow-auto divide-y">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No structures.</div>
        ) : groupByMfc ? (
          mfcGroups.map(({ mfcBatch, rows: mfcRows }) => (
            <MfcTopRow
              key={mfcBatch}
              mfcBatch={mfcBatch}
              rows={mfcRows}
              columns={columns}
              currentColor={mfcColorMap.get(mfcBatch)}
              canEdit={canEdit}
              onSetColor={(color) => onSetMfcColor(mfcBatch, color)}
              onClearColor={() => onClearMfcColor(mfcBatch)}
            />
          ))
        ) : (
          groups.map((g) => <ProjectRow key={g.project} group={g} columns={columns} />)
        )}
      </div>
      <SummaryFooter summary={summary} />
    </div>
  );
}

function ManualEntryList({
  entries,
  onDelete,
  canEdit,
  deletingId,
  rawRows,
  projectMfcBatches,
}: {
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
  projectMfcBatches?: Map<string, string[]>;
}) {
  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">No entries.</div>
    );
  }
  return (
    <div className="divide-y">
      {entries.map((e) => {
        const batch = e.mfcBatch ?? null;
        const agg = rawRows
          ? aggregateProjectColumns(rawRows, e.projectCode, batch ?? undefined)
          : null;
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
                  <span
                    className={`shrink-0 text-[10px] font-medium px-1 py-px rounded border ${
                      stale
                        ? "border-amber-500/60 text-amber-600 dark:text-amber-400"
                        : "border-border/60 text-muted-foreground"
                    }`}
                  >
                    {batch}
                    {stale && " (not in WIP)"}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2 shrink-0">
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
  summary,
  projectMfcBatches,
}: {
  side: InventorySide;
  entries: InventoryManualEntry[];
  onDelete: (id: number) => void;
  canEdit: boolean;
  deletingId: number | null;
  rawRows?: Parameters<typeof aggregateProjectColumns>[0];
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
  knownProjects,
  projectMfcBatches,
  onAdd,
  isPending,
}: {
  knownProjects: string[];
  projectMfcBatches?: Map<string, string[]>;
  onAdd: (projectCode: string, side: InventorySide, mfcBatch: string) => void;
  isPending: boolean;
}) {
  const [projectCode, setProjectCode] = useState("");
  const [mfcBatch, setMfcBatch] = useState("");
  const [side, setSide] = useState<InventorySide>("in_house");

  const handleProjectChange = (v: string | null) => {
    setProjectCode(v ?? "");
    setMfcBatch("");
  };

  const batchOptions = projectCode ? (projectMfcBatches?.get(projectCode) ?? []) : [];

  const submit = () => {
    const code = projectCode.trim();
    if (!code || !mfcBatch) return;
    onAdd(code, side, mfcBatch);
    setProjectCode("");
    setMfcBatch("");
  };

  const canSubmit = !!projectCode.trim() && !!mfcBatch && !isPending;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b">
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
      <Segmented
        value={side}
        onChange={(v) => setSide(v as InventorySide)}
        options={[
          { value: "in_house", label: "In-House" },
          { value: "out_vendor", label: "Out-Vendor" },
        ]}
      />
      <Button size="sm" className="h-8" disabled={!canSubmit} onClick={submit}>
        Add
      </Button>
    </div>
  );
}

export default function InventoryView() {
  const { filters } = useTracker();
  const queryClient = useQueryClient();
  const { available, asOnDate, isLoading, rawRows, buckets, manualE, projectMfcBatches } =
    useInventoryData();
  const { data: authStatus } = useGetAuthStatus();
  const canEdit = !!authStatus?.authenticated;
  const { toast } = useToast();

  const [groupByMfc, setGroupByMfc] = useState(false);

  const jobFilter = filters.job;
  const isCurrentJobs = jobFilter === CURRENT_JOBS_FILTER_VALUE;
  const { set: currentJobsSet } = useCurrentJobsSet();

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

  const [selectedProjects, setSelectedProjects] = useState<Set<string> | null>(null);

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

  // MFC backfill colours — keyed by mfcBatch only (one colour per batch).
  const { data: mfcColors = [] } = useListInventoryMfcColors();
  const upsertMfcColor = useUpsertInventoryMfcColor();
  const deleteMfcColor = useDeleteInventoryMfcColor();
  const mfcColorMap = useMemo(
    () => new Map(mfcColors.map((c) => [c.mfcBatch, c.color])),
    [mfcColors],
  );
  const invalidateMfcColors = useCallback(
    () => queryClient.invalidateQueries({ queryKey: getListInventoryMfcColorsQueryKey() }),
    [queryClient],
  );
  const setMfcColor = useCallback(
    (mfcBatch: string, color: string) => {
      upsertMfcColor.mutate(
        { data: { mfcBatch, side: "in_house", color: color as MfcColorName } },
        {
          onSuccess: () => {
            invalidateMfcColors();
          },
          onError: (err) => {
            toast({
              variant: "destructive",
              title: "Failed to save colour",
              description: err?.message ?? "Unknown error",
            });
          },
        },
      );
    },
    [upsertMfcColor, invalidateMfcColors, toast],
  );
  const clearMfcColor = useCallback(
    (mfcBatch: string) => {
      deleteMfcColor.mutate(
        { params: { mfcBatch, side: "in_house" } },
        {
          onSuccess: () => {
            invalidateMfcColors();
          },
          onError: (err) => {
            toast({
              variant: "destructive",
              title: "Failed to clear colour",
              description: err?.message ?? "Unknown error",
            });
          },
        },
      );
    },
    [deleteMfcColor, invalidateMfcColors, toast],
  );

  const bucketA = applyJobFilter(buckets.a);
  const bRows = applyJobFilter(buckets.b);
  const cRows = applyJobFilter(buckets.c);
  const dRows = applyJobFilter(buckets.d);

  const knownProjects = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.project);
    return Array.from(set).sort();
  }, [rawRows]);

  const upsertE = useUpsertInventoryManualE();
  const deleteE = useDeleteInventoryManualE();
  const [deletingEId, setDeletingEId] = useState<number | null>(null);

  const addE = (projectCode: string, side: InventorySide, mfcBatch: string) => {
    upsertE.mutate(
      { data: { projectCode, side, mfcBatch } },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getListInventoryManualEQueryKey() }),
      },
    );
  };

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

  const applyJobFilterManual = (entries: InventoryManualEntry[]): InventoryManualEntry[] => {
    let out = entries;
    if (isCurrentJobs) out = out.filter((e) => currentJobsSet.has(e.projectCode));
    else if (jobFilter) out = out.filter((e) => e.projectCode === jobFilter);
    return out.filter((e) => matchesProjectSelection(e.projectCode));
  };

  const projectMfcRows = (
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
          project: r.project,
          mfcBatch: r.mfcBatch,
          structureCount: 1,
        };
        for (const col of columns) row[col.key] = col.get(r) ?? 0;
        const colorName = mfcColorMap.get(r.mfcBatch ?? "Z") as MfcColorName | undefined;
        if (colorName && colorName in MFC_COLOR_ARGB) {
          row._bgColor = MFC_COLOR_ARGB[colorName];
        }
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
    {
      label: "Total Release Balance",
      values: { release: summary.releaseBalanceMt, fab: summary.releaseBalanceMt },
    },
    {
      label: "Under Production",
      values: { fabGalva: summary.underProductionMt, fab: summary.underProductionMt },
    },
    { label: "Total Yard", values: { yard: summary.yardMt } },
    {
      label: "Operation Weight",
      values: { fab: summary.operationWeightMt, fabGalva: summary.operationWeightMt },
    },
    {
      label: "Grand Total Weight",
      values: { fab: summary.grandTotalMt, fabGalva: summary.grandTotalMt },
    },
  ];

  const autoBucketSheet = (
    name: string,
    rows: InventoryStructureCard[],
    columns: ColumnDef[],
    clampRelease: boolean,
    mfcFirst: boolean,
  ): XlsxSheet => {
    const baseColumns = mfcFirst
      ? [
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Project", field: "project" },
        ]
      : [
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
          rows: projectMfcRows(rows, columns, mfcFirst),
          summaryRows: summaryToRows(name, computeBucketSummary(rows, clampRelease)),
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
        releaseBalanceMt: agg?.releaseBalanceMt ?? null,
        fabGalvaMt: agg?.fabGalvaMt ?? null,
        yardMt: agg?.yardMt ?? null,
        structureCount: agg?.structureCount ?? null,
      };
    });

  const handleExport = () => {
    const filteredManualE = applyJobFilterManual(manualE);
    const bucketAGroups = groupByProject(bucketA);

    const sheets: XlsxSheet[] = [
      {
        name: "A - " + BUCKET_LABELS.a.slice(0, 28),
        columns: [
          { label: "Project", field: "project" },
          { label: "Structures", field: "structures", numeric: true, decimals: 0 },
          { label: "Order Qty (MT)", field: "orderQtyMt", numeric: true, decimals: 3, total: true },
        ],
        rows: bucketAGroups.map((g) => ({
          project: g.project,
          structures: g.count,
          orderQtyMt: g.weightMt,
        })),
      },
      autoBucketSheet(
        "B - Raw Material Incomplete",
        bRows,
        BUCKET_B_COLUMNS,
        false,
        groupByMfc,
      ),
      autoBucketSheet("C - RM Complete", cRows, BUCKET_CD_COLUMNS, true, groupByMfc),
      autoBucketSheet("D - Dispatch Clearance", dRows, BUCKET_CD_COLUMNS, true, groupByMfc),
      {
        name: "E - Ready Not Dispatched",
        columns: [
          { label: "Side", field: "side" },
          { label: "Project", field: "project" },
          { label: "MFC Batch", field: "mfcBatch" },
          {
            label: "Release Balance (MT)",
            field: "releaseBalanceMt",
            numeric: true,
            decimals: 3,
            total: true,
          },
          {
            label: "Fab+Galva (MT)",
            field: "fabGalvaMt",
            numeric: true,
            decimals: 3,
            total: true,
          },
          { label: "Yard (MT)", field: "yardMt", numeric: true, decimals: 3, total: true },
          { label: "Structures", field: "structureCount", numeric: true, decimals: 0 },
        ],
        rows: manualBucketRows(filteredManualE, true),
      },
    ];

    const date = new Date().toISOString().slice(0, 10);
    const baseTag = isCurrentJobs
      ? "current-jobs"
      : jobFilter
        ? jobFilter.replace(/[^\w-]+/g, "-")
        : "all";
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
              No Current Jobs list has been uploaded (or it&apos;s empty), so the Current Jobs
              filter matches nothing. Upload a project-code list on the Data page.
            </span>
          </CardContent>
        </Card>
      )}

      {!available && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              No Order Review file has been ingested yet. Buckets A, B, C and D need the Order
              Review upload (Data page) to compute — Bucket E below is manual and works regardless.
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

      {available &&
        (buckets.excludedNullReleaseCount > 0 || buckets.excludedNullInspectionCount > 0) && (
          <Card className="border-amber-500/40">
            <CardContent className="py-3 flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              <span>
                {buckets.excludedNullReleaseCount > 0 && (
                  <>
                    {buckets.excludedNullReleaseCount} structure
                    {buckets.excludedNullReleaseCount === 1 ? "" : "s"} excluded from Bucket B/C
                    (no Balance Release value).{" "}
                  </>
                )}
                {buckets.excludedNullInspectionCount > 0 && (
                  <>
                    {buckets.excludedNullInspectionCount} structure
                    {buckets.excludedNullInspectionCount === 1 ? "" : "s"} excluded from Bucket D
                    (no Inspection value).
                  </>
                )}
              </span>
            </CardContent>
          </Card>
        )}

      {/* Bucket A — computed from Order Review */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">A — {BUCKET_LABELS.a}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <BucketAPanel rows={bucketA} />
          )}
        </CardContent>
      </Card>

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

      {/* Bucket B */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">B — {BUCKET_LABELS.b}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <AutoBucketPanel
              rows={bRows}
              columns={BUCKET_B_COLUMNS}
              clampRelease={false}
              groupByMfc={groupByMfc}
              mfcColorMap={mfcColorMap}
              canEdit={canEdit}
              onSetMfcColor={setMfcColor}
              onClearMfcColor={clearMfcColor}
            />
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
            <AutoBucketPanel
              rows={cRows}
              columns={BUCKET_CD_COLUMNS}
              clampRelease
              groupByMfc={groupByMfc}
              mfcColorMap={mfcColorMap}
              canEdit={canEdit}
              onSetMfcColor={setMfcColor}
              onClearMfcColor={clearMfcColor}
            />
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
            <AutoBucketPanel
              rows={dRows}
              columns={BUCKET_CD_COLUMNS}
              clampRelease
              groupByMfc={groupByMfc}
              mfcColorMap={mfcColorMap}
              canEdit={canEdit}
              onSetMfcColor={setMfcColor}
              onClearMfcColor={clearMfcColor}
            />
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
            <ManualAddForm
              knownProjects={knownProjects}
              projectMfcBatches={projectMfcBatches}
              onAdd={addE}
              isPending={upsertE.isPending}
            />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ManualBucketSide
              side="in_house"
              entries={manualE}
              onDelete={removeE}
              canEdit={canEdit}
              deletingId={deletingEId}
              rawRows={rawRows}
              summary={manualEInHouseSummary}
              projectMfcBatches={projectMfcBatches}
            />
            <ManualBucketSide
              side="out_vendor"
              entries={manualE}
              onDelete={removeE}
              canEdit={canEdit}
              deletingId={deletingEId}
              rawRows={rawRows}
              summary={manualEOutVendorSummary}
              projectMfcBatches={projectMfcBatches}
            />
          </div>
        </CardContent>
      </Card>

      {!canEdit && (
        <p className="text-xs text-muted-foreground text-center">
          Sign in (Data page) to add or remove manual Bucket E entries.
        </p>
      )}
    </div>
  );
}
