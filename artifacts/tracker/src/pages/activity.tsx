import { useTracker, useFilteredRecords, dateRangeWindow } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";
import { formatWeight } from "@/lib/utils";
import { useState, useMemo } from "react";
import { compareActivity } from "@workspace/domain";
import { useSettings } from "@/lib/settings";

const ROW_CAP = 300;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function actPerfRollup(
  recs: any[],
  moveWindow: { start: string; end: string },
): { marks: number; qty: number; weightMt: number; avgAge: number | null; movedCount: number } {
  let weightMt = 0, qty = 0, ageSum = 0, agedCount = 0, movedCount = 0;
  for (const r of recs) {
    weightMt += r.balanceWt ?? 0;
    qty += r.balanceQty ?? 0;
    const d = r.ageingDays as number | null;
    if (d != null) { agedCount++; ageSum += d; }
    const lpd: string | null = r.lastProductionDate ?? null;
    if (lpd && lpd >= moveWindow.start && lpd <= moveWindow.end) movedCount++;
  }
  return { marks: recs.length, qty, weightMt, avgAge: agedCount > 0 ? Math.round(ageSum / agedCount) : null, movedCount };
}

// ---------------------------------------------------------------------------
// Mark-level list (leaf of drill-down)
// ---------------------------------------------------------------------------

function ActPerfMarksList({ records }: { records: any[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...records].sort((a, b) => (b.ageingDays ?? -1) - (a.ageingDays ?? -1)),
    [records],
  );
  const visible = showAll ? sorted : sorted.slice(0, ROW_CAP);
  const totalQty = records.reduce((s, r) => s + (r.balanceQty ?? 0), 0);
  const totalWt = records.reduce((s, r) => s + (r.balanceWt ?? 0), 0);
  return (
    <div className="border-t bg-card">
      <div className="overflow-x-auto">
        <Table containerClassName="max-h-[20rem]">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="whitespace-nowrap">Mark</TableHead>
              <TableHead>Section</TableHead>
              <TableHead className="text-right whitespace-nowrap">Thick.</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Wt</TableHead>
              <TableHead className="text-right">Ageing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r, i) => (
              <TableRow key={r.id ?? i}>
                <TableCell className="max-w-[80px] whitespace-nowrap">
                  <span className="font-mono text-xs font-semibold">{r.markTail || r.markId || "-"}</span>
                </TableCell>
                <TableCell className="max-w-[200px]">
                  <span className="font-medium text-foreground block truncate" title={r.section || ""}>{r.section || "-"}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums whitespace-nowrap font-bold text-primary">{r.thicknessMm != null ? `${r.thicknessMm} mm` : "-"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.balanceQty ?? 0}</TableCell>
                <TableCell className="text-right tabular-nums font-medium">{formatWeight(r.balanceWt)}</TableCell>
                <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                  {ageingCell(r)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="sticky bottom-0 z-10 bg-muted">
            <TableRow>
              <TableCell colSpan={3} className="font-semibold">Total ({records.length.toLocaleString()} marks)</TableCell>
              <TableCell className="text-right font-bold tabular-nums">{totalQty.toLocaleString()}</TableCell>
              <TableCell className="text-right font-bold tabular-nums">{formatWeight(totalWt)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      {sorted.length > ROW_CAP && (
        <div className="p-2 text-center text-xs text-muted-foreground border-t">
          {showAll ? (
            <span>Showing all {sorted.length.toLocaleString()} marks.{" "}
              <button type="button" onClick={() => setShowAll(false)} className="text-primary font-medium hover:underline">Show less</button>
            </span>
          ) : (
            <span>Showing first {ROW_CAP} of {sorted.length.toLocaleString()} marks.{" "}
              <button type="button" onClick={() => setShowAll(true)} className="text-primary font-medium hover:underline">Show all</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ActPerfContractorGroup({
  contractor, records, moveWindow,
}: { contractor: string; records: any[]; moveWindow: { start: string; end: string } }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => actPerfRollup(records, moveWindow), [records, moveWindow]);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-2 px-4 pl-16 hover:bg-muted/30 transition-colors gap-2">
          <div className="flex items-center gap-2 text-left min-w-0">
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <span className="text-xs font-medium truncate">{contractor}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0 text-xs">
            <span className="font-semibold">{formatWeight(stats.weightMt)}</span>
            <span className="text-muted-foreground">{stats.marks.toLocaleString()} marks</span>
            <span className={`font-bold w-8 text-right ${getAgeingColor(stats.avgAge)}`}>
              {stats.avgAge != null ? `${stats.avgAge}d` : "-"}
            </span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ActPerfMarksList records={records} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActPerfMfcGroup({
  mfc, conMap, moveWindow,
}: { mfc: string; conMap: Map<string, any[]>; moveWindow: { start: string; end: string } }) {
  const [open, setOpen] = useState(false);
  const allRecs = useMemo(() => [...conMap.values()].flat(), [conMap]);
  const stats = useMemo(() => actPerfRollup(allRecs, moveWindow), [allRecs, moveWindow]);
  const sortedContractors = useMemo(
    () => [...conMap.entries()]
      .sort((a, b) => b[1].reduce((s, r) => s + (r.balanceWt ?? 0), 0) - a[1].reduce((s, r) => s + (r.balanceWt ?? 0), 0))
      .map(([c]) => c),
    [conMap],
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-2 px-4 pl-10 hover:bg-muted/30 transition-colors gap-2">
          <div className="flex items-center gap-2 text-left min-w-0">
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded font-mono font-semibold">{mfc === "Z" ? "No Batch" : `Batch ${mfc}`}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0 text-xs">
            <span className="font-semibold">{formatWeight(stats.weightMt)}</span>
            <span className="text-muted-foreground">{stats.marks.toLocaleString()} marks • {sortedContractors.length} contractor{sortedContractors.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y">
          {sortedContractors.map((c) => (
            <ActPerfContractorGroup key={c} contractor={c} records={conMap.get(c)!} moveWindow={moveWindow} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActPerfProjectGroup({
  project, mfcMap, moveWindow,
}: { project: string; mfcMap: Map<string, Map<string, any[]>>; moveWindow: { start: string; end: string } }) {
  const [open, setOpen] = useState(false);
  const allRecs = useMemo(
    () => [...mfcMap.values()].flatMap((m) => [...m.values()].flat()),
    [mfcMap],
  );
  const stats = useMemo(() => actPerfRollup(allRecs, moveWindow), [allRecs, moveWindow]);
  const sortedMfcs = useMemo(() => {
    const entries = [...mfcMap.entries()];
    entries.sort((a, b) => {
      if (a[0] === "Z") return 1;
      if (b[0] === "Z") return -1;
      return a[0].localeCompare(b[0]);
    });
    return entries.map(([m]) => m);
  }, [mfcMap]);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between py-2.5 px-4 pl-6 hover:bg-muted/30 transition-colors gap-2">
          <div className="flex items-center gap-2 text-left min-w-0">
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{project}</div>
              <div className="text-[11px] text-muted-foreground">
                <span className="font-bold text-foreground text-xs">{formatWeight(stats.weightMt)}</span>
                {" • "}{stats.marks.toLocaleString()} marks
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="leading-tight text-right">
              <div className="text-[10px] uppercase text-muted-foreground font-semibold">Avg Age</div>
              <div className={`font-bold text-sm ${getAgeingColor(stats.avgAge)}`}>
                {stats.avgAge != null ? `${stats.avgAge}d` : "-"}
              </div>
            </div>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t divide-y bg-muted/5">
          {sortedMfcs.map((m) => (
            <ActPerfMfcGroup key={m} mfc={m} conMap={mfcMap.get(m)!} moveWindow={moveWindow} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Per-activity drill-down row inside the summary table
// ---------------------------------------------------------------------------

function ActivityDrillRow({
  act, records, idealDays, moveWindow, isDateFiltered, totalWt,
}: {
  act: string;
  records: any[];
  idealDays: number | null;
  moveWindow: { start: string; end: string };
  isDateFiltered: boolean;
  totalWt: number;
}) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => actPerfRollup(records, moveWindow), [records, moveWindow]);

  const projectMap = useMemo(() => {
    const pm = new Map<string, Map<string, Map<string, any[]>>>();
    for (const r of records) {
      const proj = r.job || "(Unassigned)";
      const mfc = r.mfcBatch || "Z";
      const con = r.contractor || "Unassigned";
      if (!pm.has(proj)) pm.set(proj, new Map());
      const mfcMap = pm.get(proj)!;
      if (!mfcMap.has(mfc)) mfcMap.set(mfc, new Map());
      const conMap = mfcMap.get(mfc)!;
      if (!conMap.has(con)) conMap.set(con, []);
      conMap.get(con)!.push(r);
    }
    return pm;
  }, [records]);

  const sortedProjects = useMemo(
    () => [...projectMap.entries()]
      .sort((a, b) => {
        const wa = [...a[1].values()].flatMap((m) => [...m.values()].flat()).reduce((s, r) => s + (r.balanceWt ?? 0), 0);
        const wb = [...b[1].values()].flatMap((m) => [...m.values()].flat()).reduce((s, r) => s + (r.balanceWt ?? 0), 0);
        return wb - wa;
      })
      .map(([p]) => p),
    [projectMap],
  );

  const sharePct = totalWt > 0 ? (stats.weightMt / totalWt) * 100 : 0;
  const movedLabel = isDateFiltered ? "Moved (period)" : "Moved (3d)";

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
            <span className="font-bold text-sm font-mono">{act}</span>
            {idealDays != null && (
              <span className="text-[10px] text-muted-foreground">({idealDays}d ideal)</span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums font-medium">{stats.marks.toLocaleString()}</TableCell>
        <TableCell className="text-right tabular-nums">{stats.qty.toLocaleString()}</TableCell>
        <TableCell className="text-right tabular-nums font-semibold">{formatWeight(stats.weightMt)}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground text-xs">
          {sharePct.toFixed(1)}%
        </TableCell>
        <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(stats.avgAge)}`}>
          {stats.avgAge != null ? `${stats.avgAge}d` : "-"}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {stats.movedCount > 0 ? <span className="text-primary font-semibold">{stats.movedCount}</span> : "-"}
        </TableCell>
        <TableCell className="text-right text-muted-foreground text-xs">
          {sortedProjects.length}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={8} className="p-0 bg-muted/10">
            <div className="border-y divide-y">
              {sortedProjects.map((p) => (
                <ActPerfProjectGroup key={p} project={p} mfcMap={projectMap.get(p)!} moveWindow={moveWindow} />
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity Performance Table — flat summary with expandable drill-down
// ---------------------------------------------------------------------------

function ActivityPerformanceTable({
  activities,
  sortedActivities,
  moveWindow,
  isDateFiltered,
}: {
  activities: Map<string, any[]>;
  sortedActivities: string[];
  moveWindow: { start: string; end: string };
  isDateFiltered: boolean;
}) {
  const { settings } = useSettings();

  const idealDaysMap = useMemo(() => {
    const m = new Map<string, number>();
    const acts = settings?.activities ?? {};
    for (const [code, cfg] of Object.entries(acts)) {
      if (cfg?.idealDays != null) m.set(code.toUpperCase(), cfg.idealDays);
    }
    return m;
  }, [settings]);

  const totalWt = useMemo(
    () => sortedActivities.reduce((s, a) => s + (activities.get(a) ?? []).reduce((x, r) => x + (r.balanceWt ?? 0), 0), 0),
    [activities, sortedActivities],
  );

  const totalMarks = useMemo(
    () => sortedActivities.reduce((s, a) => s + (activities.get(a) ?? []).length, 0),
    [activities, sortedActivities],
  );

  const totalQty = useMemo(
    () => sortedActivities.reduce((s, a) => s + (activities.get(a) ?? []).reduce((x, r) => x + (r.balanceQty ?? 0), 0), 0),
    [activities, sortedActivities],
  );

  const movedLabel = isDateFiltered ? "Moved (period)" : "Moved (3d)";

  if (sortedActivities.length === 0) return null;

  return (
    <Card>
      <div className="px-4 pt-4 pb-1">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Activity Performance</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Click any row to drill into Project &rarr; MFC Batch &rarr; Contractor &rarr; Marks</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Activity</TableHead>
              <TableHead className="text-right">Marks</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Balance Wt</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Avg Age</TableHead>
              <TableHead className="text-right">{movedLabel}</TableHead>
              <TableHead className="text-right">Projects</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedActivities.map((act) => (
              <ActivityDrillRow
                key={act}
                act={act}
                records={activities.get(act)!}
                idealDays={idealDaysMap.get(act.toUpperCase()) ?? null}
                moveWindow={moveWindow}
                isDateFiltered={isDateFiltered}
                totalWt={totalWt}
              />
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">Total</TableCell>
              <TableCell className="text-right font-bold tabular-nums">{totalMarks.toLocaleString()}</TableCell>
              <TableCell className="text-right font-bold tabular-nums">{totalQty.toLocaleString()}</TableCell>
              <TableCell className="text-right font-bold tabular-nums">{formatWeight(totalWt)}</TableCell>
              <TableCell className="text-right text-muted-foreground">100%</TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function ActivityView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <ActivityContent />;
}

function KpiTile({ title, value }: { title: string; value: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{title}</p>
        <p className="text-sm sm:text-base font-medium tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function ActivityContent() {
  const { selectedImportId, filters } = useTracker();
  const { data: allRecords, isLoading } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);

  const { moveWindow, isDateFiltered } = useMemo(() => {
    const win = filters.dateRange ? dateRangeWindow(filters.dateRange) : null;
    if (win) {
      return {
        moveWindow: { start: win.start.toISOString().slice(0, 10), end: win.end.toISOString().slice(0, 10) },
        isDateFiltered: true,
      };
    }
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const fromDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    return {
      moveWindow: { start: fromDate.toISOString().slice(0, 10), end: todayStr },
      isDateFiltered: false,
    };
  }, [filters.dateRange]);

  const { activities, sortedActivities, totalWt, totalMarks, avgAge, notAgedCount, notAgedWt, agedCount } = useMemo(() => {
    const activities = new Map<string, any[]>();
    records.forEach(r => {
      if (r.isInitialCutting) return;
      const act = r.activity || "Unassigned";
      if (!activities.has(act)) activities.set(act, []);
      activities.get(act)!.push(r);
    });

    const sortedActivities = Array.from(activities.keys()).sort(compareActivity);
    const totalWt = records.reduce((sum, r) => sum + (r.balanceWt ?? 0), 0);
    const aged = records.filter((r) => r.ageingDays !== null);
    const notAged = records.filter((r) => r.ageingDays === null);
    const avgAge = aged.length
      ? Math.round(aged.reduce((s, r) => s + (r.ageingDays || 0), 0) / aged.length)
      : null;
    const notAgedCount = notAged.length;
    const notAgedWt = notAged.reduce((s, r) => s + (r.balanceWt ?? 0), 0);

    return { activities, sortedActivities, totalWt, totalMarks: records.length, avgAge, notAgedCount, notAgedWt, agedCount: aged.length };
  }, [records]);

  const handleExport = () => {
    const avg = (recs: any[]) => {
      const a = recs.filter((r) => r.ageingDays !== null);
      return a.length
        ? Math.round(a.reduce((s, r) => s + (r.ageingDays || 0), 0) / a.length)
        : null;
    };
    const summaryRows = sortedActivities.map((act) => {
      const recs = activities.get(act)!;
      return {
        activity: act,
        marks: recs.length,
        qty: recs.reduce((s, r) => s + (r.balanceQty ?? 0), 0),
        weight: recs.reduce((s, r) => s + (r.balanceWt ?? 0), 0),
        avgAge: avg(recs),
      };
    });
    const markRows = sortedActivities.flatMap((act) =>
      activities.get(act)!.map((r) => ({
        activity: act,
        job: r.job,
        structure: r.structure,
        markId: r.markId,
        section: r.section,
        contractor: r.contractor,
        balanceQty: r.balanceQty,
        balanceWt: r.balanceWt,
        assignDate: r.assignDate ?? "",
        lastProductionDate: r.lastProductionDate ?? "",
        ageingDays: r.ageingDays,
      })),
    );
    const sheets: XlsxSheet[] = [
      {
        name: "Activities",
        columns: [
          { label: "Activity", field: "activity" },
          { label: "Marks", field: "marks", numeric: true, decimals: 0, total: true },
          { label: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true },
          { label: "Balance Wt", field: "weight", numeric: true, decimals: 2, total: true },
          { label: "Avg Ageing", field: "avgAge", numeric: true, decimals: 0 },
        ],
        rows: summaryRows,
      },
      {
        name: "Marks",
        columns: [
          { label: "Activity", field: "activity" },
          { label: "Project", field: "job" },
          { label: "Structure", field: "structure" },
          { label: "Mark", field: "markId" },
          { label: "Section", field: "section" },
          { label: "Contractor", field: "contractor" },
          { label: "Balance Qty", field: "balanceQty", numeric: true, decimals: 0, total: true },
          { label: "Balance Wt", field: "balanceWt", numeric: true, decimals: 2, total: true },
          { label: "Assign Date", field: "assignDate" },
          { label: "Last Production", field: "lastProductionDate" },
          { label: "Ageing (days)", field: "ageingDays", numeric: true, decimals: 0 },
        ],
        rows: markRows,
      },
    ];
    void exportToXlsxSheets(
      `activity_wise_${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleExport}
          disabled={sortedActivities.length === 0}
        >
          <FileSpreadsheet className="h-4 w-4" /> Export Excel
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile title="Marks" value={isLoading ? "..." : totalMarks.toLocaleString()} />
        <KpiTile title="Balance Weight" value={isLoading ? "..." : formatWeight(totalWt)} />
        <KpiTile title={`Avg Age (${agedCount.toLocaleString()} ageable)`} value={isLoading ? "..." : avgAge !== null ? `${avgAge}d` : "-"} />
        <KpiTile title="Activities" value={isLoading ? "..." : sortedActivities.length.toLocaleString()} />
      </div>

      {notAgedCount > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2 border border-border">
          Not aged: <span className="font-semibold text-foreground">{notAgedCount.toLocaleString()} marks ({notAgedWt.toFixed(3)} MT)</span> have no reference date (no Assign Date for pre-production, no Last Production Entry Date otherwise) — excluded from ageing buckets and averages above.
        </div>
      )}

      {isLoading ? (
        <div className="text-center p-8 text-muted-foreground text-sm">Loading activity data...</div>
      ) : sortedActivities.length === 0 ? (
        <div className="text-center p-8 text-muted-foreground">No activities found matching filters.</div>
      ) : (
        <ActivityPerformanceTable
          activities={activities}
          sortedActivities={sortedActivities}
          moveWindow={moveWindow}
          isDateFiltered={isDateFiltered}
        />
      )}
    </div>
  );
}
