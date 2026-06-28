import { useState, useMemo } from "react";
import {
  compareActivity,
  sortActivities,
  processPhase,
  PROCESS_PHASES,
  type ProcessPhaseKey,
} from "@workspace/domain";
import { useTracker } from "@/lib/store";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
} from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableFooter,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { SortControl } from "@/components/sort-control";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatWeight } from "@/lib/utils";
import { sortRecords, type RecordSortKey } from "@/lib/sort";
import { ChevronLeft, Search, FileSpreadsheet } from "lucide-react";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";

const ROW_CAP = 300;

type ProjectSortKey = "assignDate" | "project" | "weight" | "marks" | "ageing";

const PROJECT_SORT_OPTIONS: { id: ProjectSortKey; name: string }[] = [
  { id: "assignDate", name: "First Assign Date" },
  { id: "project", name: "Project wise" },
  { id: "weight", name: "Weight" },
  { id: "marks", name: "Marks" },
  { id: "ageing", name: "Avg Ageing" },
];

const isoDate = (s: unknown): string | null => {
  const v = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export default function JobDashboard() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <JobDashboardContent key={selectedImportId} />;
}

function JobDashboardContent() {
  const { selectedImportId, filters, setFilter } = useTracker();
  // Project Wise drills down by Project (TLT) or Section (NTLT). "All" Order
  // Type shows BOTH — every row is resolved by its own category below.
  const isAll = filters.category === "ALL";
  const isNtlt = filters.category === "NTLT";
  const { data: rawRecords = [] } = useGetImportRecords(selectedImportId as number, {
    query: {
      enabled: !!selectedImportId,
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
    },
  });

  // Scope to the current Order Type mode. The toggle drives both the primary
  // dimension (Project for TLT, Section for NTLT) and the grouping below.
  const records = useMemo(
    () =>
      rawRecords.filter(
        (r) =>
          (isAll || (r.category || "TLT") === filters.category) &&
          r.active !== false,
      ),
    [rawRecords, filters.category, isAll],
  );

  // Resolve a row's primary key (Project in TLT, Section group_key in NTLT) and
  // its secondary key (Structure in TLT, Sub-category in NTLT).
  const rowIsNtlt = (r: { category: string | null }) => (r.category || "TLT") === "NTLT";
  // Per-row resolution lets "All" mix both categories. In All mode keys are
  // category-prefixed so a TLT project and an NTLT section never merge.
  const primaryOf = (r: { job: string | null; groupKey: string | null; category: string | null }) => {
    const base = (rowIsNtlt(r) ? r.groupKey : r.job) || "Unknown";
    return isAll ? `${rowIsNtlt(r) ? "NTLT" : "TLT"}: ${base}` : base;
  };
  const secondaryOf = (r: { structure: string | null; ntltSubtype: string | null; category: string | null }) =>
    rowIsNtlt(r) ? r.ntltSubtype : r.structure;

  const [project, setProject] = useState<string | null>(null);
  const [structure, setStructure] = useState<string | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [projectSort, setProjectSort] = useState<ProjectSortKey>("assignDate");

  const primaryLabel = isAll ? "Group" : isNtlt ? "Section" : "Project";
  const secondaryLabel = isAll ? "Sub-group" : isNtlt ? "Sub-category" : "Structure";

  // Switching mode clears any stale cross-mode local selection.
  const switchMode = (v: string | null) => {
    if (!v || v === filters.category) return;
    setProject(null);
    setStructure(null);
    setMark(null);
    setSelectedJob(null);
    setFilter("category", v);
  };

  // Cascading dropdown options
  const projectOptions = useMemo(
    () => Array.from(new Set(records.map((r) => primaryOf(r)).filter((k) => k !== "Unknown"))).sort(),
    [records, isNtlt, isAll],
  );

  const structureOptions = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .filter((r) => !project || primaryOf(r) === project)
            .map((r) => secondaryOf(r))
            .filter((s): s is string => Boolean(s)),
        ),
      ).sort(),
    [records, project, isNtlt, isAll],
  );

  const markOptions = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .filter(
              (r) =>
                (!project || primaryOf(r) === project) &&
                (!structure || secondaryOf(r) === structure),
            )
            .map((r) => r.markId)
            .filter(Boolean),
        ),
      ).sort(),
    [records, project, structure, isNtlt, isAll],
  );

  const setProjectCascade = (v: string | null) => {
    setProject(v);
    setStructure(null);
    setMark(null);
  };
  const setStructureCascade = (v: string | null) => {
    setStructure(v);
    setMark(null);
  };

  const filtered = useMemo(
    () =>
      records.filter((r) => {
        if (project && primaryOf(r) !== project) return false;
        if (structure && secondaryOf(r) !== structure) return false;
        if (mark && r.markId !== mark) return false;
        return true;
      }),
    [records, project, structure, mark, isNtlt, isAll],
  );

  const { totalProjects, totalMarks, totalQty, totalWt, avgAgeing, byProject, byActivity } =
    useMemo(() => {
      const withAge = filtered.filter((r) => r.ageingDays !== null);
      const avg = (recs: typeof filtered) => {
        const a = recs.filter((r) => r.ageingDays !== null);
        return a.length
          ? Math.round(a.reduce((s, r) => s + (r.ageingDays || 0), 0) / a.length)
          : null;
      };

      const projGroups = new Map<string, typeof filtered>();
      filtered.forEach((r) => {
        const key = primaryOf(r);
        if (!projGroups.has(key)) projGroups.set(key, []);
        projGroups.get(key)!.push(r);
      });

      const emptyPhases = () =>
        Object.fromEntries(
          PROCESS_PHASES.map((p) => [p.key, { marks: 0, weight: 0 }]),
        ) as Record<ProcessPhaseKey, { marks: number; weight: number }>;

      const byProject = Array.from(projGroups.entries()).map(([job, recs]) => {
        const phases = emptyPhases();
        for (const r of recs) {
          const key = processPhase(r.activity);
          if (!key) continue;
          phases[key].marks += 1;
          phases[key].weight += r.balanceWt;
        }
        return {
        job,
        structures: new Set(recs.map((r) => secondaryOf(r)).filter(Boolean)).size,
        marks: recs.length,
        qty: recs.reduce((s, r) => s + r.balanceQty, 0),
        weight: recs.reduce((s, r) => s + r.balanceWt, 0),
        phases,
        avgAge: avg(recs),
        firstAssign: recs.reduce<string | null>((min, r) => {
          const d = isoDate(r.assignDate);
          if (!d) return min;
          return min === null || d < min ? d : min;
        }, null),
        c0to30: recs.filter((r) => r.ageingDays !== null && r.ageingDays <= 30).length,
        c31to60: recs.filter(
          (r) => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60,
        ).length,
        c60Plus: recs.filter((r) => r.ageingDays !== null && r.ageingDays > 60).length,
        };
      });

      const actGroups = new Map<string, typeof filtered>();
      filtered.forEach((r) => {
        const key = r.activity || "Unknown";
        if (!actGroups.has(key)) actGroups.set(key, []);
        actGroups.get(key)!.push(r);
      });

      const byActivity = Array.from(actGroups.entries())
        .map(([activity, recs]) => ({
          activity,
          marks: recs.length,
          qty: recs.reduce((s, r) => s + r.balanceQty, 0),
          weight: recs.reduce((s, r) => s + r.balanceWt, 0),
          avgAge: avg(recs),
        }))
        .sort((a, b) => compareActivity(a.activity, b.activity));

      return {
        totalProjects: projGroups.size,
        totalMarks: filtered.length,
        totalQty: filtered.reduce((s, r) => s + r.balanceQty, 0),
        totalWt: filtered.reduce((s, r) => s + r.balanceWt, 0),
        avgAgeing: withAge.length
          ? Math.round(withAge.reduce((s, r) => s + (r.ageingDays || 0), 0) / withAge.length)
          : 0,
        byProject,
        byActivity,
      };
    }, [filtered]);

  const sortedProjects = useMemo(() => {
    const arr = [...byProject];
    switch (projectSort) {
      case "project":
        arr.sort((a, b) => a.job.localeCompare(b.job));
        break;
      case "weight":
        arr.sort((a, b) => b.weight - a.weight);
        break;
      case "marks":
        arr.sort((a, b) => b.marks - a.marks);
        break;
      case "ageing":
        arr.sort((a, b) => (b.avgAge ?? -1) - (a.avgAge ?? -1));
        break;
      case "assignDate":
      default:
        // Earliest first assign date first; projects with no date sort last.
        arr.sort((a, b) => {
          if (a.firstAssign && b.firstAssign)
            return a.firstAssign < b.firstAssign
              ? -1
              : a.firstAssign > b.firstAssign
                ? 1
                : a.job.localeCompare(b.job);
          if (a.firstAssign) return -1;
          if (b.firstAssign) return 1;
          return a.job.localeCompare(b.job);
        });
        break;
    }
    return arr;
  }, [byProject, projectSort]);

  const handleExport = () => {
    const groupLabel = isAll ? "Group" : isNtlt ? "Section" : "Project";
    const sheets: XlsxSheet[] = [
      {
        name: `By ${groupLabel}`,
        columns: [
          { label: groupLabel, field: "job" },
          { label: "Structures", field: "structures", numeric: true, decimals: 0 },
          { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
          { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
          { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
          { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
          { label: "First Assign", field: "firstAssign" },
          { label: "0-30d", field: "c0to30", numeric: true, decimals: 0 },
          { label: "31-60d", field: "c31to60", numeric: true, decimals: 0 },
          { label: "60d+", field: "c60Plus", numeric: true, decimals: 0 },
        ],
        rows: sortedProjects.map((p) => ({
          job: p.job,
          structures: p.structures,
          marks: p.marks,
          qty: p.qty,
          weight: p.weight,
          avgAge: p.avgAge,
          firstAssign: p.firstAssign ?? "",
          c0to30: p.c0to30,
          c31to60: p.c31to60,
          c60Plus: p.c60Plus,
        })),
      },
      {
        name: "By Activity",
        columns: [
          { label: "Activity", field: "activity" },
          { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
          { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
          { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
          { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
        ],
        rows: byActivity.map((a) => ({
          activity: a.activity,
          marks: a.marks,
          qty: a.qty,
          weight: a.weight,
          avgAge: a.avgAge,
        })),
      },
    ];
    void exportToXlsxSheets(
      `project_wise_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    );
  };

  if (selectedJob) {
    return (
      <JobDetail
        job={selectedJob}
        label={primaryLabel}
        records={records.filter((r) => primaryOf(r) === selectedJob)}
        onBack={() => setSelectedJob(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleExport}
          disabled={byProject.length === 0}
        >
          <FileSpreadsheet className="h-4 w-4" /> Export Excel
        </Button>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            {isAll ? "Group Filters" : isNtlt ? "Section Filters" : "Project Filters"}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase">
              Order Type
            </span>
            <Segmented
              value={filters.category}
              onChange={switchMode}
              options={[
                { value: "ALL", label: "All" },
                { value: "TLT", label: "TLT" },
                { value: "NTLT", label: "NTLT" },
              ]}
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">
                {primaryLabel}
              </label>
              <SearchableSelect
                value={project}
                onChange={setProjectCascade}
                options={projectOptions}
                allLabel={`All ${primaryLabel}s`}
                searchPlaceholder={`Search ${primaryLabel.toLowerCase()}s...`}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">
                {secondaryLabel}
              </label>
              <SearchableSelect
                value={structure}
                onChange={setStructureCascade}
                options={structureOptions}
                allLabel={`All ${secondaryLabel === "Sub-category" ? "Sub-categories" : "Structures"}`}
                searchPlaceholder={`Search ${secondaryLabel.toLowerCase()}...`}
                disabled={structureOptions.length === 0}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase">
                Mark
              </label>
              <SearchableSelect
                value={mark}
                onChange={setMark}
                options={markOptions}
                allLabel="All Marks"
                searchPlaceholder="Search marks..."
                disabled={markOptions.length === 0}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiTile title={`${primaryLabel}s`} value={totalProjects} />
        <KpiTile title="Pending Marks" value={totalMarks} />
        <KpiTile title="Balance Qty" value={totalQty.toLocaleString()} />
        <KpiTile title="Balance Wt" value={formatWeight(totalWt)} />
        <KpiTile title="Avg Ageing (d)" value={avgAgeing} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            By {primaryLabel}
          </CardTitle>
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase whitespace-nowrap">
              Sort by
            </label>
            <Select
              value={projectSort}
              onValueChange={(v) => setProjectSort(v as ProjectSortKey)}
            >
              <SelectTrigger className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{primaryLabel}</TableHead>
                  {PROCESS_PHASES.map((ph) => (
                    <TableHead key={ph.key} className="text-right align-bottom">
                      <span className="block whitespace-nowrap">{ph.label}</span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case leading-tight max-w-[180px] ml-auto">
                        ({ph.activities.join(", ")})
                      </span>
                      <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                        wt / marks
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right align-bottom">
                    <span className="block whitespace-nowrap">Total</span>
                    <span className="block text-[10px] font-normal text-muted-foreground normal-case">
                      wt / marks
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProjects.map((p) => (
                  <TableRow
                    key={p.job}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setSelectedJob(p.job)}
                  >
                    <TableCell className="font-bold text-primary">{p.job}</TableCell>
                    {PROCESS_PHASES.map((ph) => {
                      const cell = p.phases[ph.key];
                      return (
                        <TableCell key={ph.key} className="text-right tabular-nums">
                          {cell.marks > 0 ? (
                            <>
                              <span className="font-bold">{formatWeight(cell.weight)}</span>
                              <span className="block text-xs text-muted-foreground">
                                {cell.marks} marks
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right tabular-nums bg-muted/30">
                      <span className="font-bold">{formatWeight(p.weight)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {p.marks} marks
                      </span>
                    </TableCell>
                    <TableCell
                      className={`text-right font-bold tabular-nums ${getAgeingColor(p.avgAge)}`}
                    >
                      {p.avgAge !== null ? `${p.avgAge}d` : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {byProject.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={PROCESS_PHASES.length + 3} className="text-center py-4 text-muted-foreground">
                      No data for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {byProject.length > 0 && (
                <TableFooter>
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    {PROCESS_PHASES.map((ph) => {
                      const marks = byProject.reduce((s, p) => s + p.phases[ph.key].marks, 0);
                      const weight = byProject.reduce((s, p) => s + p.phases[ph.key].weight, 0);
                      return (
                        <TableCell key={ph.key} className="text-right tabular-nums">
                          {marks > 0 ? (
                            <>
                              <span className="font-bold">{formatWeight(weight)}</span>
                              <span className="block text-xs text-muted-foreground">
                                {marks} marks
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right tabular-nums bg-muted/50">
                      <span className="font-bold">{formatWeight(totalWt)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {totalMarks} marks
                      </span>
                    </TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(avgAgeing)}`}>
                      {avgAgeing}d
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            By Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[600px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                <TableRow>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byActivity.map((a) => (
                  <TableRow key={a.activity}>
                    <TableCell className="font-medium">{a.activity}</TableCell>
                    <TableCell className="text-right">{a.marks}</TableCell>
                    <TableCell className="text-right">{a.qty}</TableCell>
                    <TableCell className="text-right">{formatWeight(a.weight)}</TableCell>
                    <TableCell
                      className={`text-right font-bold tabular-nums ${getAgeingColor(a.avgAge)}`}
                    >
                      {a.avgAge !== null ? `${a.avgAge}d` : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {byActivity.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                      No data for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {byActivity.length > 0 && (
                <TableFooter className="sticky bottom-0 bg-card z-10">
                  <TableRow className="border-t-2">
                    <TableCell className="font-bold uppercase tracking-wider text-xs">Total</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{totalMarks}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{totalQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{formatWeight(totalWt)}</TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(avgAgeing)}`}>
                      {avgAgeing}d
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

function JobDetail({
  job,
  label,
  records,
  onBack,
}: {
  job: string;
  label: string;
  records: any[];
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const [contractor, setContractor] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<RecordSortKey>("activity");
  const [showAll, setShowAll] = useState(false);

  const activityOptions = useMemo(
    () =>
      sortActivities(Array.from(new Set(records.map((r) => r.activity).filter(Boolean)))),
    [records],
  );
  const contractorOptions = useMemo(
    () =>
      Array.from(
        new Set(records.map((r) => r.contractor).filter(Boolean)),
      ).sort(),
    [records],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (activity && r.activity !== activity) return false;
      if (contractor && r.contractor !== contractor) return false;
      if (
        q &&
        ![r.structure, r.markId, r.activity, r.section].some((v) =>
          String(v ?? "").toLowerCase().includes(q),
        )
      )
        return false;
      return true;
    });
  }, [records, search, activity, contractor]);

  const sortedRows = useMemo(() => sortRecords(filtered, sortBy), [filtered, sortBy]);

  const isNtlt = records.some((r) => (r.category || "TLT") === "NTLT");
  const secondaryNoun = isNtlt ? "sub-categories" : "structures";
  const structureCount = useMemo(
    () =>
      new Set(
        filtered
          .map((r) => (isNtlt ? r.ntltSubtype : r.structure))
          .filter(Boolean),
      ).size,
    [filtered, isNtlt],
  );
  const totalQty = useMemo(() => filtered.reduce((s, r) => s + r.balanceQty, 0), [filtered]);
  const totalWt = useMemo(() => filtered.reduce((s, r) => s + r.balanceWt, 0), [filtered]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);

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
          <h2 className="text-xl font-bold tracking-tight truncate">{label} {job}</h2>
          <p className="text-xs text-muted-foreground">
            {structureCount} {secondaryNoun} • {filtered.length.toLocaleString()} marks •{" "}
            {totalQty.toLocaleString()} pcs • <span className="font-bold text-foreground">{formatWeight(totalWt)}</span>
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search structure, mark, activity, section..."
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Activity
            </label>
            <SearchableSelect
              value={activity}
              onChange={setActivity}
              options={activityOptions}
              allLabel="All Activities"
              searchPlaceholder="Search activities..."
              disabled={activityOptions.length === 0}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              Contractor
            </label>
            <SearchableSelect
              value={contractor}
              onChange={setContractor}
              options={contractorOptions}
              allLabel="All Contractors"
              searchPlaceholder="Search contractors..."
              disabled={contractorOptions.length === 0}
            />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-end px-4 py-3 border-b">
            <SortControl value={sortBy} onChange={setSortBy} />
          </div>
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
                  <TableHead>Contractor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium whitespace-nowrap">{r.structure || "-"}</TableCell>
                    <TableCell className="font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.activity || "-"}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || "-"}</TableCell>
                    <TableCell className="text-right">{r.balanceQty}</TableCell>
                    <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{r.contractor || "-"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.assignDate || "-"}</TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                      {ageingCell(r)}
                    </TableCell>
                  </TableRow>
                ))}
                {sortedRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-4 text-muted-foreground">
                      No marks found for this {label.toLowerCase()}.
                    </TableCell>
                  </TableRow>
                )}
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
        </CardContent>
      </Card>
    </div>
  );
}

function KpiTile({ title, value }: { title: string; value: string | number }) {
  return (
    <Card className="shadow-sm border-border">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 line-clamp-1">
          {title}
        </p>
        <p className="text-sm sm:text-base font-medium tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
