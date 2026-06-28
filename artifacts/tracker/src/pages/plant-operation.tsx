import { useMemo, useState } from "react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { formatWeight } from "@/lib/utils";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import { ChevronDown, FileSpreadsheet } from "lucide-react";
import { bundleActivitySet, compareActivity, sortActivities, getActivityBundle, TLT_OPERATION_BUNDLE_IDS } from "@workspace/domain";

// Activity scopes for each plant operation, sliced from the canonical bundles in
// @workspace/domain (single source of truth). Display/aggregation only — this is
// a new lens over existing records; it never changes parsing, ageing, dedup,
// classification, qty, or alert math.
const FAB_SET = bundleActivitySet("TLT_FABRICATION") ?? new Set<string>();
const GALVA_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();

const HOLE_OP_LABELS: Record<string, string> = {
  PUNCHING: "Punching",
  DRILLING: "Drilling",
  NOT_SET: "Not set",
};

const ROW_CAP = 300;

type HoleOpFilter = "ALL" | "PUNCHING" | "DRILLING" | "NOT_SET";

function holeOpOf(r: any): "PUNCHING" | "DRILLING" | "NOT_SET" {
  const op = r.holeOperation;
  return op === "PUNCHING" || op === "DRILLING" ? op : "NOT_SET";
}

interface Rollup {
  marks: number;
  qty: number;
  weight: number;
  avgAge: number | null;
}

function rollup(recs: any[]): Rollup {
  const withAge = recs.filter((r) => r.ageingDays !== null);
  return {
    marks: recs.length,
    qty: recs.reduce((s, r) => s + r.balanceQty, 0),
    weight: recs.reduce((s, r) => s + r.balanceWt, 0),
    avgAge: withAge.length
      ? Math.round(withAge.reduce((s, r) => s + r.ageingDays, 0) / withAge.length)
      : null,
  };
}

// Project -> Contractor grouping. Returns projects sorted by weight desc, each
// with its contractors sorted by weight desc.
function groupProjectContractor(records: any[]) {
  const projMap = new Map<string, any[]>();
  for (const r of records) {
    const j = r.job || "(Unassigned)";
    if (!projMap.has(j)) projMap.set(j, []);
    projMap.get(j)!.push(r);
  }
  const projects = Array.from(projMap.entries()).map(([project, recs]) => {
    const conMap = new Map<string, any[]>();
    for (const r of recs) {
      const c = r.contractor || "Unassigned";
      if (!conMap.has(c)) conMap.set(c, []);
      conMap.get(c)!.push(r);
    }
    const contractors = Array.from(conMap.entries())
      .map(([name, crecs]) => ({ name, records: crecs, stats: rollup(crecs) }))
      .sort((a, b) => b.stats.weight - a.stats.weight);
    return { project, records: recs, stats: rollup(recs), contractors };
  });
  return projects.sort((a, b) => b.stats.weight - a.stats.weight);
}

export default function PlantOperationView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <PlantOperationContent />;
}

function PlantOperationContent() {
  const { selectedImportId, filters } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });
  const records = useFilteredRecords(allRecords);
  const isTlt = filters.category === "TLT";

  return (
    <Tabs defaultValue="fabrication" className="space-y-4">
      <TabsList className="h-10">
        <TabsTrigger value="fabrication" className="px-6">Fabrication</TabsTrigger>
        <TabsTrigger value="galvanization" className="px-6">Galvanization</TabsTrigger>
      </TabsList>
      <TabsContent value="fabrication">
        {isTlt ? <FabricationTab records={records} /> : <ComingSoon />}
      </TabsContent>
      <TabsContent value="galvanization">
        {isTlt ? <GalvanizationTab records={records} /> : <ComingSoon />}
      </TabsContent>
    </Tabs>
  );
}

function ComingSoon() {
  return (
    <Card>
      <CardContent className="p-10 text-center space-y-2">
        <p className="text-lg font-semibold">Coming soon</p>
        <p className="text-sm text-muted-foreground">
          Plant Operation views are currently built for TLT only. Switch Order Type to TLT
          to see fabrication and galvanizing grouped by project and contractor.
        </p>
      </CardContent>
    </Card>
  );
}

function SummaryTile({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{title}</p>
        <p className="text-sm sm:text-base font-medium tracking-tight">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fabrication
// ---------------------------------------------------------------------------

// Operation group tabs shown under Fabrication: All + the three TLT operation
// sub-bundles. Presentation filter over the fabrication scope only — never
// changes ageing, warnings, the fabrication-load report, or the bundle scopes.
const OP_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All" },
  ...TLT_OPERATION_BUNDLE_IDS.map((id) => ({
    value: id,
    label: getActivityBundle(id)!.label.replace(" (TLT)", ""),
  })),
];

function FabricationTab({ records }: { records: any[] }) {
  const [opFilter, setOpFilter] = useState<HoleOpFilter>("ALL");
  const [group, setGroup] = useState<string>("ALL");
  const groupSet = group === "ALL" ? null : bundleActivitySet(group);

  const scope = useMemo(() => {
    const base = records.filter((r) => FAB_SET.has((r.activity ?? "").toUpperCase()));
    return groupSet
      ? base.filter((r) => groupSet.has((r.activity ?? "").toUpperCase()))
      : base;
  }, [records, groupSet]);

  // Punching / Drilling / Not set split over the full fabrication scope (always
  // shows the complete split, independent of the local op filter).
  const split = useMemo(() => {
    const c = {
      PUNCHING: { marks: 0, weight: 0 },
      DRILLING: { marks: 0, weight: 0 },
      NOT_SET: { marks: 0, weight: 0 },
    };
    for (const r of scope) {
      const op = holeOpOf(r);
      c[op].marks += 1;
      c[op].weight += r.balanceWt;
    }
    return c;
  }, [scope]);

  // Per-activity counts within fabrication, ordered by the TLT process sequence.
  const actCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of scope) {
      const a = r.activity || "?";
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return sortActivities(Array.from(m.keys())).map((a) => ({ a, n: m.get(a)! }));
  }, [scope]);

  const displayed = useMemo(
    () => (opFilter === "ALL" ? scope : scope.filter((r) => holeOpOf(r) === opFilter)),
    [scope, opFilter],
  );

  const projects = useMemo(() => groupProjectContractor(displayed), [displayed]);
  const total = useMemo(() => rollup(displayed), [displayed]);

  const handleExport = () => {
    const rows = projects.flatMap((p) =>
      p.contractors.map((c) => {
        const s = { PUNCHING: 0, DRILLING: 0, NOT_SET: 0 };
        for (const r of c.records) s[holeOpOf(r)] += 1;
        return {
          project: p.project,
          contractor: c.name,
          marks: c.stats.marks,
          qty: c.stats.qty,
          weight: c.stats.weight,
          avgAge: c.stats.avgAge,
          punching: s.PUNCHING,
          drilling: s.DRILLING,
          notSet: s.NOT_SET,
        };
      }),
    );
    const columns: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Contractor", field: "contractor" },
      { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
      { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
      { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
      { label: "Avg Ageing (days)", field: "avgAge", numeric: true, decimals: 0 },
      { label: "Punching", field: "punching", numeric: true, decimals: 0, total: true },
      { label: "Drilling", field: "drilling", numeric: true, decimals: 0, total: true },
      { label: "Not Set", field: "notSet", numeric: true, decimals: 0, total: true },
    ];
    exportToXlsx("plant-operation-fabrication.xlsx", columns, rows, { sheetName: "Fabrication" });
  };

  return (
    <div className="space-y-4">
      <Segmented
        value={group}
        onChange={(v) => setGroup(v ?? "ALL")}
        options={OP_GROUP_OPTIONS}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile title="Fabrication Marks" value={total.marks.toLocaleString()} sub={formatWeight(total.weight)} />
        <SummaryTile title="Punching" value={split.PUNCHING.marks.toLocaleString()} sub={formatWeight(split.PUNCHING.weight)} />
        <SummaryTile title="Drilling" value={split.DRILLING.marks.toLocaleString()} sub={formatWeight(split.DRILLING.weight)} />
        <SummaryTile title="Not Set" value={split.NOT_SET.marks.toLocaleString()} sub={formatWeight(split.NOT_SET.weight)} />
      </div>

      {actCounts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actCounts.map(({ a, n }) => (
            <span key={a} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs">
              <span className="font-semibold">{a}</span>
              <span className="text-muted-foreground">{n.toLocaleString()}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">Hole Operation</span>
          <Segmented
            value={opFilter}
            onChange={(v) => setOpFilter((v as HoleOpFilter) ?? "ALL")}
            options={[
              { value: "ALL", label: "All" },
              { value: "PUNCHING", label: "Punching" },
              { value: "DRILLING", label: "Drilling" },
              { value: "NOT_SET", label: "Not set" },
            ]}
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={projects.length === 0}>
          <FileSpreadsheet className="h-4 w-4" />
          Export Excel
        </Button>
      </div>

      {projects.map((p) => (
        <ProjectGroup key={p.project} project={p} mode="fab" />
      ))}
      {projects.length === 0 && (
        <div className="text-center p-8 text-muted-foreground">No fabrication marks match the current filters.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Galvanization
// ---------------------------------------------------------------------------

function GalvanizationTab({ records }: { records: any[] }) {
  const scope = useMemo(
    () => records.filter((r) => GALVA_SET.has((r.activity ?? "").toUpperCase())),
    [records],
  );

  const total = useMemo(() => rollup(scope), [scope]);

  const thickness = useMemo(() => {
    let set = 0;
    let notSet = 0;
    let setWt = 0;
    let notSetWt = 0;
    for (const r of scope) {
      if (r.thicknessMm != null) {
        set += 1;
        setWt += r.balanceWt;
      } else {
        notSet += 1;
        notSetWt += r.balanceWt;
      }
    }
    return { set, notSet, setWt, notSetWt };
  }, [scope]);

  const projects = useMemo(() => groupProjectContractor(scope), [scope]);

  const handleExport = () => {
    const rows = projects.flatMap((p) =>
      p.contractors.map((c) => {
        let tset = 0;
        let tnot = 0;
        for (const r of c.records) {
          if (r.thicknessMm != null) tset += 1;
          else tnot += 1;
        }
        return {
          project: p.project,
          contractor: c.name,
          marks: c.stats.marks,
          qty: c.stats.qty,
          weight: c.stats.weight,
          avgAge: c.stats.avgAge,
          thicknessSet: tset,
          thicknessNotSet: tnot,
        };
      }),
    );
    const columns: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Contractor", field: "contractor" },
      { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
      { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
      { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
      { label: "Avg Ageing (days)", field: "avgAge", numeric: true, decimals: 0 },
      { label: "Thickness Set", field: "thicknessSet", numeric: true, decimals: 0, total: true },
      { label: "Thickness Not Set", field: "thicknessNotSet", numeric: true, decimals: 0, total: true },
    ];
    exportToXlsx("plant-operation-galvanization.xlsx", columns, rows, { sheetName: "Galvanization" });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile title="Galvanizing Marks" value={total.marks.toLocaleString()} sub={formatWeight(total.weight)} />
        <SummaryTile title="Balance Qty" value={total.qty.toLocaleString()} />
        <SummaryTile title="Thickness Set" value={thickness.set.toLocaleString()} sub={formatWeight(thickness.setWt)} />
        <SummaryTile title="Thickness Not Set" value={thickness.notSet.toLocaleString()} sub={formatWeight(thickness.notSetWt)} />
      </div>

      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={projects.length === 0}>
          <FileSpreadsheet className="h-4 w-4" />
          Export Excel
        </Button>
      </div>

      {projects.map((p) => (
        <ProjectGroup key={p.project} project={p} mode="galva" />
      ))}
      {projects.length === 0 && (
        <div className="text-center p-8 text-muted-foreground">No galvanizing marks match the current filters.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared project -> contractor group renderer
// ---------------------------------------------------------------------------

type GroupMode = "fab" | "galva";

interface ProjectNode {
  project: string;
  records: any[];
  stats: Rollup;
  contractors: { name: string; records: any[]; stats: Rollup }[];
}

function ProjectGroup({ project, mode }: { project: ProjectNode; mode: GroupMode }) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-4 text-left min-w-0">
              <div className="bg-secondary text-secondary-foreground font-bold px-3 h-12 flex items-center justify-center rounded-md text-sm shrink-0">
                {project.project}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-lg">{formatWeight(project.stats.weight)}</div>
                <div className="text-xs text-muted-foreground">
                  {project.stats.marks.toLocaleString()} marks • {project.stats.qty.toLocaleString()} pcs • {project.contractors.length} contractors
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div className="hidden sm:block">
                <div className="text-xs uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-lg ${getAgeingColor(project.stats.avgAge)}`}>
                  {project.stats.avgAge !== null ? `${project.stats.avgAge}d` : "-"}
                </div>
              </div>
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-card divide-y">
            {project.contractors.map((c) => (
              <ContractorGroup key={c.name} project={project.project} name={c.name} records={c.records} stats={c.stats} mode={mode} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ContractorGroup({
  name,
  records,
  stats,
  mode,
}: {
  project: string;
  name: string;
  records: any[];
  stats: Rollup;
  mode: GroupMode;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const extra = useMemo(() => {
    if (mode === "fab") {
      const s = { PUNCHING: 0, DRILLING: 0, NOT_SET: 0 };
      for (const r of records) s[holeOpOf(r)] += 1;
      return `Punching ${s.PUNCHING} • Drilling ${s.DRILLING} • Not set ${s.NOT_SET}`;
    }
    let notSet = 0;
    for (const r of records) if (r.thicknessMm == null) notSet += 1;
    return `Thickness not set: ${notSet}`;
  }, [records, mode]);

  const sortedRows = useMemo(() => {
    return [...records].sort((a, b) => {
      const s = String(a.structure ?? "").localeCompare(String(b.structure ?? ""));
      if (s !== 0) return s;
      return compareActivity(a.activity, b.activity) || (b.ageingDays ?? -1) - (a.ageingDays ?? -1);
    });
  }, [records]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-3 px-4 pl-6 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 text-left min-w-0">
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{name}</div>
              <div className="text-[11px] text-muted-foreground">{extra}</div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-right shrink-0">
            <div className="text-xs text-muted-foreground">
              {stats.marks} marks • <span className="font-bold text-foreground">{formatWeight(stats.weight)}</span>
            </div>
            <div className={`font-bold text-sm w-12 ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="overflow-x-auto bg-muted/20">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Structure</TableHead>
                <TableHead>Mark</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>Activity</TableHead>
                {mode === "fab" ? (
                  <TableHead>Hole Op.</TableHead>
                ) : (
                  <TableHead className="text-right">Thick.</TableHead>
                )}
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Wt</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Ageing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{r.structure || "-"}</TableCell>
                  <TableCell className="font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                  <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || "-"}</TableCell>
                  <TableCell className="font-medium">{r.activity || "-"}</TableCell>
                  {mode === "fab" ? (
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{HOLE_OP_LABELS[holeOpOf(r)]}</TableCell>
                  ) : (
                    <TableCell className="text-right tabular-nums whitespace-nowrap" title={r.thicknessSource ?? "unset"}>
                      {r.thicknessMm != null ? `${r.thicknessMm} mm` : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                  )}
                  <TableCell className="text-right">{r.balanceQty}</TableCell>
                  <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.assignDate || "-"}</TableCell>
                  <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                    {ageingCell(r)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5} className="font-semibold">Total ({stats.marks.toLocaleString()} marks)</TableCell>
                <TableCell className="text-right font-bold tabular-nums">{stats.qty.toLocaleString()}</TableCell>
                <TableCell className="text-right font-bold tabular-nums">{formatWeight(stats.weight)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {sortedRows.length > ROW_CAP && (
          <div className="p-3 text-center text-xs text-muted-foreground border-t">
            {showAll ? (
              <span>
                Showing all {sortedRows.length.toLocaleString()} marks.{" "}
                <button type="button" onClick={() => setShowAll(false)} className="text-primary font-medium hover:underline">
                  Show less
                </button>
              </span>
            ) : (
              <span>
                Showing first {ROW_CAP.toLocaleString()} of {sortedRows.length.toLocaleString()} marks.{" "}
                <button type="button" onClick={() => setShowAll(true)} className="text-primary font-medium hover:underline">
                  Show all
                </button>
              </span>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
