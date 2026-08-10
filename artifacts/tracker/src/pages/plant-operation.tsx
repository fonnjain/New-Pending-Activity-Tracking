import { useEffect, useMemo, useState } from "react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell, isActiveCutting, isAwaitingAssignment } from "@/lib/ageing";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { formatWeight, formatDate } from "@/lib/utils";
import { exportToXlsx, exportTimestamp, type XlsxColumn } from "@/lib/export";
import { ChevronDown, FileSpreadsheet } from "lucide-react";
import { bundleActivitySet, compareActivity, getActivityBundle, TLT_OPERATION_BUNDLE_IDS, activityRank, routeIncludesOp, classifyNtltStage, NTLT_STAGES, type NtltStage } from "@workspace/domain";

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
  const before = activityRank(r.activity) < (target === "WELDING" ? W_RANK : B_RANK);
  if (!before) return false;
  // ...AND the operation must actually be in the mark's Col Q route: a mark
  // positioned before W/B that never welds/bends (op absent from its route) must
  // NOT count toward that operation's upcoming load. Blank/unknown route keeps
  // prior behaviour (routeIncludesOp returns true).
  return routeIncludesOp(r.operation, target === "WELDING" ? "W" : "B");
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
    // INHAND load = work not yet cut (CUTTING + AWAITING_ASSIGNMENT both qualify).
    return load === "OPERATIONAL" ? act === "RFI" : (isActiveCutting(r) || isAwaitingAssignment(r));
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
  const [tab, setTab] = useState("fabrication");
  const [group, setGroup] = useState<string>("ALL");

  // NTLT has its own stage model — show the dedicated overview instead of the
  // TLT fabrication/galvanization tabs.
  if (!isTlt) {
    return <NtltStageOverview records={records} />;
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <div className="flex items-center justify-between gap-x-6 gap-y-3 flex-wrap">
        <TabsList className="h-10">
          <TabsTrigger value="fabrication" className="px-6">Fabrication</TabsTrigger>
          <TabsTrigger value="galvanization" className="px-6">Galvanization</TabsTrigger>
        </TabsList>
        {tab === "fabrication" && (
          <Segmented value={group} onChange={(v) => setGroup(v ?? "ALL")} options={OP_GROUP_OPTIONS} />
        )}
      </div>
      <TabsContent value="fabrication">
        <FabricationTab records={records} group={group} />
      </TabsContent>
      <TabsContent value="galvanization">
        <GalvanizationTab records={records} />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// NTLT stage overview (replaces "Coming soon" when Order Type = NTLT)
// ---------------------------------------------------------------------------
function NtltStageOverview({ records }: { records: any[] }) {
  type StageCount = { marks: number; weight: number; qty: number };
  const emptyCount = (): StageCount => ({ marks: 0, weight: 0, qty: 0 });

  const { stageTotals, bySection } = useMemo(() => {
    const stageTotals = Object.fromEntries(
      NTLT_STAGES.map((s) => [s.key, emptyCount()]),
    ) as Record<NtltStage, StageCount>;

    const sectionMap = new Map<string, Record<NtltStage, StageCount> & { totalMarks: number; totalWeight: number }>();

    for (const r of records) {
      const stg = classifyNtltStage(r);
      stageTotals[stg].marks  += 1;
      stageTotals[stg].weight += r.balanceWt;
      stageTotals[stg].qty    += r.balanceQty;

      const sec = r.groupKey || r.section || "(Unassigned)";
      if (!sectionMap.has(sec)) {
        sectionMap.set(sec, {
          ...(Object.fromEntries(NTLT_STAGES.map((s) => [s.key, emptyCount()])) as Record<NtltStage, StageCount>),
          totalMarks: 0, totalWeight: 0,
        });
      }
      const sg = sectionMap.get(sec)!;
      sg[stg].marks  += 1;
      sg[stg].weight += r.balanceWt;
      sg[stg].qty    += r.balanceQty;
      sg.totalMarks  += 1;
      sg.totalWeight += r.balanceWt;
    }

    const bySection = Array.from(sectionMap.entries())
      .map(([section, sg]) => ({ section, stages: sg as Record<NtltStage, StageCount>, totalMarks: sg.totalMarks, totalWeight: sg.totalWeight }))
      .sort((a, b) => a.section.localeCompare(b.section));

    return { stageTotals, bySection };
  }, [records]);

  const totalMarks  = records.length;
  const totalWeight = records.reduce((s, r) => s + r.balanceWt, 0);

  const stageCell = (c: StageCount) =>
    c.marks > 0 ? (
      <>
        <span className="font-bold">{formatWeight(c.weight)}</span>
        <span className="block text-xs text-muted-foreground">{c.marks.toLocaleString()}</span>
      </>
    ) : (
      <span className="text-muted-foreground">-</span>
    );

  return (
    <div className="space-y-4">
      {/* Stage summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {NTLT_STAGES.map((stg) => {
          const t = stageTotals[stg.key];
          return (
            <SummaryTile
              key={stg.key}
              title={stg.label}
              value={formatWeight(t.weight)}
              sub={`${t.marks.toLocaleString()} marks`}
            />
          );
        })}
      </div>

      {/* Section breakdown table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  {NTLT_STAGES.map((stg) => (
                    <TableHead key={stg.key} className="text-right align-bottom">
                      <span className="block whitespace-nowrap leading-tight">{stg.label}</span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                        {stg.activities.length
                          ? `(${stg.activities.join(", ")})`
                          : stg.subLabel
                            ? `(${stg.subLabel})`
                            : ""}
                      </span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                        wt / marks
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right align-bottom">
                    <span className="block">Total</span>
                    <span className="block text-[10px] font-normal text-muted-foreground normal-case">wt / marks</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bySection.map((sec) => (
                  <TableRow key={sec.section}>
                    <TableCell className="font-medium">{sec.section}</TableCell>
                    {NTLT_STAGES.map((stg) => (
                      <TableCell key={stg.key} className="text-right tabular-nums">
                        {stageCell(sec.stages[stg.key])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums bg-muted/30">
                      <span className="font-bold">{formatWeight(sec.totalWeight)}</span>
                      <span className="block text-xs text-muted-foreground">{sec.totalMarks.toLocaleString()}</span>
                    </TableCell>
                  </TableRow>
                ))}
                {bySection.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={NTLT_STAGES.length + 2} className="text-center py-6 text-muted-foreground">
                      No NTLT marks in the current import.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {bySection.length > 0 && (
                <TableFooter>
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    {NTLT_STAGES.map((stg) => (
                      <TableCell key={stg.key} className="text-right tabular-nums">
                        {stageCell(stageTotals[stg.key])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums bg-muted/50">
                      <span className="font-bold">{formatWeight(totalWeight)}</span>
                      <span className="block text-xs text-muted-foreground">{totalMarks.toLocaleString()}</span>
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface HoleOpStructNode {
  op: string;
  records: any[];
  stats: Rollup;
  totalThicknessMm: number;
  structures: StructureNode[];
}

interface SectionTopNode {
  section: string;
  records: any[];
  stats: Rollup;
  totalThicknessMm: number;
  ops: HoleOpStructNode[];
}

interface ProjectSectionNode {
  project: string;
  records: any[];
  stats: Rollup;
  totalThicknessMm: number;
  sections: SectionTopNode[];
}

function groupProjectSectionOpStructure(records: any[]): ProjectSectionNode[] {
  const SEC_ORDER = ["ANGLE", "PLATE", "OTHER"];
  const HOP_ORDER = ["PUNCHING", "DRILLING", "NOT_SET"];
  const projMap = new Map<string, any[]>();
  for (const r of records) {
    const j = r.job || "(Unassigned)";
    if (!projMap.has(j)) projMap.set(j, []);
    projMap.get(j)!.push(r);
  }
  return Array.from(projMap.entries())
    .map(([project, precs]) => {
      const secMap = new Map<string, any[]>();
      for (const r of precs) {
        const sec = r.sectionType === "ANGLE" ? "ANGLE" : r.sectionType === "PLATE" ? "PLATE" : "OTHER";
        if (!secMap.has(sec)) secMap.set(sec, []);
        secMap.get(sec)!.push(r);
      }
      const sections = SEC_ORDER.filter((s) => secMap.has(s)).map((sec) => {
        const srecs = secMap.get(sec)!;
        const opMap = new Map<string, any[]>();
        for (const r of srecs) {
          const op = holeOpOf(r);
          if (!opMap.has(op)) opMap.set(op, []);
          opMap.get(op)!.push(r);
        }
        const ops = HOP_ORDER.filter((op) => opMap.has(op)).map((op) => {
          const orecs = opMap.get(op)!;
          const structMap = new Map<string, any[]>();
          for (const r of orecs) {
            const s = r.structure || "(No structure)";
            if (!structMap.has(s)) structMap.set(s, []);
            structMap.get(s)!.push(r);
          }
          const structures = Array.from(structMap.entries())
            .map(([structure, urecs]) => {
              let t = 0; for (const r of urecs) if (r.thicknessMm != null) t += r.thicknessMm;
              return { structure, records: urecs, stats: rollup(urecs), totalThicknessMm: t };
            })
            .sort((a, b) => a.structure.localeCompare(b.structure));
          let opT = 0; for (const r of orecs) if (r.thicknessMm != null) opT += r.thicknessMm;
          return { op, records: orecs, stats: rollup(orecs), totalThicknessMm: opT, structures };
        });
        let secT = 0; for (const r of srecs) if (r.thicknessMm != null) secT += r.thicknessMm;
        return { section: sec, records: srecs, stats: rollup(srecs), totalThicknessMm: secT, ops };
      });
      let projT = 0; for (const r of precs) if (r.thicknessMm != null) projT += r.thicknessMm;
      return { project, records: precs, stats: rollup(precs), totalThicknessMm: projT, sections };
    })
    .sort((a, b) => b.stats.weight - a.stats.weight);
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

function FabricationTab({ records, group }: { records: any[]; group: string }) {
  const [opFilter, setOpFilter] = useState<string>("ALL");
  const [load, setLoad] = useState<LoadState>("ALL");
  const [section, setSection] = useState<SectionFilter>("ALL");
  const [sectionFilter, setSectionFilter] = useState<string | null>(null);
  const [sectionTextFilter, setSectionTextFilter] = useState<Set<string>>(new Set());
  const [sectionsOpen, setSectionsOpen] = useState(false);

  // The operation group control lives beside the tab bar (lifted to the parent).
  // Reset the local sub-filters whenever the group changes, matching the prior
  // in-component behaviour.
  useEffect(() => {
    setOpFilter("ALL");
    setLoad("ALL");
    setSection("ALL");
    setSectionFilter(null);
    setSectionTextFilter(new Set());
  }, [group]);

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

  const displayed = useMemo(() => {
    // Special Load scope is already a single operation + load state.
    if (specialLoad) return scope;
    return opFilter === "ALL" ? scope : scope.filter((r) => opOf(r, dimension) === opFilter);
  }, [scope, opFilter, dimension, specialLoad]);

  const sectionTextOptions = useMemo(() => {
    const vals = new Set<string>();
    for (const r of displayed) {
      if (r.section && r.section.trim()) vals.add(r.section.trim());
    }
    return Array.from(vals).sort();
  }, [displayed]);

  const filteredDisplayed = useMemo(
    () => sectionTextFilter.size > 0
      ? displayed.filter((r) => sectionTextFilter.has(r.section ?? ""))
      : displayed,
    [displayed, sectionTextFilter],
  );

  const contractorProjects = useMemo(
    () => (!isSpecial && !isStandard) ? groupProjectContractor(filteredDisplayed) : [],
    [filteredDisplayed, isSpecial, isStandard],
  );
  const specialOpGroups = useMemo(
    () => isSpecial ? groupSpecialOpStructure(filteredDisplayed) : [],
    [filteredDisplayed, isSpecial],
  );
  const projectSectionGroups = useMemo(
    () => isStandard ? groupProjectSectionOpStructure(filteredDisplayed) : [],
    [filteredDisplayed, isStandard],
  );
  const sectionChips = useMemo(() => {
    if (!isStandard) return [];
    const SEC_ORDER = ["ANGLE", "PLATE", "OTHER"];
    const agg = new Map<string, number>();
    for (const p of projectSectionGroups) {
      for (const s of p.sections) {
        agg.set(s.section, (agg.get(s.section) ?? 0) + s.totalThicknessMm);
      }
    }
    return SEC_ORDER.filter(s => agg.has(s)).map(s => ({ section: s, totalThicknessMm: agg.get(s)! }));
  }, [projectSectionGroups, isStandard]);
  const filteredSpecialGroups = useMemo(
    () => sectionFilter ? specialOpGroups.filter(g => g.op === sectionFilter) : specialOpGroups,
    [specialOpGroups, sectionFilter],
  );
  const filteredProjectSectionGroups = useMemo(
    () => sectionFilter
      ? projectSectionGroups
          .map(p => ({ ...p, sections: p.sections.filter(s => s.section === sectionFilter) }))
          .filter(p => p.sections.length > 0)
      : projectSectionGroups,
    [projectSectionGroups, sectionFilter],
  );
  // Summary tile shows the total of ALL relevant activities in the scope (the full
  // operation breakdown), independent of the local operation sub-filter (opFilter)
  // which only narrows the marks table below.
  const total = useMemo(() => rollup(scope), [scope]);

  const thicknessBreakdown = useMemo(() => {
    let set = 0, totalMm = 0;
    for (const r of scope) {
      if (r.thicknessMm != null) { set++; totalMm += r.thicknessMm; }
    }
    return { set, totalMm };
  }, [scope]);

  const loadLabel = load === "OPERATIONAL" ? "Operational" : "In Hand";

  const handleExport = () => {
    const rows = displayed.map((r) => {
      const base = {
        project: r.job || "(Unassigned)",
        structure: r.structure || "",
        markId: r.markId,
        section: r.section || "",
        activity: r.activity || "",
        contractor: r.contractor || "Unassigned",
        thicknessMm: r.thicknessMm ?? null,
        qty: r.balanceQty,
        weight: r.balanceWt,
        ageingDays: r.ageingDays ?? null,
      };
      if (specialLoad) return base;
      if (dimension === "special") return { ...base, operation: specialOpOf(r) };
      return { ...base, holeOp: HOLE_OP_LABELS[holeOpOf(r)] ?? holeOpOf(r) };
    });
    const opCol: XlsxColumn[] = specialLoad
      ? []
      : dimension === "special"
        ? [{ label: "Operation", field: "operation" }]
        : [{ label: "Hole Op.", field: "holeOp" }];
    const columns: XlsxColumn[] = [
      { label: "Project", field: "project" },
      { label: "Structure", field: "structure" },
      { label: "Mark ID", field: "markId" },
      { label: "Section", field: "section" },
      { label: "Activity", field: "activity" },
      { label: "Contractor", field: "contractor" },
      ...opCol,
      { label: "Thickness (mm)", field: "thicknessMm", numeric: true, decimals: 1 },
      { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
      { label: "Balance Wt (kg)", field: "weight", numeric: true, decimals: 2, total: true },
      { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
    ];
    exportToXlsx(`plant-operation-fabrication_${exportTimestamp()}.xlsx`, columns, rows, { sheetName: "Fabrication" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-x-6 gap-y-3 flex-wrap">
        <div className="flex items-center gap-2">
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
        <div className="flex items-center gap-2 ml-auto">
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

      {/* Sections (section text) multi-select filter — collapsible, default closed */}
      {sectionTextOptions.length > 0 && (
        <Collapsible open={sectionsOpen} onOpenChange={setSectionsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors cursor-pointer select-none"
            >
              <span>Sections</span>
              <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">
                ({sectionTextOptions.length})
                {sectionTextFilter.size > 0 && (
                  <span className="ml-1 text-primary font-medium">{sectionTextFilter.size} selected</span>
                )}
              </span>
              <ChevronDown className={`w-3.5 h-3.5 ml-0.5 transition-transform ${sectionsOpen ? "rotate-180" : ""}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex items-center gap-1.5 flex-wrap mt-2">
              {sectionTextOptions.map((s) => {
                const active = sectionTextFilter.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSectionTextFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(s)) next.delete(s); else next.add(s);
                        return next;
                      });
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-foreground hover:bg-muted"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
              {sectionTextFilter.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSectionTextFilter(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 ml-1"
                >
                  Clear
                </button>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {(isSpecial || (!specialLoad && isStandard)) && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-muted/50 border rounded-md px-3 py-1.5 shrink-0">
            <span className="text-xs text-muted-foreground uppercase font-semibold tracking-wide whitespace-nowrap">Thickness</span>
            <span className="font-extrabold text-primary text-sm whitespace-nowrap">{thicknessBreakdown.totalMm.toLocaleString()} mm</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
            {isSpecial
              ? specialOpGroups.map((g) => (
                  <button
                    key={g.op}
                    onClick={() => setSectionFilter(sectionFilter === g.op ? null : g.op)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                      sectionFilter === g.op
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-foreground hover:bg-muted"
                    }`}
                  >
                    {SPECIAL_OP_LABELS[g.op] ?? g.op}
                    <span className="ml-1.5 font-normal opacity-70">{g.totalThicknessMm.toLocaleString()} mm</span>
                  </button>
                ))
              : sectionChips.map((g) => (
                  <button
                    key={g.section}
                    onClick={() => setSectionFilter(sectionFilter === g.section ? null : g.section)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                      sectionFilter === g.section
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-foreground hover:bg-muted"
                    }`}
                  >
                    {({"ANGLE":"Angle","PLATE":"Plate","OTHER":"Other"} as Record<string,string>)[g.section] ?? g.section}
                    <span className="ml-1.5 font-normal opacity-70">{g.totalThicknessMm.toLocaleString()} mm</span>
                  </button>
                ))
            }
          </div>
          <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={handleExport} disabled={displayed.length === 0}>
            <FileSpreadsheet className="h-4 w-4" />
            Export Excel
          </Button>
        </div>
      )}

      {!isSpecial && !isStandard && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={displayed.length === 0}>
            <FileSpreadsheet className="h-4 w-4" />
            Export Excel
          </Button>
        </div>
      )}

      {isSpecial
        ? filteredSpecialGroups.map((g) => <SpecialOpCard key={g.op} {...g} />)
        : isStandard
          ? filteredProjectSectionGroups.map((p) => <ProjectSectionCard key={p.project} {...p} />)
          : contractorProjects.map((p) => (
              <ProjectGroup key={p.project} project={p} mode="fab" dimension={dimension} load={load} loadLabel={loadLabel} />
            ))}
      {displayed.length === 0 && (
        <div className="text-center p-8 text-muted-foreground">No fabrication marks match the current filters.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Galvanization
// ---------------------------------------------------------------------------

function GalvanizationTab({ records }: { records: any[] }) {
  const [sectionTextFilter, setSectionTextFilter] = useState<Set<string>>(new Set());

  const scope = useMemo(
    () => records.filter((r) => GALVA_SET.has((r.activity ?? "").toUpperCase())),
    [records],
  );

  const sectionTextOptions = useMemo(() => {
    const vals = new Set<string>();
    for (const r of scope) {
      if (r.section && r.section.trim()) vals.add(r.section.trim());
    }
    return Array.from(vals).sort();
  }, [scope]);

  const displayed = useMemo(
    () => sectionTextFilter.size > 0 ? scope.filter((r) => sectionTextFilter.has(r.section ?? "")) : scope,
    [scope, sectionTextFilter],
  );

  const total = useMemo(() => rollup(displayed), [displayed]);

  const thickness = useMemo(() => {
    let set = 0;
    let totalMm = 0;
    for (const r of displayed) {
      if (r.thicknessMm != null) {
        set += 1;
        totalMm += r.thicknessMm;
      }
    }
    return { set, totalMm };
  }, [displayed]);

  const projects = useMemo(() => groupProjectContractor(displayed), [displayed]);

  const handleExport = () => {
    const rows = projects.flatMap((p) =>
      p.contractors.map((c) => {
        let totalThicknessMm = 0;
        for (const r of c.records) {
          if (r.thicknessMm != null) totalThicknessMm += r.thicknessMm;
        }
        return {
          project: p.project,
          contractor: c.name,
          marks: c.stats.marks,
          qty: c.stats.qty,
          weight: c.stats.weight,
          avgAge: c.stats.avgAge,
          totalThicknessMm,
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
      { label: "Total Thickness (mm)", field: "totalThicknessMm", numeric: true, decimals: 0, total: true },
    ];
    exportToXlsx(`plant-operation-galvanization_${exportTimestamp()}.xlsx`, columns, rows, { sheetName: "Galvanization" });
  };

  return (
    <div className="space-y-4">
      {/* Sections (section text) multi-select filter */}
      <div className="flex items-start gap-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap pt-1.5">Sections</span>
        <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
          {sectionTextOptions.length === 0 ? (
            <span className="text-xs text-muted-foreground italic">No sections in current scope</span>
          ) : (
            sectionTextOptions.map((s) => {
              const active = sectionTextFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSectionTextFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(s)) next.delete(s); else next.add(s);
                      return next;
                    });
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border text-foreground hover:bg-muted"
                  }`}
                >
                  {s}
                </button>
              );
            })
          )}
          {sectionTextFilter.size > 0 && (
            <button
              type="button"
              onClick={() => setSectionTextFilter(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 ml-1"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <SummaryTile title="Galvanizing" value={formatWeight(total.weight)} sub={`${total.marks.toLocaleString()} marks`} />
        <SummaryTile title="Balance Qty" value={total.qty.toLocaleString()} />
        <SummaryTile title="Total Thickness (set)" value={`${thickness.totalMm.toLocaleString()} mm`} sub={`${thickness.set.toLocaleString()} marks with thickness set`} />
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
                {mode === "fab" && (
                  <TableHead>{dimension === "special" ? "Operation" : "Hole Op."}</TableHead>
                )}
                <TableHead className="text-right">Thick.</TableHead>
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
                  {mode === "fab" && (
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{opLabel(opOf(r, dimension), dimension)}</TableCell>
                  )}
                  <TableCell className="text-right tabular-nums whitespace-nowrap" title={r.thicknessSource ?? "unset"}>
                    {r.thicknessMm != null ? `${r.thicknessMm} mm` : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-right">{r.balanceQty}</TableCell>
                  <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(r.assignDate)}</TableCell>
                  <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                    {ageingCell(r)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter className="sticky bottom-0 z-10 bg-muted">
              <TableRow>
                <TableCell colSpan={mode === "fab" ? 6 : 5} className="font-semibold">Total ({stats.marks.toLocaleString()} marks)</TableCell>
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

// ---------------------------------------------------------------------------
// Shared marks table (used by Special Ops and Standard Ops group components)
// ---------------------------------------------------------------------------

function MarksTable({ records, stats }: { records: any[]; stats: Rollup }) {
  const [showAll, setShowAll] = useState(false);

  const sortedRows = useMemo(
    () =>
      [...records].sort((a, b) => {
        const s = String(a.structure ?? "").localeCompare(String(b.structure ?? ""));
        if (s !== 0) return s;
        return compareActivity(a.activity, b.activity) || (b.ageingDays ?? -1) - (a.ageingDays ?? -1);
      }),
    [records],
  );

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);

  return (
    <div className="overflow-x-auto bg-muted/20">
      <Table containerClassName="max-h-[28rem]">
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>
            <TableHead>Structure</TableHead>
            <TableHead>Mark</TableHead>
            <TableHead>Section</TableHead>
            <TableHead>Activity</TableHead>
            <TableHead className="text-right">Thick.</TableHead>
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
              <TableCell className="text-right tabular-nums whitespace-nowrap" title={r.thicknessSource ?? "unset"}>
                {r.thicknessMm != null ? `${r.thicknessMm} mm` : <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="text-right">{r.balanceQty}</TableCell>
              <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(r.assignDate)}</TableCell>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared: Structure-level collapsible group (used by both Special and Standard Ops)
// ---------------------------------------------------------------------------

interface StructureNode {
  structure: string;
  records: any[];
  stats: Rollup;
  totalThicknessMm: number;
}

function StructureGroup({ structure, records, stats, totalThicknessMm }: StructureNode) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-2 px-4 pl-10 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 text-left min-w-0">
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="font-medium text-sm truncate">{structure}</div>
          </div>
          <div className="flex items-center gap-4 text-right shrink-0">
            <span className="font-bold text-primary text-sm">{totalThicknessMm.toLocaleString()} mm</span>
            <div className="text-xs text-muted-foreground">
              {stats.marks} marks • <span className="font-semibold text-foreground">{formatWeight(stats.weight)}</span>
            </div>
            <div className={`font-bold text-sm w-12 ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <MarksTable records={records} stats={stats} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Special Ops: SpecialOp (Bending / Welding) -> Structure -> Marks
// ---------------------------------------------------------------------------

interface SpecialOpTopNode {
  op: "BENDING" | "WELDING" | "OTHER";
  records: any[];
  stats: Rollup;
  totalThicknessMm: number;
  structures: StructureNode[];
}

function groupSpecialOpStructure(records: any[]): SpecialOpTopNode[] {
  const OP_ORDER: ("BENDING" | "WELDING" | "OTHER")[] = ["BENDING", "WELDING", "OTHER"];
  const opMap = new Map<string, any[]>();
  for (const r of records) {
    const op = specialOpOf(r);
    if (!opMap.has(op)) opMap.set(op, []);
    opMap.get(op)!.push(r);
  }
  return OP_ORDER.filter((op) => opMap.has(op)).map((op) => {
    const recs = opMap.get(op)!;
    const structMap = new Map<string, any[]>();
    for (const r of recs) {
      const s = r.structure || "(No structure)";
      if (!structMap.has(s)) structMap.set(s, []);
      structMap.get(s)!.push(r);
    }
    const structures = Array.from(structMap.entries())
      .map(([structure, srecs]) => {
        let t = 0; for (const r of srecs) if (r.thicknessMm != null) t += r.thicknessMm;
        return { structure, records: srecs, stats: rollup(srecs), totalThicknessMm: t };
      })
      .sort((a, b) => a.structure.localeCompare(b.structure));
    let totalThicknessMm = 0;
    for (const r of recs) if (r.thicknessMm != null) totalThicknessMm += r.thicknessMm;
    return { op, records: recs, stats: rollup(recs), totalThicknessMm, structures };
  });
}

function SpecialOpCard({ op, stats, totalThicknessMm, structures }: SpecialOpTopNode) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-4 text-left min-w-0">
              <div className="bg-secondary text-secondary-foreground font-bold px-3 h-12 flex items-center justify-center rounded-md text-sm shrink-0">
                {SPECIAL_OP_LABELS[op] ?? op}
              </div>
              <div className="min-w-0">
                <div className="font-extrabold text-xl text-primary">{totalThicknessMm.toLocaleString()} mm</div>
                <div className="text-xs text-muted-foreground">
                  {stats.marks.toLocaleString()} marks • {formatWeight(stats.weight)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div className="hidden sm:block">
                <div className="text-xs uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-lg ${getAgeingColor(stats.avgAge)}`}>
                  {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
                </div>
              </div>
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-card divide-y">
            {structures.map((s) => (
              <StructureGroup key={s.structure} {...s} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Standard Ops: Project -> Section (Angle/Plate) -> HoleOp -> Structure -> Inline marks
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = { ANGLE: "Angle", PLATE: "Plate", OTHER: "Other" };

function InlineMarksList({ records }: { records: any[] }) {
  return (
    <div className="divide-y bg-muted/10">
      {records.map((r, i) => (
        <div key={i} className="flex items-center py-1.5 px-4 pl-20 text-xs gap-3">
          <span className="font-medium text-foreground min-w-0 truncate flex-1" title={r.section || ""}>{r.section || "-"}</span>
          <div className="flex items-center gap-3 text-right shrink-0">
            <span className="font-bold text-primary whitespace-nowrap">{r.thicknessMm != null ? `${r.thicknessMm} mm` : "-"}</span>
            <span className="text-muted-foreground max-w-[120px] truncate text-right" title={r.contractor || ""}>{r.contractor || "-"}</span>
            <span className="text-muted-foreground whitespace-nowrap">{(r.balanceQty ?? 0).toLocaleString()} pcs • {formatWeight(r.balanceWt)}</span>
            <span className={`font-bold w-10 text-right ${getAgeingColor(r.ageingDays)}`}>
              {r.ageingDays != null ? `${r.ageingDays}d` : "-"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StructureInlineGroup({ structure, records, stats, totalThicknessMm }: StructureNode) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-2 px-4 pl-14 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 text-left min-w-0">
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="font-medium text-sm truncate">{structure}</div>
          </div>
          <div className="flex items-center gap-3 text-right shrink-0">
            <span className="font-bold text-primary text-sm">{totalThicknessMm.toLocaleString()} mm</span>
            <div className="text-xs text-muted-foreground">
              {stats.marks} marks • <span className="font-semibold text-foreground">{formatWeight(stats.weight)}</span>
            </div>
            <div className={`font-bold text-sm w-12 ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <InlineMarksList records={records} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function HoleOpStructGroup({ op, stats, totalThicknessMm, structures }: HoleOpStructNode) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-3 px-4 pl-8 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 text-left min-w-0">
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="font-semibold text-sm">{HOLE_OP_LABELS[op] ?? op}</div>
          </div>
          <div className="flex items-center gap-4 text-right shrink-0">
            <span className="font-bold text-primary text-sm">{totalThicknessMm.toLocaleString()} mm</span>
            <div className="text-xs text-muted-foreground">
              {stats.marks} marks • <span className="font-semibold text-foreground">{formatWeight(stats.weight)}</span>
            </div>
            <div className={`font-bold text-sm w-12 ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t divide-y">
          {structures.map((s) => (
            <StructureInlineGroup key={s.structure} {...s} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SectionInnerGroup({ section, stats, totalThicknessMm, ops }: SectionTopNode) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-3 px-4 pl-6 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 text-left min-w-0">
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="font-semibold text-sm">{SECTION_LABELS[section] ?? section}</div>
          </div>
          <div className="flex items-center gap-4 text-right shrink-0">
            <span className="font-bold text-primary text-sm">{totalThicknessMm.toLocaleString()} mm</span>
            <div className="text-xs text-muted-foreground">
              {stats.marks} marks • <span className="font-semibold text-foreground">{formatWeight(stats.weight)}</span>
            </div>
            <div className={`font-bold text-sm w-12 ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t divide-y">
          {ops.map((o) => (
            <HoleOpStructGroup key={o.op} {...o} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProjectSectionCard({ project, stats, totalThicknessMm, sections }: ProjectSectionNode) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-4 text-left min-w-0">
              <div className="bg-secondary text-secondary-foreground font-bold px-3 h-12 flex items-center justify-center rounded-md text-sm shrink-0">
                {project}
              </div>
              <div className="min-w-0">
                <div className="font-extrabold text-xl text-primary">{totalThicknessMm.toLocaleString()} mm</div>
                <div className="text-xs text-muted-foreground">
                  {stats.marks.toLocaleString()} marks • {formatWeight(stats.weight)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div className="hidden sm:block">
                <div className="text-xs uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-lg ${getAgeingColor(stats.avgAge)}`}>
                  {stats.avgAge !== null ? `${stats.avgAge}d` : "-"}
                </div>
              </div>
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-card divide-y">
            {sections.map((s) => (
              <SectionInnerGroup key={s.section} {...s} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
