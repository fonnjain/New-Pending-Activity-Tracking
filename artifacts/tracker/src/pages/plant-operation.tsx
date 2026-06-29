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
import { bundleActivitySet, compareActivity, sortActivities, getActivityBundle, TLT_OPERATION_BUNDLE_IDS, activityRank } from "@workspace/domain";

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

const SPECIAL_OP_LABELS: Record<string, string> = {
  BENDING: "Bending",
  WELDING: "Welding",
  OTHER: "Other",
};

const ROW_CAP = 300;

// The operation split shown inside the Fabrication tab depends on which sub-bundle
// is selected. For Standard Operations (cutting/punch/drill) the hole operation is
// the meaningful axis; for Special Operations (bending/welding) the activity is.
// Display/aggregation only — never changes parsing, ageing, dedup, or activity values.
type FabDimension = "hole" | "special";

function holeOpOf(r: any): "PUNCHING" | "DRILLING" | "NOT_SET" {
  const op = r.holeOperation;
  return op === "PUNCHING" || op === "DRILLING" ? op : "NOT_SET";
}

// Bending = activities B (Bending) + HAB (Heat / Assembly-Bending); Welding = W.
function specialOpOf(r: any): "BENDING" | "WELDING" | "OTHER" {
  const a = (r.activity ?? "").toUpperCase();
  if (a === "B" || a === "HAB") return "BENDING";
  if (a === "W") return "WELDING";
  return "OTHER";
}

function opOf(r: any, dimension: FabDimension): string {
  return dimension === "special" ? specialOpOf(r) : holeOpOf(r);
}

function opLabel(key: string, dimension: FabDimension): string {
  return dimension === "special" ? SPECIAL_OP_LABELS[key] : HOLE_OP_LABELS[key];
}

// Load bifurcation (Fabrication Load report rules, display-only). Each operation
// is split into work AT it now (Operational) and still upstream (In Hand):
//   - Standard / hole operations (Punching, Drilling): SPECIFIC-ACTIVITY rule —
//     Operational = at RFI, In Hand = at C (regardless of punch/drill or section).
//   - Special operations (Bending = B, Welding = W): POSITIONAL rule — Operational
//     = at the activity, In Hand = anywhere earlier in the TLT sequence. In Hand
//     therefore pulls marks from OUTSIDE the special bundle (C/RFI/NH ... HG).
// None of this changes parsing, ageing, dedup, classification, qty, or activity
// values — it only re-buckets existing records for display.
type LoadState = "ALL" | "OPERATIONAL" | "INHAND";
type SectionFilter = "ALL" | "ANGLE" | "PLATE";

const W_RANK = activityRank("W");
const B_RANK = activityRank("B");
const Q_RANK = activityRank("Q");

function passesSpecialLoad(
  r: any,
  target: "BENDING" | "WELDING",
  load: "OPERATIONAL" | "INHAND",
): boolean {
  const act = (r.activity ?? "").toUpperCase();
  if (load === "OPERATIONAL") return target === "WELDING" ? act === "W" : act === "B";
  // In Hand: strictly before the target activity. Unknown activities rank past the
  // sequence end, so they are naturally excluded (matches the report's behaviour).
  return activityRank(r.activity) < (target === "WELDING" ? W_RANK : B_RANK);
}

// Hole-dimension load split for the top-level Load tab row. Operational = work AT
// the operation now; In Hand (Upcoming) = work still upstream. What counts as "the
// operation" depends on which operation tab is selected:
//   - Standard Operations (hole making): Operational = ready at the machine (RFI),
//     In Hand = cut and waiting upstream (C).
//   - Quality: Operational = at the quality stages (Q / TS), In Hand = still in
//     fabrication, upstream of Q.
//   - All (whole fabrication): every fab mark is at fabrication now, so all are
//     Operational and nothing sits upstream (In Hand is empty).
// Display/aggregation only — never changes parsing, ageing, dedup, qty, or activity.
function passesHoleLoad(
  r: any,
  group: string,
  load: "OPERATIONAL" | "INHAND",
): boolean {
  const act = (r.activity ?? "").toUpperCase();
  if (group === "TLT_STANDARD_OPERATIONS") {
    return load === "OPERATIONAL" ? act === "RFI" : act === "C";
  }
  if (group === "TLT_QUALITY") {
    return load === "OPERATIONAL"
      ? act === "Q" || act === "TS"
      : activityRank(r.activity) < Q_RANK;
  }
  return load === "OPERATIONAL";
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
        <p className="text-lg sm:text-2xl font-bold tracking-tight">{value}</p>
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
  const [opFilter, setOpFilter] = useState<string>("ALL");
  const [group, setGroup] = useState<string>("ALL");
  const [load, setLoad] = useState<LoadState>("ALL");
  const [section, setSection] = useState<SectionFilter>("ALL");

  const groupSet = group === "ALL" ? null : bundleActivitySet(group);
  const dimension: FabDimension =
    group === "TLT_SPECIAL_OPERATIONS" ? "special" : "hole";
  const isStandard = group === "TLT_STANDARD_OPERATIONS";
  const isSpecial = group === "TLT_SPECIAL_OPERATIONS";
  // Section split only applies to Standard Operations (Angle vs Plate). The Load
  // tab row is a top-level control that applies to every operation tab.
  const showSection = isStandard;
  // Special-operations load is positional and operation-specific, so it needs a
  // single target operation; default to Bending when "All" was selected.
  const specialLoad = isSpecial && load !== "ALL";
  const opTarget: "BENDING" | "WELDING" = opFilter === "WELDING" ? "WELDING" : "BENDING";

  const fabBase = useMemo(
    () => records.filter((r) => FAB_SET.has((r.activity ?? "").toUpperCase())),
    [records],
  );

  const scope = useMemo(() => {
    // Special In-Hand reaches upstream of the special bundle, so it is computed
    // over the full fabrication scope rather than the (B/HAB/W) sub-bundle.
    if (specialLoad) {
      return fabBase.filter((r) => passesSpecialLoad(r, opTarget, load as "OPERATIONAL" | "INHAND"));
    }
    // When a hole-dimension Load tab is active it defines its own activity set
    // (Operational = at the operation; In Hand = upstream), so it runs against the
    // full fab base rather than the group-restricted set — otherwise "In Hand"
    // (e.g. work upstream of Quality) would be filtered out before it can match.
    if (dimension === "hole" && load !== "ALL") {
      let s = section !== "ALL" ? fabBase.filter((r) => r.sectionType === section) : fabBase;
      return s.filter((r) => passesHoleLoad(r, group, load as "OPERATIONAL" | "INHAND"));
    }
    let s = groupSet
      ? fabBase.filter((r) => groupSet.has((r.activity ?? "").toUpperCase()))
      : fabBase;
    if (dimension === "hole" && section !== "ALL") {
      s = s.filter((r) => r.sectionType === section);
    }
    return s;
  }, [fabBase, groupSet, dimension, section, load, specialLoad, opTarget, group]);

  // For the Special Load view, the full Operational vs In-Hand pipeline for the
  // selected operation (shown as tiles regardless of which Load tab is active).
  const specialLoadCounts = useMemo(() => {
    if (!specialLoad) return null;
    return {
      op: rollup(fabBase.filter((r) => passesSpecialLoad(r, opTarget, "OPERATIONAL"))),
      inh: rollup(fabBase.filter((r) => passesSpecialLoad(r, opTarget, "INHAND"))),
    };
  }, [specialLoad, fabBase, opTarget]);

  // Operation split over the full scope (always the complete split, independent of
  // the local op filter). Standard/All split by hole operation (Punching/Drilling/
  // Not set); Special Operations split by Bending/Welding.
  const split = useMemo(() => {
    const c: Record<string, { marks: number; weight: number }> = {};
    for (const r of scope) {
      const op = opOf(r, dimension);
      if (!c[op]) c[op] = { marks: 0, weight: 0 };
      c[op].marks += 1;
      c[op].weight += r.balanceWt;
    }
    return c;
  }, [scope, dimension]);

  // Per-activity counts within fabrication, ordered by the TLT process sequence.
  const actCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of scope) {
      const a = r.activity || "?";
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return sortActivities(Array.from(m.keys())).map((a) => ({ a, n: m.get(a)! }));
  }, [scope]);

  const displayed = useMemo(() => {
    // Special Load scope is already a single operation + load state.
    if (specialLoad) return scope;
    return opFilter === "ALL" ? scope : scope.filter((r) => opOf(r, dimension) === opFilter);
  }, [scope, opFilter, dimension, specialLoad]);

  const projects = useMemo(() => groupProjectContractor(displayed), [displayed]);
  // Summary tile shows the total of ALL relevant activities in the scope (the full
  // operation breakdown), independent of the local operation sub-filter (opFilter)
  // which only narrows the marks table below.
  const total = useMemo(() => rollup(scope), [scope]);

  const loadLabel = load === "OPERATIONAL" ? "Operational" : "In Hand";

  const handleExport = () => {
    const rows = projects.flatMap((p) =>
      p.contractors.map((c) => {
        const base = {
          project: p.project,
          contractor: c.name,
          marks: c.stats.marks,
          qty: c.stats.qty,
          weight: c.stats.weight,
          avgAge: c.stats.avgAge,
        };
        // Special Load rows are a single operation + load state, so the
        // Bending/Welding split would be meaningless — base columns only.
        if (specialLoad) return base;
        if (dimension === "special") {
          const s = { BENDING: 0, WELDING: 0 };
          for (const r of c.records) {
            const op = specialOpOf(r);
            if (op !== "OTHER") s[op] += 1;
          }
          return { ...base, bending: s.BENDING, welding: s.WELDING };
        }
        const s = { PUNCHING: 0, DRILLING: 0, NOT_SET: 0 };
        for (const r of c.records) s[holeOpOf(r)] += 1;
        return { ...base, punching: s.PUNCHING, drilling: s.DRILLING, notSet: s.NOT_SET };
      }),
    );
    const splitColumns: XlsxColumn[] = specialLoad
      ? []
      : dimension === "special"
        ? [
            { label: "Bending", field: "bending", numeric: true, decimals: 0, total: true },
            { label: "Welding", field: "welding", numeric: true, decimals: 0, total: true },
          ]
        : [
            { label: "Punching", field: "punching", numeric: true, decimals: 0, total: true },
            { label: "Drilling", field: "drilling", numeric: true, decimals: 0, total: true },
            { label: "Not Set", field: "notSet", numeric: true, decimals: 0, total: true },
          ];
    const columns: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Contractor", field: "contractor" },
      { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
      { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
      { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
      { label: "Avg Ageing (days)", field: "avgAge", numeric: true, decimals: 0 },
      ...splitColumns,
    ];
    exportToXlsx("plant-operation-fabrication.xlsx", columns, rows, { sheetName: "Fabrication" });
  };

  return (
    <div className="space-y-4">
      <Segmented
        value={group}
        onChange={(v) => {
          setGroup(v ?? "ALL");
          setOpFilter("ALL");
          setLoad("ALL");
          setSection("ALL");
        }}
        options={OP_GROUP_OPTIONS}
      />

      <div className="flex items-center gap-x-6 gap-y-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">Load</span>
          <Segmented
            value={load}
            onChange={(v) => {
              const nv = (v ?? "ALL") as LoadState;
              setLoad(nv);
              // Special load is operation-specific; lock to a single op.
              if (isSpecial && nv !== "ALL" && opFilter === "ALL") setOpFilter("BENDING");
            }}
            options={[
              { value: "ALL", label: "All" },
              { value: "OPERATIONAL", label: "Operational Load" },
              { value: "INHAND", label: "In Hand (Upcoming)" },
            ]}
          />
        </div>
        {showSection && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase">Section</span>
            <Segmented
              value={section}
              onChange={(v) => setSection((v ?? "ALL") as SectionFilter)}
              options={[
                { value: "ALL", label: "All" },
                { value: "ANGLE", label: "Angle" },
                { value: "PLATE", label: "Plate" },
              ]}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">
            {dimension === "special" ? "Operation" : "Hole Operation"}
          </span>
          <Segmented
            value={opFilter}
            onChange={(v) => setOpFilter(v ?? "ALL")}
            options={
              dimension === "special"
                ? [
                    // In a Special Load view a single operation is required.
                    ...(specialLoad ? [] : [{ value: "ALL", label: "All" }]),
                    { value: "BENDING", label: "Bending" },
                    { value: "WELDING", label: "Welding" },
                  ]
                : [
                    { value: "ALL", label: "All" },
                    { value: "PUNCHING", label: "Punching" },
                    { value: "DRILLING", label: "Drilling" },
                    { value: "NOT_SET", label: "Not set" },
                  ]
            }
          />
        </div>
      </div>

      <div className={`grid grid-cols-2 gap-3 ${dimension === "special" ? "md:grid-cols-3" : "md:grid-cols-4"}`}>
        {specialLoad && specialLoadCounts ? (
          <>
            <SummaryTile
              title={`${opLabel(opTarget, "special")} Pipeline`}
              value={formatWeight(specialLoadCounts.op.weight + specialLoadCounts.inh.weight)}
              sub={`${(specialLoadCounts.op.marks + specialLoadCounts.inh.marks).toLocaleString()} marks`}
            />
            <SummaryTile title="Operational Load" value={formatWeight(specialLoadCounts.op.weight)} sub={`${specialLoadCounts.op.marks.toLocaleString()} marks`} />
            <SummaryTile title="In Hand" value={formatWeight(specialLoadCounts.inh.weight)} sub={`${specialLoadCounts.inh.marks.toLocaleString()} marks`} />
          </>
        ) : (
          <>
            <SummaryTile
              title={dimension === "special" ? "Special Op." : "Fabrication"}
              value={formatWeight(total.weight)}
              sub={`${total.marks.toLocaleString()} marks`}
            />
            {dimension === "special" ? (
              <>
                <SummaryTile title="Bending" value={formatWeight(split.BENDING?.weight ?? 0)} sub={`${(split.BENDING?.marks ?? 0).toLocaleString()} marks`} />
                <SummaryTile title="Welding" value={formatWeight(split.WELDING?.weight ?? 0)} sub={`${(split.WELDING?.marks ?? 0).toLocaleString()} marks`} />
              </>
            ) : (
              <>
                <SummaryTile title="Punching" value={formatWeight(split.PUNCHING?.weight ?? 0)} sub={`${(split.PUNCHING?.marks ?? 0).toLocaleString()} marks`} />
                <SummaryTile title="Drilling" value={formatWeight(split.DRILLING?.weight ?? 0)} sub={`${(split.DRILLING?.marks ?? 0).toLocaleString()} marks`} />
                <SummaryTile title="Not Set" value={formatWeight(split.NOT_SET?.weight ?? 0)} sub={`${(split.NOT_SET?.marks ?? 0).toLocaleString()} marks`} />
              </>
            )}
          </>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={projects.length === 0}>
          <FileSpreadsheet className="h-4 w-4" />
          Export Excel
        </Button>
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

      {projects.map((p) => (
        <ProjectGroup key={p.project} project={p} mode="fab" dimension={dimension} load={load} loadLabel={loadLabel} />
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
        <SummaryTile title="Galvanizing" value={formatWeight(total.weight)} sub={`${total.marks.toLocaleString()} marks`} />
        <SummaryTile title="Balance Qty" value={total.qty.toLocaleString()} />
        <SummaryTile title="Thickness Set" value={formatWeight(thickness.setWt)} sub={`${thickness.set.toLocaleString()} marks`} />
        <SummaryTile title="Thickness Not Set" value={formatWeight(thickness.notSetWt)} sub={`${thickness.notSet.toLocaleString()} marks`} />
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

function ProjectGroup({
  project,
  mode,
  dimension = "hole",
  load = "ALL",
  loadLabel = "In Hand",
}: {
  project: ProjectNode;
  mode: GroupMode;
  dimension?: FabDimension;
  load?: LoadState;
  loadLabel?: string;
}) {
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
              <ContractorGroup key={c.name} project={project.project} name={c.name} records={c.records} stats={c.stats} mode={mode} dimension={dimension} load={load} loadLabel={loadLabel} />
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
  dimension = "hole",
  load = "ALL",
  loadLabel = "In Hand",
}: {
  project: string;
  name: string;
  records: any[];
  stats: Rollup;
  mode: GroupMode;
  dimension?: FabDimension;
  load?: LoadState;
  loadLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const extra = useMemo(() => {
    if (mode === "fab") {
      // Special Load rows are a single operation + load state, so the Bending /
      // Welding tally is meaningless — surface the load state instead.
      if (dimension === "special" && load !== "ALL") {
        return `${loadLabel} load`;
      }
      if (dimension === "special") {
        const s = { BENDING: 0, WELDING: 0 };
        for (const r of records) {
          const op = specialOpOf(r);
          if (op !== "OTHER") s[op] += 1;
        }
        return `Bending ${s.BENDING} • Welding ${s.WELDING}`;
      }
      const s = { PUNCHING: 0, DRILLING: 0, NOT_SET: 0 };
      for (const r of records) s[holeOpOf(r)] += 1;
      return `Punching ${s.PUNCHING} • Drilling ${s.DRILLING} • Not set ${s.NOT_SET}`;
    }
    let notSet = 0;
    for (const r of records) if (r.thicknessMm == null) notSet += 1;
    return `Thickness not set: ${notSet}`;
  }, [records, mode, dimension, load, loadLabel]);

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
          <Table containerClassName="max-h-[28rem]">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>Structure</TableHead>
                <TableHead>Mark</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>Activity</TableHead>
                {mode === "fab" ? (
                  <TableHead>{dimension === "special" ? "Operation" : "Hole Op."}</TableHead>
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
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{opLabel(opOf(r, dimension), dimension)}</TableCell>
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
            <TableFooter className="sticky bottom-0 z-10 bg-muted">
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
