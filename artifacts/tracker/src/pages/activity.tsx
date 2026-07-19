import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { StatusDot } from "@/components/status-dot";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell, TableFooter } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportToXlsxSheets, type XlsxSheet } from "@/lib/export";
import { formatWeight, formatDate } from "@/lib/utils";
import { useState, useMemo } from "react";
import { compareActivity } from "@workspace/domain";
import { useSettings } from "@/lib/settings";

const ROW_CAP = 300;

function ActivityPerformanceTable({
  activities,
  sortedActivities,
}: {
  activities: Map<string, any[]>;
  sortedActivities: string[];
}) {
  const { settings } = useSettings();

  const idealDaysMap = useMemo(() => {
    const m = new Map<string, number>();
    const acts = settings?.activities ?? {};
    for (const [code, cfg] of Object.entries(acts)) {
      if (cfg?.idealDays != null) {
        m.set(code.toUpperCase(), cfg.idealDays);
      }
    }
    return m;
  }, [settings]);

  const rows = useMemo(() =>
    sortedActivities.map((act) => {
      const recs = activities.get(act)!;
      const projects = new Set<string>();
      const contractors = new Set<string>();
      let weightMt = 0;
      let aged0to30 = 0;
      let aged31to60 = 0;
      let aged60plus = 0;
      let notAged = 0;
      let ageSum = 0;
      let agedCount = 0;

      for (const r of recs) {
        if (r.job) projects.add(r.job);
        if (r.contractor) contractors.add(r.contractor);
        weightMt += r.balanceWt ?? 0;
        const d = r.ageingDays as number | null;
        if (d == null) {
          notAged++;
        } else {
          agedCount++;
          ageSum += d;
          if (d <= 30) aged0to30++;
          else if (d <= 60) aged31to60++;
          else aged60plus++;
        }
      }

      const avgAge = agedCount > 0 ? Math.round(ageSum / agedCount) : null;
      const idealDays = idealDaysMap.get(act.toUpperCase()) ?? null;

      return {
        act,
        marks: recs.length,
        weightMt,
        projects: projects.size,
        contractors: contractors.size,
        avgAge,
        aged0to30,
        aged31to60,
        aged60plus,
        notAged,
        idealDays,
      };
    }),
    [sortedActivities, activities, idealDaysMap],
  );

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Activity Performance Summary</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Activity</TableHead>
                <TableHead className="text-right">Marks</TableHead>
                <TableHead className="text-right">Wt (MT)</TableHead>
                <TableHead className="text-right">Projects</TableHead>
                <TableHead className="text-right">Contractors</TableHead>
                <TableHead className="text-right">Avg Age</TableHead>
                <TableHead className="text-right">0-30d</TableHead>
                <TableHead className="text-right">31-60d</TableHead>
                <TableHead className="text-right">&gt;60d</TableHead>
                <TableHead className="text-right">Not Aged</TableHead>
                <TableHead className="text-right">Ideal Days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.act}>
                  <TableCell>
                    <span className="inline-flex items-center justify-center bg-secondary text-secondary-foreground font-bold w-8 h-7 rounded text-xs">
                      {r.act}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.marks.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.weightMt.toFixed(3)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.projects}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.contractors}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${getAgeingColor(r.avgAge)}`}>
                    {r.avgAge != null ? `${r.avgAge}d` : "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-green-600 dark:text-green-400">{r.aged0to30}</TableCell>
                  <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">{r.aged31to60}</TableCell>
                  <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">{r.aged60plus}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{r.notAged}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.idealDays != null ? `${r.idealDays}d` : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter className="sticky bottom-0 z-10 bg-muted">
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right tabular-nums font-bold">
                  {rows.reduce((s, r) => s + r.marks, 0).toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums font-bold">
                  {rows.reduce((s, r) => s + r.weightMt, 0).toFixed(3)}
                </TableCell>
                <TableCell colSpan={8} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

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
  const { selectedImportId } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);

  const { activities, sortedActivities, totalWt, totalMarks, avgAge, notAgedCount, notAgedWt, agedCount } = useMemo(() => {
    // Group by activity. Initial Cutting marks (isInitialCutting=true) are
    // excluded from the "C" bucket — they are Release Balance, not active Cutting.
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
        <KpiTile title="Marks" value={totalMarks.toLocaleString()} />
        <KpiTile title="Balance Weight" value={formatWeight(totalWt)} />
        <KpiTile title={`Avg Age (${agedCount.toLocaleString()} ageable)`} value={avgAge !== null ? `${avgAge}d` : "-"} />
        <KpiTile title="Activities" value={sortedActivities.length.toLocaleString()} />
      </div>
      {notAgedCount > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2 border border-border">
          Not aged: <span className="font-semibold text-foreground">{notAgedCount.toLocaleString()} marks ({notAgedWt.toFixed(3)} MT)</span> have no reference date (no Assign Date for pre-production, no Last Production Entry Date otherwise) — excluded from ageing buckets and averages above.
        </div>
      )}

      <ActivityPerformanceTable activities={activities} sortedActivities={sortedActivities} />

      <div className="space-y-3">
        {sortedActivities.map(act => (
          <ActivityCard key={act} activity={act} records={activities.get(act)!} />
        ))}
      </div>
      {sortedActivities.length === 0 && <div className="text-center p-8 text-muted-foreground">No activities found matching filters.</div>}
    </div>
  );
}

function ActivityCard({ activity, records }: { activity: string, records: any[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  
  const wt = records.reduce((sum, r) => sum + r.balanceWt, 0);
  
  const withAge = records.filter(r => r.ageingDays !== null);
  const avgAge = withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays, 0) / withAge.length) : null;
  const notAged = records.filter(r => r.ageingDays === null);
  const notAgedCount = notAged.length;
  const notAgedWt = notAged.reduce((s, r) => s + (r.balanceWt ?? 0), 0);

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
          <div className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-3 text-left">
              <div className="bg-secondary text-secondary-foreground font-bold w-9 h-9 flex items-center justify-center rounded-md text-sm shrink-0">
                {activity}
              </div>
              <div className="min-w-[88px]">
                <div className="font-bold text-lg">{formatWeight(wt)}</div>
                <div className="text-xs text-muted-foreground">{records.length} marks</div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div className="hidden sm:block">
                <div className="text-xs uppercase text-muted-foreground font-semibold">Avg Age ({withAge.length.toLocaleString()} ageable)</div>
                <div className={`font-bold text-lg ${getAgeingColor(avgAge)}`}>{avgAge !== null ? `${avgAge}d` : '-'}</div>
                {notAgedCount > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Not aged: {notAgedCount.toLocaleString()} marks ({notAgedWt.toFixed(3)} MT)
                  </div>
                )}
              </div>
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
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
                    <TableHead className="text-right">Thick.</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Wt</TableHead>
                    <TableHead>Contractor</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Ageing</TableHead>
                    <TableHead className="text-center">Route</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap">{r.job || '-'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.structure || '-'}</TableCell>
                      <TableCell className="font-mono font-medium whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><StatusDot activity={r.activity} ageingDays={r.ageingDays} project={r.job} category={r.category} ntltSubtype={r.ntltSubtype} groupKey={r.groupKey} />{r.markId}</span></TableCell>
                      <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || '-'}</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap" title={r.thicknessSource ?? 'unset'}>
                        {r.thicknessMm != null ? `${r.thicknessMm} mm` : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="text-right">{r.balanceQty}</TableCell>
                      <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{r.contractor || '-'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(r.assignDate)}</TableCell>
                      <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(r.ageingDays)}`}>
                        {ageingCell(r)}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.routeSteps && r.routeSteps.length > 0 ? (
                          <div className="flex gap-0.5 justify-center items-center">
                            {r.routeSteps.map((step: string, i: number) => {
                              const isActive = r.currentStepIndex !== null && r.currentStepIndex >= i;
                              const isCurrent = r.currentStepIndex === i;
                              return (
                                <div 
                                  key={i} 
                                  title={step} 
                                  className={`w-2 h-2 rounded-full ${isCurrent ? 'bg-primary ring-2 ring-primary/30' : isActive ? 'bg-secondary' : 'bg-muted border border-border'}`}
                                />
                              );
                            })}
                          </div>
                        ) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter className="sticky bottom-0 z-10 bg-muted">
                  <TableRow>
                    <TableCell colSpan={5} className="font-semibold">Total ({records.length.toLocaleString()} marks)</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{records.reduce((s, r) => s + (r.balanceQty ?? 0), 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{formatWeight(wt)}</TableCell>
                    <TableCell colSpan={4} />
                  </TableRow>
                </TableFooter>
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
                    or use the filters/search to narrow down.
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
