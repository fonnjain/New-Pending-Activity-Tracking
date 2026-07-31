import { useMemo, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useTracker, useActiveJobSet, isNamedJobSetFilter, type MfcViewMode } from "@/lib/store";
import {
  useGetAuthStatus,
  useListInventoryManualE,
  useUpsertInventoryManualE,
  useDeleteInventoryManualE,
  useListInventoryMfcBatchColors,
  getListInventoryManualEQueryKey,
  getListInventoryMfcBatchColorsQueryKey,
  type InventoryManualEntry,
  type InventoryMfcBatchColor,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useInventoryData,
  BUCKET_LABELS,
  releaseBalanceDisplay,
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
  Square,
  CheckSquare,
  RotateCcw,
  X,
  Pencil,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsxSheets, type XlsxSheet, type XlsxSummaryRow } from "@/lib/export";

function mt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

type MfcColorName = "white" | "yellow" | "green" | "blue";

const MFC_COLOR_CSS: Record<MfcColorName, string> = {
  white: "#FFFFFF",
  yellow: "#FFFF00",
  green: "#92D050",
  blue: "#00B0F0",
};

const MFC_COLOR_ARGB: Record<MfcColorName, string> = {
  white: "FFFFFFFF",
  yellow: "FFFFFF00",
  green: "FF92D050",
  blue: "FF00B0F0",
};

const MFC_COLOR_LABEL: Record<MfcColorName, string> = {
  white: "White",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
};

const MFC_COLOR_NAMES: MfcColorName[] = ["white", "yellow", "green", "blue"];

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

/** Flat grouping: each unique {project}-{mfcBatch} pair becomes one top-level entry. */
function groupByProjectMfc(
  rows: InventoryStructureCard[],
): { key: string; project: string; mfcBatch: string; rows: InventoryStructureCard[] }[] {
  const map = new Map<string, { project: string; mfcBatch: string; rows: InventoryStructureCard[] }>();
  for (const r of rows) {
    const key = `${r.project}-${r.mfcBatch}`;
    if (!map.has(key)) map.set(key, { project: r.project, mfcBatch: r.mfcBatch, rows: [] });
    map.get(key)!.rows.push(r);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, ...v }));
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
  { key: "fab", label: "Fab", get: (r) => r.balFabMt },
  { key: "galva", label: "Galva", get: (r) => r.balGalvMt },
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

function ColorDot({ color, size = "sm" }: { color: MfcColorName; size?: "sm" | "md" }) {
  const px = size === "md" ? "w-3.5 h-3.5" : "w-2.5 h-2.5";
  return (
    <span
      className={`inline-block ${px} rounded-full shrink-0`}
      style={{
        background: MFC_COLOR_CSS[color],
        border: color === "white" ? "1px solid #9CA3AF" : "1px solid transparent",
      }}
      title={MFC_COLOR_LABEL[color]}
    />
  );
}

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

// Selection checklist shown inside each bucket card when delete mode is active.
function SelectionChecklist({
  rows,
  projects: projectsProp,
  selectedProjects,
  onToggle,
}: {
  rows?: InventoryStructureCard[];
  projects?: string[];
  selectedProjects: Set<string>;
  onToggle: (project: string) => void;
}) {
  const projects = useMemo(() => {
    if (projectsProp) return [...new Set(projectsProp)].sort();
    return [...new Set((rows ?? []).map((r) => r.project))].sort();
  }, [rows, projectsProp]);
  if (projects.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground italic border-b">
        No projects in this bucket.
      </div>
    );
  }
  const allSelected = projects.every((p) => selectedProjects.has(p));
  const someSelected = projects.some((p) => selectedProjects.has(p));
  const toggleAll = () => {
    if (allSelected) {
      projects.filter((p) => selectedProjects.has(p)).forEach(onToggle);
    } else {
      projects.filter((p) => !selectedProjects.has(p)).forEach(onToggle);
    }
  };
  return (
    <div className="px-3 pt-2 pb-3 border-b bg-destructive/5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Select projects to delete
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          {allSelected ? "Deselect all" : someSelected ? "Select all" : "Select all"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {projects.map((p) => {
          const checked = selectedProjects.has(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => onToggle(p)}
              className={[
                "flex items-center gap-1.5 px-2 py-1 rounded text-sm border transition-colors",
                checked
                  ? "border-destructive bg-destructive/10 text-destructive font-medium"
                  : "border-border hover:border-muted-foreground text-foreground",
              ].join(" ")}
            >
              {checked ? (
                <CheckSquare className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Square className="h-3.5 w-3.5 shrink-0" />
              )}
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Table shown at the bottom listing hidden projects with per-project restore.
function DeletedProjectsTable({
  entries,
  onRestore,
  onRestoreAll,
}: {
  entries: Array<{ project: string; bucketsWhenDeleted: string[] }>;
  onRestore: (project: string) => void;
  onRestoreAll: () => void;
}) {
  if (entries.length === 0) return null;
  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base text-muted-foreground">
            Deleted Projects ({entries.length})
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={onRestoreAll}
          >
            <RotateCcw className="h-3 w-3" /> Restore All
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Projects hidden from the buckets above. Restore to return them to their applicable
          bucket.
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <div className="divide-y">
          {entries.map(({ project, bucketsWhenDeleted }) => (
            <div key={project} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{project}</span>
                {bucketsWhenDeleted.length > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    Bucket {bucketsWhenDeleted.join(", ")}
                  </span>
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 shrink-0"
                onClick={() => onRestore(project)}
              >
                <RotateCcw className="h-3 w-3" /> Restore
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Bucket A: read-only computed panel. Groups qualifying structures by project,
// shows project name, MFC Batch (always "Z"), structure count, and Order Qty
// Weight (Col G). Color dot shown if a (project, "Z") colour entry exists.
function BucketAPanel({
  rows,
  mfcBatchColorMap,
}: {
  rows: InventoryStructureCard[];
  mfcBatchColorMap: Map<string, InventoryMfcBatchColor>;
}) {
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
        {groups.map((g) => {
          const colorEntry = mfcBatchColorMap.get(`${g.project}\u0001Z`);
          const colorName = colorEntry?.color as MfcColorName | undefined;
          return (
            <div
              key={g.project}
              className="flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/30"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                {colorName && colorName in MFC_COLOR_CSS && (
                  <ColorDot color={colorName} />
                )}
                <span className="font-medium truncate">{g.project}</span>
                <span className="shrink-0 text-[10px] font-medium px-1 py-px rounded border border-border/60 text-muted-foreground">
                  Z
                </span>
              </span>
              <span className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>
                  {g.count} structure{g.count === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums font-medium text-foreground">{mt(g.weightMt)} MT</span>
              </span>
            </div>
          );
        })}
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
  mfcBatchColorMap,
}: {
  group: ProjectGroup;
  columns: ColumnDef[];
  mfcBatchColorMap: Map<string, InventoryMfcBatchColor>;
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
          {mfcGroups.map(({ mfcBatch, rows: mfcRows }) => {
            const colorEntry = mfcBatchColorMap.get(`${group.project}\u0001${mfcBatch}`);
            const colorName = colorEntry?.color as MfcColorName | undefined;
            return (
              <div
                key={mfcBatch}
                className="flex items-center justify-between gap-2 px-2 py-1 text-xs border-t first:border-t-0"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {colorName && colorName in MFC_COLOR_CSS && (
                    <ColorDot color={colorName} />
                  )}
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
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Flat row for "Project Then MFC" view: shows "{project}-{mfcBatch}" as a single label. */
function ProjectMfcFlatRow({
  project,
  mfcBatch,
  rows,
  columns,
  mfcBatchColorMap,
}: {
  project: string;
  mfcBatch: string;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  mfcBatchColorMap: Map<string, InventoryMfcBatchColor>;
}) {
  const colorEntry = mfcBatchColorMap.get(`${project}\u0001${mfcBatch}`);
  const colorName = colorEntry?.color as MfcColorName | undefined;
  return (
    <div className="flex items-center justify-between px-3 py-1.5 text-sm gap-2 min-w-0 hover:bg-muted/30">
      <span className="flex items-center gap-1.5 min-w-0">
        {colorName && colorName in MFC_COLOR_CSS && <ColorDot color={colorName} />}
        <span className="font-medium truncate">
          {project}
          <span className="text-muted-foreground">-</span>
          {mfcBatch}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{rows.length} str</span>
      </span>
      <span className="flex items-center gap-3 shrink-0">
        {columns.map((col) => (
          <span key={col.key} className="text-[11px] tabular-nums text-right">
            <span className="text-muted-foreground mr-1">{col.label}</span>
            {mt(sumColumnOrNull(rows, col.get))}
          </span>
        ))}
      </span>
    </div>
  );
}

function MfcTopRow({
  mfcBatch,
  rows,
  columns,
  mfcBatchColorMap,
}: {
  mfcBatch: string;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  mfcBatchColorMap: Map<string, InventoryMfcBatchColor>;
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
          <span className="font-medium shrink-0">MFC {mfcBatch}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {projectGroups.length} proj &middot; {rows.length} str
          </span>
        </div>
        <span className="flex items-center gap-3 shrink-0 px-3 py-1.5">
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
          {projectGroups.map((g) => {
            const colorEntry = mfcBatchColorMap.get(`${g.project}\u0001${mfcBatch}`);
            const colorName = colorEntry?.color as MfcColorName | undefined;
            return (
              <div
                key={g.project}
                className="flex items-center border-t first:border-t-0 hover:bg-muted/20"
              >
                <div className="flex-1 flex items-center justify-between gap-2 px-3 py-1 text-xs min-w-0">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {colorName && colorName in MFC_COLOR_CSS && (
                      <ColorDot color={colorName} />
                    )}
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
            );
          })}
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
  mfcViewMode,
  mfcBatchColorMap,
}: {
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  clampRelease: boolean;
  mfcViewMode: MfcViewMode;
  mfcBatchColorMap: Map<string, InventoryMfcBatchColor>;
}) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mfcGroups = useMemo(() => groupByMfcBatch(rows), [rows]);
  const flatGroups = useMemo(() => groupByProjectMfc(rows), [rows]);
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
        ) : mfcViewMode === "view-by-mfc" ? (
          mfcGroups.map(({ mfcBatch, rows: mfcRows }) => (
            <MfcTopRow
              key={mfcBatch}
              mfcBatch={mfcBatch}
              rows={mfcRows}
              columns={columns}
              mfcBatchColorMap={mfcBatchColorMap}
            />
          ))
        ) : mfcViewMode === "project-then-mfc" ? (
          flatGroups.map(({ key, project, mfcBatch, rows: fRows }) => (
            <ProjectMfcFlatRow
              key={key}
              project={project}
              mfcBatch={mfcBatch}
              rows={fRows}
              columns={columns}
              mfcBatchColorMap={mfcBatchColorMap}
            />
          ))
        ) : (
          groups.map((g) => (
            <ProjectRow
              key={g.project}
              group={g}
              columns={columns}
              mfcBatchColorMap={mfcBatchColorMap}
            />
          ))
        )}
      </div>
      <SummaryFooter summary={summary} />
    </div>
  );
}

// ── Pre-Bucket B components ───────────────────────────────────────────────────
// Each (project, mfcBatch) pair shows an "Assign colour" CTA to clear the gate.

function PreBProjectRow({
  group,
  columns,
  onAssignColour,
  canAssign,
}: {
  group: ProjectGroup;
  columns: ColumnDef[];
  onAssignColour: (project: string, mfcBatch: string) => void;
  canAssign: boolean;
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
              className="flex items-center justify-between gap-2 px-2 py-1 text-xs border-t first:border-t-0 hover:bg-muted/20"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="shrink-0 text-[10px] font-medium px-1 py-px rounded border border-border/60 text-muted-foreground">
                  {mfcBatch}
                </span>
                <span className="text-muted-foreground shrink-0">{mfcRows.length} str</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                {columns.map((col) => (
                  <span key={col.key} className="tabular-nums text-right text-[11px]">
                    <span className="text-muted-foreground mr-1">{col.label}</span>
                    {mt(sumColumnOrNull(mfcRows, col.get))}
                  </span>
                ))}
                {canAssign && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px] px-2 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssignColour(group.project, mfcBatch);
                    }}
                  >
                    Assign colour
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreBMfcRow({
  mfcBatch,
  rows,
  columns,
  onAssignColour,
  canAssign,
}: {
  mfcBatch: string;
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  onAssignColour: (project: string, mfcBatch: string) => void;
  canAssign: boolean;
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
          <span className="font-medium shrink-0">MFC {mfcBatch}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {projectGroups.length} proj &middot; {rows.length} str
          </span>
        </div>
        <span className="flex items-center gap-3 shrink-0 px-3 py-1.5">
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
                <span className="flex items-center gap-2 shrink-0">
                  {columns.map((col) => (
                    <span key={col.key} className="tabular-nums text-right">
                      <span className="text-muted-foreground mr-1">{col.label}</span>
                      {mt(sumColumnOrNull(g.rows, col.get))}
                    </span>
                  ))}
                  {canAssign && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px] px-2 shrink-0"
                      onClick={() => onAssignColour(g.project, mfcBatch)}
                    >
                      Assign colour
                    </Button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreBucketBPanel({
  rows,
  columns,
  mfcViewMode,
  onAssignColour,
  canAssign,
}: {
  rows: InventoryStructureCard[];
  columns: ColumnDef[];
  mfcViewMode: MfcViewMode;
  onAssignColour: (project: string, mfcBatch: string) => void;
  canAssign: boolean;
}) {
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mfcGroups = useMemo(() => groupByMfcBatch(rows), [rows]);
  const flatGroups = useMemo(() => groupByProjectMfc(rows), [rows]);
  const pairCount = useMemo(
    () => new Set(rows.map((r) => `${r.project}\u0001${r.mfcBatch}`)).size,
    [rows],
  );
  const summary = useMemo(() => computeBucketSummary(rows, false), [rows]);

  return (
    <div className="border rounded-md">
      <div className="px-3 py-2 border-b bg-amber-50/40 dark:bg-amber-950/20 flex items-center justify-between gap-2">
        <span className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {pairCount} pair{pairCount !== 1 ? "s" : ""} awaiting colour assignment
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {rows.length} structure{rows.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="max-h-96 overflow-auto divide-y">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No structures — all pairs have colour + dates assigned.
          </div>
        ) : mfcViewMode === "view-by-mfc" ? (
          mfcGroups.map(({ mfcBatch, rows: mfcRows }) => (
            <PreBMfcRow
              key={mfcBatch}
              mfcBatch={mfcBatch}
              rows={mfcRows}
              columns={columns}
              onAssignColour={onAssignColour}
              canAssign={canAssign}
            />
          ))
        ) : mfcViewMode === "project-then-mfc" ? (
          // Flat: each pair is already the unit awaiting assignment — show directly.
          flatGroups.map(({ key, project, mfcBatch, rows: fRows }) => (
            <div
              key={key}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm hover:bg-muted/30 min-w-0"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium truncate">
                  {project}<span className="text-muted-foreground">-</span>{mfcBatch}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">{fRows.length} str</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                {columns.map((col) => (
                  <span key={col.key} className="tabular-nums text-right text-[11px]">
                    <span className="text-muted-foreground mr-1">{col.label}</span>
                    {mt(sumColumnOrNull(fRows, col.get))}
                  </span>
                ))}
                {canAssign && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px] px-2 shrink-0"
                    onClick={() => onAssignColour(project, mfcBatch)}
                  >
                    Assign colour
                  </Button>
                )}
              </span>
            </div>
          ))
        ) : (
          groups.map((g) => (
            <PreBProjectRow
              key={g.project}
              group={g}
              columns={columns}
              onAssignColour={onAssignColour}
              canAssign={canAssign}
            />
          ))
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

function ManualAddForm({
  knownProjects,
  projectMfcBatches,
  onAdd,
  isPending,
}: {
  knownProjects: string[];
  projectMfcBatches?: Map<string, string[]>;
  onAdd: (projectCode: string, mfcBatch: string) => void;
  isPending: boolean;
}) {
  const [projectCode, setProjectCode] = useState("");
  const [mfcBatch, setMfcBatch] = useState("");

  const handleProjectChange = (v: string | null) => {
    setProjectCode(v ?? "");
    setMfcBatch("");
  };

  const batchOptions = projectCode ? (projectMfcBatches?.get(projectCode) ?? []) : [];

  const submit = () => {
    const code = projectCode.trim();
    if (!code || !mfcBatch) return;
    onAdd(code, mfcBatch);
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
      <Button size="sm" className="h-8" disabled={!canSubmit} onClick={submit}>
        Add
      </Button>
    </div>
  );
}

// Sequential MFC Batch Colour entry form. Each field unlocks the next.
function MfcBatchColorForm({
  knownProjects,
  projectMfcBatches,
  onSave,
  isPending,
  initialProject,
  initialBatch,
}: {
  knownProjects: string[];
  projectMfcBatches: Map<string, string[]>;
  onSave: (entry: {
    project: string;
    mfcBatch: string;
    color: MfcColorName;
    dateOfClientMfc?: string;
    projectStartDate?: string;
  }) => void;
  isPending: boolean;
  initialProject?: string;
  initialBatch?: string;
}) {
  const [project, setProject] = useState(initialProject ?? "");
  const [mfcBatch, setMfcBatch] = useState(initialBatch ?? "");
  const [color, setColor] = useState<MfcColorName | "">("");
  const [dateOfClientMfc, setDateOfClientMfc] = useState("");
  const [projectStartDate, setProjectStartDate] = useState("");

  const batchOptions = useMemo(() => {
    if (!project) return [];
    const known = projectMfcBatches.get(project) ?? [];
    return known.includes("Z") ? known : [...known, "Z"];
  }, [project, projectMfcBatches]);

  const handleProjectChange = (v: string | null) => {
    setProject(v ?? "");
    setMfcBatch("");
    setColor("");
    setDateOfClientMfc("");
    setProjectStartDate("");
  };

  const handleBatchChange = (v: string | null) => {
    setMfcBatch(v ?? "");
    setColor("");
    setDateOfClientMfc("");
    setProjectStartDate("");
  };

  const handleColorSelect = (c: MfcColorName) => {
    setColor((prev) => (prev === c ? "" : c));
    setDateOfClientMfc("");
    setProjectStartDate("");
  };

  const canSubmit = !!project && !!mfcBatch && !!color && !isPending;

  const handleSubmit = () => {
    if (!project || !mfcBatch || !color) return;
    onSave({
      project,
      mfcBatch,
      color,
      dateOfClientMfc: dateOfClientMfc || undefined,
      projectStartDate: projectStartDate || undefined,
    });
    setProject("");
    setMfcBatch("");
    setColor("");
    setDateOfClientMfc("");
    setProjectStartDate("");
  };

  const step2Enabled = !!project;
  const step3Enabled = step2Enabled && !!mfcBatch;
  const step4Enabled = step3Enabled && !!color;
  const step5Enabled = step4Enabled;

  return (
    <div className="space-y-2 px-3 py-3 border-b">
      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">
        Add / Update Entry
      </p>
      {/* Step 1: Project */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground w-36 shrink-0">1. Project</span>
        <div className="w-52">
          <SearchableSelect
            value={project || null}
            onChange={handleProjectChange}
            options={knownProjects}
            allLabel="Select project..."
          />
        </div>
      </div>
      {/* Step 2: MFC Batch */}
      <div className="flex items-center gap-2">
        <span className={`text-xs w-36 shrink-0 ${step2Enabled ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
          2. MFC Batch
        </span>
        <div className="w-52">
          <SearchableSelect
            value={mfcBatch || null}
            onChange={handleBatchChange}
            options={batchOptions.length > 0 ? batchOptions : ["Z"]}
            allLabel={step2Enabled ? "Select batch..." : "Select project first"}
            disabled={!step2Enabled}
          />
        </div>
      </div>
      {/* Step 3: Colour */}
      <div className="flex items-center gap-2">
        <span className={`text-xs w-36 shrink-0 ${step3Enabled ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
          3. Colour
        </span>
        <div className="flex items-center gap-1.5">
          {MFC_COLOR_NAMES.map((c) => {
            const active = color === c;
            return (
              <button
                key={c}
                type="button"
                title={MFC_COLOR_LABEL[c]}
                disabled={!step3Enabled}
                onClick={() => handleColorSelect(c)}
                style={{
                  background: MFC_COLOR_CSS[c],
                  border: active
                    ? "2.5px solid #1F2937"
                    : c === "white"
                      ? "1px solid #9CA3AF"
                      : "1px solid transparent",
                  opacity: !step3Enabled ? 0.35 : 1,
                }}
                className="w-6 h-6 rounded-full cursor-pointer disabled:cursor-not-allowed"
              />
            );
          })}
          {color && (
            <span className="text-xs text-muted-foreground ml-1">
              {MFC_COLOR_LABEL[color]}
            </span>
          )}
        </div>
      </div>
      {/* Step 4: Date of Client MFC */}
      <div className="flex items-center gap-2">
        <span className={`text-xs w-36 shrink-0 ${step4Enabled ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
          4. Date of Client MFC
        </span>
        <input
          type="date"
          value={dateOfClientMfc}
          onChange={(e) => setDateOfClientMfc(e.target.value)}
          disabled={!step4Enabled}
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
        {dateOfClientMfc && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDateOfClientMfc("")}
          >
            Clear
          </button>
        )}
      </div>
      {/* Step 5: Project Start Date */}
      <div className="flex items-center gap-2">
        <span className={`text-xs w-36 shrink-0 ${step5Enabled ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
          5. Project Start Date
        </span>
        <input
          type="date"
          value={projectStartDate}
          onChange={(e) => setProjectStartDate(e.target.value)}
          disabled={!step5Enabled}
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
        {projectStartDate && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setProjectStartDate("")}
          >
            Clear
          </button>
        )}
      </div>
      <div className="pt-1">
        <Button size="sm" className="h-8" disabled={!canSubmit} onClick={handleSubmit}>
          {isPending ? "Saving..." : "Save"}
        </Button>
        <span className="text-[11px] text-muted-foreground ml-2">
          Fields 4 and 5 are optional
        </span>
      </div>
    </div>
  );
}

function formatDateDisplay(d: string | null | undefined): string {
  if (!d) return "-";
  const parts = d.split("-");
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return d;
}

// Management table listing all stored (project, mfcBatch) colour entries.
function MfcBatchColorTable({
  entries,
  canEdit,
  onDelete,
  onSave,
  deletingKey,
  isSaving,
}: {
  entries: InventoryMfcBatchColor[];
  canEdit: boolean;
  onDelete: (project: string, mfcBatch: string) => void;
  onSave: (entry: { project: string; mfcBatch: string; color: MfcColorName; dateOfClientMfc?: string; projectStartDate?: string }) => void;
  deletingKey: string | null;
  isSaving: boolean;
}) {
  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground border-t">
        No colour entries saved yet.
      </div>
    );
  }

  const sorted = [...entries].sort((a, b) =>
    a.project.localeCompare(b.project) || a.mfcBatch.localeCompare(b.mfcBatch),
  );

  return (
    <div className="border-t overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Project</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">MFC Batch</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Colour</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Date of Client MFC</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Project Start Date</th>
            {canEdit && <th className="px-2 py-2 w-16" />}
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((e) => {
            const key = `${e.project}\u0001${e.mfcBatch}`;
            return (
              <MfcBatchColorRow
                key={key}
                entry={e}
                canEdit={canEdit}
                isDeleting={deletingKey === key}
                isSaving={isSaving}
                onDelete={onDelete}
                onSave={onSave}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MfcBatchColorRow({
  entry,
  canEdit,
  isDeleting,
  isSaving,
  onDelete,
  onSave,
}: {
  entry: InventoryMfcBatchColor;
  canEdit: boolean;
  isDeleting: boolean;
  isSaving: boolean;
  onDelete: (project: string, mfcBatch: string) => void;
  onSave: (entry: { project: string; mfcBatch: string; color: MfcColorName; dateOfClientMfc?: string; projectStartDate?: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState<MfcColorName>(entry.color as MfcColorName);
  const [mfcDate, setMfcDate] = useState(entry.dateOfClientMfc ?? "");
  const [startDate, setStartDate] = useState(entry.projectStartDate ?? "");

  const handleEdit = () => {
    setColor(entry.color as MfcColorName);
    setMfcDate(entry.dateOfClientMfc ?? "");
    setStartDate(entry.projectStartDate ?? "");
    setEditing(true);
  };

  const handleSave = () => {
    onSave({
      project: entry.project,
      mfcBatch: entry.mfcBatch,
      color,
      dateOfClientMfc: mfcDate || undefined,
      projectStartDate: startDate || undefined,
    });
    setEditing(false);
  };

  const colorName = entry.color as MfcColorName;

  return (
    <tr className="hover:bg-muted/20">
      <td className="px-3 py-1.5 font-medium">{entry.project}</td>
      <td className="px-3 py-1.5">
        <span className="text-[10px] font-medium px-1 py-px rounded border border-border/60 text-muted-foreground">
          {entry.mfcBatch}
        </span>
      </td>

      {editing ? (
        <>
          {/* Colour picker */}
          <td className="px-3 py-1.5">
            <div className="flex gap-1 flex-wrap">
              {MFC_COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={MFC_COLOR_LABEL[c]}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors
                    ${color === c
                      ? "border-primary bg-primary/10 font-semibold"
                      : "border-border/60 hover:bg-muted/40"}`}
                >
                  <ColorDot color={c} size="md" />
                  {MFC_COLOR_LABEL[c]}
                </button>
              ))}
            </div>
          </td>
          {/* Date of Client MFC */}
          <td className="px-3 py-1.5">
            <input
              type="date"
              value={mfcDate}
              onChange={(e) => setMfcDate(e.target.value)}
              className="h-7 rounded border border-border bg-background px-2 text-xs w-36"
            />
          </td>
          {/* Project Start Date */}
          <td className="px-3 py-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-7 rounded border border-border bg-background px-2 text-xs w-36"
            />
          </td>
          {canEdit && (
            <td className="px-2 py-1.5">
              <div className="flex gap-1">
                <Button size="sm" className="h-6 text-[11px] px-2" onClick={handleSave} disabled={isSaving}>
                  Save
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </td>
          )}
        </>
      ) : (
        <>
          <td className="px-3 py-1.5">
            <span className="flex items-center gap-1.5">
              {colorName in MFC_COLOR_CSS && <ColorDot color={colorName} size="md" />}
              <span>{MFC_COLOR_LABEL[colorName] ?? colorName}</span>
            </span>
          </td>
          <td className="px-3 py-1.5 text-muted-foreground">
            {formatDateDisplay(entry.dateOfClientMfc)}
          </td>
          <td className="px-3 py-1.5 text-muted-foreground">
            {formatDateDisplay(entry.projectStartDate)}
          </td>
          {canEdit && (
            <td className="px-2 py-1.5">
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleEdit}
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={isDeleting}
                  onClick={() => onDelete(entry.project, entry.mfcBatch)}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </td>
          )}
        </>
      )}
    </tr>
  );
}

export default function InventoryView() {
  const [, navigate] = useLocation();
  const { filters, mfcViewMode, setMfcViewMode } = useTracker();
  const queryClient = useQueryClient();
  const { available, asOnDate, isLoading, rawRows, buckets, manualE, projectMfcBatches } =
    useInventoryData();
  const { data: authStatus } = useGetAuthStatus();
  const canEdit = !!authStatus?.authenticated;
  const { toast } = useToast();

  const jobFilter = filters.job;
  const isCurrentJobs = isNamedJobSetFilter(jobFilter);
  const activeJobSet = useActiveJobSet();

  const applyJobFilter = (rows: InventoryStructureCard[]): InventoryStructureCard[] => {
    let out = rows;
    if (isCurrentJobs) out = out.filter((r) => activeJobSet.has(r.project));
    else if (jobFilter) out = out.filter((r) => r.project === jobFilter);
    return out;
  };

  // MFC batch colour assignments — keyed by "project\u0001mfcBatch".
  const { data: mfcBatchColors = [] } = useListInventoryMfcBatchColors();

  // Pre-B gate (CHANGE 2): colour alone is sufficient to leave Pre-Bucket B.
  // The two dates (dateOfClientMfc, projectStartDate) are informational only
  // and must NOT block bucket movement — they can be filled in later via the
  // "Bucket List" tab on the Data page.
  const colourCompleteKeys = useMemo(() => {
    const set = new Set<string>();
    for (const c of mfcBatchColors) {
      if (c.color) {
        set.add(`${c.project}\u0001${c.mfcBatch}`);
      }
    }
    return set;
  }, [mfcBatchColors]);

  // "Assign colour" CTA navigates to the Bucket List Dates tab under Data page.
  const handleAssignColour = useCallback(() => {
    navigate("~/production/bucket-list-dates");
  }, [navigate]);

  const mfcBatchColorMap = useMemo(
    () => new Map(mfcBatchColors.map((c) => [`${c.project}\u0001${c.mfcBatch}`, c])),
    [mfcBatchColors],
  );

  // ── Client-side project hide/restore (no DB writes) ────────────────────────
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [deletedProjects, setDeletedProjects] = useState<
    Array<{ project: string; bucketsWhenDeleted: string[] }>
  >([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const deletedProjectSet = useMemo(
    () => new Set(deletedProjects.map((d) => d.project)),
    [deletedProjects],
  );

  const toggleProjectSelection = useCallback((project: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const startDeleteMode = useCallback(() => {
    setIsDeleteMode(true);
    setSelectedProjects(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const cancelDeleteMode = useCallback(() => {
    setIsDeleteMode(false);
    setSelectedProjects(new Set());
    setShowDeleteConfirm(false);
  }, []);

  // Raw (job-filtered) arrays — not affected by deletion hide; used for
  // determining which bucket a restored project returns to.
  //
  // CHANGE 1: ALL B/C/D rows go through the Pre-B gate, not just B rows.
  // A structure only reaches B, C, or D once its (project, mfcBatch) has a
  // colour assigned.  Until then it sits in Pre-Bucket B.
  // Bucket A is unchanged.
  const bucketA_raw = applyJobFilter(buckets.a);
  const hasColour = (r: InventoryStructureCard) =>
    colourCompleteKeys.has(`${r.project}\u0001${r.mfcBatch}`);
  // Full B/C/D pools before the gate (used by restore/delete logic).
  const allBRows_raw = applyJobFilter(buckets.b);
  const allCRows_raw = applyJobFilter(buckets.c);
  const allDRows_raw = applyJobFilter(buckets.d);
  // Colour-gated splits: no colour → Pre-B; colour → destination bucket.
  const preBRows_raw = [
    ...allBRows_raw.filter((r) => !hasColour(r)),
    ...allCRows_raw.filter((r) => !hasColour(r)),
    ...allDRows_raw.filter((r) => !hasColour(r)),
  ];
  const bRows_raw = allBRows_raw.filter(hasColour);
  const cRows_raw = allCRows_raw.filter(hasColour);
  const dRows_raw = allDRows_raw.filter(hasColour);

  // Display arrays — hidden projects removed.
  const bucketA = bucketA_raw.filter((r) => !deletedProjectSet.has(r.project));
  const allBRows = allBRows_raw.filter((r) => !deletedProjectSet.has(r.project));
  const preBRows = preBRows_raw.filter((r) => !deletedProjectSet.has(r.project));
  const bRows = bRows_raw.filter((r) => !deletedProjectSet.has(r.project));
  const cRows = cRows_raw.filter((r) => !deletedProjectSet.has(r.project));
  const dRows = dRows_raw.filter((r) => !deletedProjectSet.has(r.project));
  // Bucket E is manual — filter by projectCode.
  const manualE_display = manualE.filter((e) => !deletedProjectSet.has(e.projectCode));

  const confirmDelete = useCallback(() => {
    const alreadyDeleted = new Set(deletedProjects.map((d) => d.project));
    const toDelete = [...selectedProjects].filter((p) => !alreadyDeleted.has(p));
    const newEntries = toDelete.map((project) => {
      const inBuckets: string[] = [];
      if (bucketA_raw.some((r) => r.project === project)) inBuckets.push("A");
      if (preBRows_raw.some((r) => r.project === project)) inBuckets.push("Pre-B");
      if (bRows_raw.some((r) => r.project === project)) inBuckets.push("B");
      if (cRows_raw.some((r) => r.project === project)) inBuckets.push("C");
      if (dRows_raw.some((r) => r.project === project)) inBuckets.push("D");
      if (manualE.some((e) => e.projectCode === project)) inBuckets.push("E");
      return { project, bucketsWhenDeleted: inBuckets };
    });
    setDeletedProjects((prev) => [...prev, ...newEntries]);
    setSelectedProjects(new Set());
    setShowDeleteConfirm(false);
    setIsDeleteMode(false);
  }, [selectedProjects, deletedProjects, bucketA_raw, preBRows_raw, bRows_raw, cRows_raw, dRows_raw, manualE]);

  const restoreProject = useCallback(
    (project: string) => {
      setDeletedProjects((prev) => prev.filter((d) => d.project !== project));
      const willBe: string[] = [];
      if (bucketA_raw.some((r) => r.project === project)) willBe.push("A");
      if (preBRows_raw.some((r) => r.project === project)) willBe.push("Pre-B");
      if (bRows_raw.some((r) => r.project === project)) willBe.push("B");
      if (cRows_raw.some((r) => r.project === project)) willBe.push("C");
      if (dRows_raw.some((r) => r.project === project)) willBe.push("D");
      if (manualE.some((e) => e.projectCode === project)) willBe.push("E");
      const dest = willBe.length > 0 ? `Bucket ${willBe.join(", ")}` : "no bucket (data may have changed)";
      toast({ title: "Project restored", description: `${project} returned to ${dest}` });
    },
    [bucketA_raw, preBRows_raw, bRows_raw, cRows_raw, dRows_raw, manualE, toast],
  );

  const restoreAll = useCallback(() => {
    setDeletedProjects([]);
    toast({ title: "All projects restored" });
  }, [toast]);

  const knownProjects = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.project);
    return Array.from(set).sort();
  }, [rawRows]);

  // Reminder: projects with stored colour entries no longer in Bucket A.
  const bucketAProjectSet = useMemo(
    () => new Set(buckets.a.map((r) => r.project)),
    [buckets.a],
  );
  const upsertE = useUpsertInventoryManualE();
  const deleteE = useDeleteInventoryManualE();
  const [deletingEId, setDeletingEId] = useState<number | null>(null);

  const addE = (projectCode: string, mfcBatch: string) => {
    upsertE.mutate(
      { data: { projectCode, side: "in_house", mfcBatch } },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getListInventoryManualEQueryKey() }),
      },
    );
  };

  const manualESummary = useMemo(
    () =>
      computeManualESummary(
        manualE_display.map((e) =>
          aggregateProjectColumns(rawRows, e.projectCode, e.mfcBatch ?? undefined),
        ),
      ),
    [manualE_display, rawRows],
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
    if (isCurrentJobs) out = out.filter((e) => activeJobSet.has(e.projectCode));
    else if (jobFilter) out = out.filter((e) => e.projectCode === jobFilter);
    return out;
  };

  // Build per-(project, mfcBatch) rows for export sheets.
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
        // Look up colour by (project, mfcBatch) pair.
        const colorEntry = mfcBatchColorMap.get(key);
        const colorName = colorEntry?.color as MfcColorName | undefined;
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
          { label: "MFC Batch", field: "mfcBatch" },
          { label: "Colour", field: "colour" },
          { label: "Date of Client MFC", field: "dateOfClientMfc" },
          { label: "Project Start Date", field: "projectStartDate" },
          { label: "Structures", field: "structures", numeric: true, decimals: 0 },
          { label: "Order Qty (MT)", field: "orderQtyMt", numeric: true, decimals: 3, total: true },
        ],
        rows: bucketAGroups.map((g) => {
          const colorEntry = mfcBatchColorMap.get(`${g.project}\u0001Z`);
          const colorName = colorEntry?.color as MfcColorName | undefined;
          return {
            project: g.project,
            mfcBatch: "Z",
            colour: colorName ? MFC_COLOR_LABEL[colorName] : "",
            dateOfClientMfc: colorEntry?.dateOfClientMfc ?? "",
            projectStartDate: colorEntry?.projectStartDate ?? "",
            structures: g.count,
            orderQtyMt: g.weightMt,
            ...(colorName && colorName in MFC_COLOR_ARGB
              ? { _bgColor: MFC_COLOR_ARGB[colorName] }
              : {}),
          };
        }),
      },
      autoBucketSheet(
        "Pre-B - Awaiting Colour Assign",
        preBRows,
        BUCKET_B_COLUMNS,
        false,
        mfcViewMode === "view-by-mfc",
      ),
      autoBucketSheet(
        "B - Raw Material Incomplete",
        bRows,
        BUCKET_B_COLUMNS,
        false,
        mfcViewMode === "view-by-mfc",
      ),
      autoBucketSheet("C - RM Complete", cRows, BUCKET_CD_COLUMNS, true, mfcViewMode === "view-by-mfc"),
      autoBucketSheet("D - Dispatch Clearance", dRows, BUCKET_CD_COLUMNS, true, mfcViewMode === "view-by-mfc"),
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
    void exportToXlsxSheets(`inventory_${baseTag}_${date}.xlsx`, sheets)
      .catch((err) => {
        console.error("[Export] inventory failed", err);
        toast({ title: "Export failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      });
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
          {isDeleteMode ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2"
                onClick={cancelDeleteMode}
              >
                <X className="h-4 w-4" /> Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-2"
                disabled={selectedProjects.size === 0}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4" />
                Delete Selected ({selectedProjects.size})
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2"
                onClick={handleExport}
                disabled={isLoading}
              >
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2"
                onClick={startDeleteMode}
              >
                <Trash2 className="h-4 w-4" /> Start Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {showDeleteConfirm && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <span className="text-sm">
              Hide{" "}
              <span className="font-semibold">
                {selectedProjects.size} project{selectedProjects.size === 1 ? "" : "s"}
              </span>{" "}
              from all buckets? They can be restored at the bottom of the page.
            </span>
            <div className="flex gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" className="h-7" onClick={confirmDelete}>
                Confirm Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isCurrentJobs && activeJobSet.size === 0 && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              This job template is empty — it matches no projects. Add projects to it on the Job Templates page.
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
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              rows={bucketA_raw.filter((r) => !deletedProjectSet.has(r.project))}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <BucketAPanel rows={bucketA} mfcBatchColorMap={mfcBatchColorMap} />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Pre-Bucket B — qualifies for B but colour + dates not yet assigned */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pre-B — {BUCKET_LABELS.preB}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              rows={preBRows_raw.filter((r) => !deletedProjectSet.has(r.project))}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <PreBucketBPanel
                rows={preBRows}
                columns={BUCKET_B_COLUMNS}
                mfcViewMode={mfcViewMode}
                onAssignColour={handleAssignColour}
                canAssign={canEdit}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bucket B */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">B — {BUCKET_LABELS.b}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              rows={bRows_raw.filter((r) => !deletedProjectSet.has(r.project))}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <AutoBucketPanel
                rows={bRows}
                columns={BUCKET_B_COLUMNS}
                clampRelease={false}
                mfcViewMode={mfcViewMode}
                mfcBatchColorMap={mfcBatchColorMap}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bucket C */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">C — {BUCKET_LABELS.c}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              rows={cRows_raw.filter((r) => !deletedProjectSet.has(r.project))}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <AutoBucketPanel
                rows={cRows}
                columns={BUCKET_CD_COLUMNS}
                clampRelease
                mfcViewMode={mfcViewMode}
                mfcBatchColorMap={mfcBatchColorMap}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bucket D */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">D — {BUCKET_LABELS.d}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              rows={dRows_raw.filter((r) => !deletedProjectSet.has(r.project))}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3">
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : (
              <AutoBucketPanel
                rows={dRows}
                columns={BUCKET_CD_COLUMNS}
                clampRelease
                mfcViewMode={mfcViewMode}
                mfcBatchColorMap={mfcBatchColorMap}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bucket E */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">E — {BUCKET_LABELS.e}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isDeleteMode && (
            <SelectionChecklist
              projects={manualE
                .filter((e) => !deletedProjectSet.has(e.projectCode))
                .map((e) => e.projectCode)}
              selectedProjects={selectedProjects}
              onToggle={toggleProjectSelection}
            />
          )}
          <div className="px-3 pb-3 pt-3 space-y-3">
            {canEdit && (
              <ManualAddForm
                knownProjects={knownProjects}
                projectMfcBatches={projectMfcBatches}
                onAdd={addE}
                isPending={upsertE.isPending}
              />
            )}
            <div className="border rounded-md">
              <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide">Projects</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {manualE_display.length} project{manualE_display.length === 1 ? "" : "s"}
                </span>
              </div>
              <ManualEntryList
                entries={manualE_display}
                onDelete={removeE}
                canEdit={canEdit}
                deletingId={deletingEId}
                rawRows={rawRows}
                projectMfcBatches={projectMfcBatches}
              />
              {manualESummary && <SummaryFooter summary={manualESummary} />}
            </div>
          </div>
        </CardContent>
      </Card>

      {!canEdit && (
        <p className="text-xs text-muted-foreground text-center">
          Sign in (Data page) to add or remove manual Bucket E entries and manage MFC Batch
          Colours.
        </p>
      )}

      {/* Deleted Projects — client-side hide only, no DB writes */}
      <DeletedProjectsTable
        entries={deletedProjects}
        onRestore={restoreProject}
        onRestoreAll={restoreAll}
      />
    </div>
  );
}
