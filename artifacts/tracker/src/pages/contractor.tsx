import { useTracker, useFilteredRecords, useContractorCategoryMap, contractorCategoryFor, type ContractorCategoryInfo } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { formatWeight } from "@/lib/utils";
import { ChevronDown, ChevronLeft, Search, Building2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { compareActivity, contractorCategoryLabel, outVendorTypeLabel, bundleActivitySet } from "@workspace/domain";

// Activity scopes for the per-contractor load split, sliced from the canonical
// bundles in @workspace/domain. Display/aggregation only.
const FAB_SET = bundleActivitySet("TLT_FABRICATION") ?? new Set<string>();
const GALVA_SET = bundleActivitySet("GALVANIZING") ?? new Set<string>();
const YARD_SET = bundleActivitySet("YARD") ?? new Set<string>();

// Small inline badge for a contractor's sub-category (+ FAB/GALVA tags). Display
// only; resolved live from the overlay map. Unclassified contractors render a
// muted chip so the absence of a mapping is visible.
function ContractorCategoryBadge({ info }: { info: ContractorCategoryInfo }) {
  const isUnclassified = info.category === "UNCLASSIFIED";
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
          isUnclassified
            ? "bg-muted text-muted-foreground"
            : "bg-secondary text-secondary-foreground"
        }`}
      >
        {contractorCategoryLabel(info.category)}
      </span>
      {info.outVendorType.map((t) => (
        <span
          key={t}
          className="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-primary/10 text-primary"
        >
          {outVendorTypeLabel(t)}
        </span>
      ))}
    </span>
  );
}

const ROW_CAP = 300;

export default function ContractorView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <ContractorContent />;
}

function ContractorContent() {
  const { selectedImportId, setFilter, filters } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);
  const categoryMap = useContractorCategoryMap();

  const [selectedContractor, setSelectedContractor] = useState<string | null>(null);
  // When a load cell drills in with a bundle filter, remember the prior activity
  // filter so Back can restore it (and never clobber a manual filter).
  const restoreActivity = useRef<{ active: boolean; value: string | null }>({ active: false, value: null });

  const drillWithActivity = (name: string, bundle: string) => {
    restoreActivity.current = { active: true, value: filters.activity };
    setFilter("activity", bundle);
    setSelectedContractor(name);
  };

  const handleBack = () => {
    if (restoreActivity.current.active) {
      setFilter("activity", restoreActivity.current.value);
      restoreActivity.current = { active: false, value: null };
    }
    setSelectedContractor(null);
  };

  const { conMap, sortedStats, unassignedCount, busiest, mostAged } = useMemo(() => {
    const conMap = new Map<string, any[]>();
    records.forEach(r => {
      const c = r.contractor || "Unassigned";
      if (!conMap.has(c)) conMap.set(c, []);
      conMap.get(c)!.push(r);
    });

    const stats = Array.from(conMap.entries()).map(([name, recs]) => {
      const withAge = recs.filter(r => r.ageingDays !== null);
      const projects = new Set(
        recs.map(r => r.job).filter((j): j is string => !!j && j !== "(Unassigned)")
      ).size;
      return {
        name,
        marks: recs.length,
        projects,
        qty: recs.reduce((sum, r) => sum + r.balanceQty, 0),
        weight: recs.reduce((sum, r) => sum + r.balanceWt, 0),
        fabLoad: recs
          .filter(r => FAB_SET.has((r.activity ?? "").toUpperCase()))
          .reduce((sum, r) => sum + r.balanceWt, 0),
        galvaLoad: recs
          .filter(r => GALVA_SET.has((r.activity ?? "").toUpperCase()))
          .reduce((sum, r) => sum + r.balanceWt, 0),
        yardLoad: recs
          .filter(r => YARD_SET.has((r.activity ?? "").toUpperCase()))
          .reduce((sum, r) => sum + r.balanceWt, 0),
        avgAge: withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays!, 0) / withAge.length) : null,
      };
    });

    // Sort by weight desc
    const sortedStats = [...stats].sort((a, b) => b.weight - a.weight);

    return {
      conMap,
      sortedStats,
      unassignedCount: stats.find(s => s.name === "Unassigned")?.marks || 0,
      busiest: sortedStats[0]?.name || "-",
      mostAged: [...stats].sort((a, b) => (b.avgAge || 0) - (a.avgAge || 0))[0]?.name || "-",
    };
  }, [records]);

  if (selectedContractor) {
    return (
      <ContractorDetail
        name={selectedContractor}
        records={conMap.get(selectedContractor) ?? []}
        categoryInfo={contractorCategoryFor(selectedContractor, categoryMap)}
        onBack={handleBack}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile title="Contractors" value={conMap.has("Unassigned") ? conMap.size - 1 : conMap.size} />
        <KpiTile title="Busiest (Wt)" value={busiest} />
        <KpiTile title="Most Aged" value={mostAged} />
        <KpiTile title="Unassigned Marks" value={unassignedCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Workload</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contractor</TableHead>
                  <TableHead className="text-right">Total Wt</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Fabrication Load</TableHead>
                  <TableHead className="text-right">Galvanizing Load</TableHead>
                  <TableHead className="text-right">Yard Load</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedStats.map(s => (
                  <TableRow
                    key={s.name}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelectedContractor(s.name)}
                  >
                    <TableCell className="align-top">
                      <div className="flex flex-col gap-1 min-w-[10rem] max-w-[16rem]">
                        <span className="text-sm font-medium text-foreground leading-snug break-words whitespace-normal">{s.name}</span>
                        <div>
                          <ContractorCategoryBadge info={contractorCategoryFor(s.name, categoryMap)} />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right align-top font-bold font-mono tabular-nums text-foreground text-base">
                      {formatWeight(s.weight)}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums text-foreground text-base">
                      {s.projects.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right align-top tabular-nums text-foreground text-base">
                      {s.marks.toLocaleString()}
                    </TableCell>
                    <TableCell
                      className="text-right align-top font-mono tabular-nums text-foreground text-base hover:text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        drillWithActivity(s.name, "bundle:TLT_FABRICATION");
                      }}
                    >
                      {formatWeight(s.fabLoad)}
                    </TableCell>
                    <TableCell
                      className="text-right align-top font-mono tabular-nums text-foreground text-base hover:text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        drillWithActivity(s.name, "bundle:GALVANIZING");
                      }}
                    >
                      {formatWeight(s.galvaLoad)}
                    </TableCell>
                    <TableCell
                      className="text-right align-top font-mono tabular-nums text-foreground text-base hover:text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        drillWithActivity(s.name, "bundle:YARD");
                      }}
                    >
                      {formatWeight(s.yardLoad)}
                    </TableCell>
                    <TableCell className={`text-right align-top font-semibold tabular-nums text-base ${getAgeingColor(s.avgAge)}`}>
                      {s.avgAge !== null ? `${s.avgAge}d` : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {sortedStats.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No data available.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ContractorDetail({ name, records, categoryInfo, onBack }: { name: string, records: any[], categoryInfo: ContractorCategoryInfo, onBack: () => void }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter(r =>
      [r.markId, r.job, r.structure, r.section, r.activity].some(v => String(v ?? "").toLowerCase().includes(q))
    );
  }, [records, search]);

  const { activities, sortedActivities } = useMemo(() => {
    const activities = new Map<string, any[]>();
    filtered.forEach(r => {
      const act = r.activity || "Unassigned";
      if (!activities.has(act)) activities.set(act, []);
      activities.get(act)!.push(r);
    });
    const sortedActivities = Array.from(activities.keys()).sort(compareActivity);
    return { activities, sortedActivities };
  }, [filtered]);

  const { projects, sortedProjects } = useMemo(() => {
    const projects = new Map<string, any[]>();
    filtered.forEach(r => {
      const job = r.job || "(Unassigned)";
      if (!projects.has(job)) projects.set(job, []);
      projects.get(job)!.push(r);
    });
    const sortedProjects = Array.from(projects.entries())
      .sort((a, b) =>
        b[1].reduce((s, r) => s + r.balanceWt, 0) - a[1].reduce((s, r) => s + r.balanceWt, 0)
      )
      .map(([job]) => job);
    return { projects, sortedProjects };
  }, [filtered]);

  const totalQty = useMemo(() => filtered.reduce((sum, r) => sum + r.balanceQty, 0), [filtered]);
  const totalWt = useMemo(() => filtered.reduce((sum, r) => sum + r.balanceWt, 0), [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-1"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold tracking-tight truncate">{name}</h2>
            <ContractorCategoryBadge info={categoryInfo} />
          </div>
          <p className="text-xs text-muted-foreground">
            {filtered.length.toLocaleString()} marks • {totalQty.toLocaleString()} pcs •{" "}
            <span className="font-bold text-foreground">{formatWeight(totalWt)}</span> • {sortedActivities.length} activities
          </p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search job, structure, mark, section..."
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center p-8 text-muted-foreground">No marks found for this contractor.</div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-3">
            <h3 className="px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Projects</h3>
            {sortedProjects.map(job => (
              <ContractorProjectCard key={job} project={job} records={projects.get(job)!} />
            ))}
          </div>
          <div className="space-y-3">
            <h3 className="px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Activities</h3>
            {sortedActivities.map(act => (
              <ContractorActivityCard key={act} activity={act} records={activities.get(act)!} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContractorProjectCard({ project, records }: { project: string, records: any[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const wt = records.reduce((sum, r) => sum + r.balanceWt, 0);
  const structureCount = new Set(
    records.map(r => r.structure).filter((s): s is string => !!s)
  ).size;

  const withAge = records.filter(r => r.ageingDays !== null);
  const avgAge = withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays, 0) / withAge.length) : null;

  const sortedRows = useMemo(() => {
    return [...records].sort((a, b) => {
      const s = String(a.structure ?? "").localeCompare(String(b.structure ?? ""));
      if (s !== 0) return s;
      const act = compareActivity(String(a.activity ?? ""), String(b.activity ?? ""));
      if (act !== 0) return act;
      return (b.ageingDays ?? -1) - (a.ageingDays ?? -1);
    });
  }, [records]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);

  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-2.5 hover:bg-muted/30 transition-colors gap-2">
            <div className="flex items-center gap-2 text-left min-w-0">
              <div className="bg-secondary text-secondary-foreground w-8 h-8 flex items-center justify-center rounded shrink-0">
                <Building2 className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate leading-tight">{project}</div>
                <div className="text-[11px] text-muted-foreground leading-tight">
                  <span className="font-bold text-foreground text-xs">{formatWeight(wt)}</span>
                  {" • "}{records.length} marks • {structureCount} {structureCount === 1 ? "structure" : "structures"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 text-right shrink-0">
              <div className="hidden sm:block leading-tight">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-sm ${getAgeingColor(avgAge)}`}>{avgAge !== null ? `${avgAge}d` : '-'}</div>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Structure</TableHead>
                    <TableHead>Mark</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Wt</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Ageing</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap">{r.structure || '-'}</TableCell>
                      <TableCell className="font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.activity || '-'}</TableCell>
                      <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || '-'}</TableCell>
                      <TableCell className="text-right">{r.balanceQty}</TableCell>
                      <TableCell className="text-right font-bold">{formatWeight(r.balanceWt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.assignDate || '-'}</TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                        {ageingCell(r)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {sortedRows.length > ROW_CAP && (
              <div className="p-3 text-center text-xs text-muted-foreground border-t">
                {showAll ? (
                  <span>
                    Showing all {sortedRows.length.toLocaleString()} marks.{" "}
                    <button
                      type="button"
                      onClick={() => setShowAll(false)}
                      className="text-primary font-medium hover:underline"
                    >
                      Show less
                    </button>
                  </span>
                ) : (
                  <span>
                    Showing first {ROW_CAP.toLocaleString()} of {sortedRows.length.toLocaleString()} marks.{" "}
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="text-primary font-medium hover:underline"
                    >
                      Show all
                    </button>{" "}
                    or use the search to narrow down.
                  </span>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ContractorActivityCard({ activity, records }: { activity: string, records: any[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const qty = records.reduce((sum, r) => sum + r.balanceQty, 0);
  const wt = records.reduce((sum, r) => sum + r.balanceWt, 0);

  const withAge = records.filter(r => r.ageingDays !== null);
  const avgAge = withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays, 0) / withAge.length) : null;

  const sortedRows = useMemo(() => {
    return [...records].sort((a, b) => {
      const j = String(a.job ?? "").localeCompare(String(b.job ?? ""));
      if (j !== 0) return j;
      const s = String(a.structure ?? "").localeCompare(String(b.structure ?? ""));
      if (s !== 0) return s;
      return (b.ageingDays ?? -1) - (a.ageingDays ?? -1);
    });
  }, [records]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);

  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-2.5 hover:bg-muted/30 transition-colors gap-2">
            <div className="flex items-center gap-2 text-left">
              <div className="bg-secondary text-secondary-foreground font-bold w-8 h-8 flex items-center justify-center rounded text-sm shrink-0">
                {activity}
              </div>
              <div className="min-w-[100px] leading-tight">
                <div className="font-bold text-sm">{formatWeight(wt)}</div>
                <div className="text-[11px] text-muted-foreground">{records.length} marks • {qty.toLocaleString()} pcs</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 text-right">
              <div className="hidden sm:block leading-tight">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-sm ${getAgeingColor(avgAge)}`}>{avgAge !== null ? `${avgAge}d` : '-'}</div>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Structure</TableHead>
                    <TableHead>Mark</TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Wt</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Ageing</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap">{r.job || '-'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.structure || '-'}</TableCell>
                      <TableCell className="font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                      <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || '-'}</TableCell>
                      <TableCell className="text-right">{r.balanceQty}</TableCell>
                      <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.assignDate || '-'}</TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                        {ageingCell(r)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {sortedRows.length > ROW_CAP && (
              <div className="p-3 text-center text-xs text-muted-foreground border-t">
                {showAll ? (
                  <span>
                    Showing all {sortedRows.length.toLocaleString()} marks.{" "}
                    <button
                      type="button"
                      onClick={() => setShowAll(false)}
                      className="text-primary font-medium hover:underline"
                    >
                      Show less
                    </button>
                  </span>
                ) : (
                  <span>
                    Showing first {ROW_CAP.toLocaleString()} of {sortedRows.length.toLocaleString()} marks.{" "}
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="text-primary font-medium hover:underline"
                    >
                      Show all
                    </button>{" "}
                    or use the search to narrow down.
                  </span>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function KpiTile({ title, value }: { title: string, value: string | number }) {
  return (
    <Card className="shadow-sm border-border">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 line-clamp-1">{title}</p>
        <p className="text-lg sm:text-xl font-bold tracking-tight truncate w-full">{value}</p>
      </CardContent>
    </Card>
  );
}
