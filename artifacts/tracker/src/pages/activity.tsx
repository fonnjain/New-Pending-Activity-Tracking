import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { ageingCell } from "@/lib/ageing";
import { StatusDot } from "@/components/status-dot";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { formatWeight } from "@/lib/utils";
import { useState, useMemo } from "react";
import { compareActivity } from "@workspace/domain";

const ROW_CAP = 300;

export default function ActivityView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <ActivityContent />;
}

function ActivityContent() {
  const { selectedImportId } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);

  const { activities, sortedActivities } = useMemo(() => {
    // Group by activity
    const activities = new Map<string, any[]>();
    records.forEach(r => {
      const act = r.activity || "Unassigned";
      if (!activities.has(act)) activities.set(act, []);
      activities.get(act)!.push(r);
    });

    const sortedActivities = Array.from(activities.keys()).sort(compareActivity);

    return { activities, sortedActivities };
  }, [records]);

  return (
    <div className="space-y-4">
      {sortedActivities.map(act => (
        <ActivityCard key={act} activity={act} records={activities.get(act)!} />
      ))}
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
            <div className="flex items-center gap-4 text-left">
              <div className="bg-secondary text-secondary-foreground font-bold w-12 h-12 flex items-center justify-center rounded-md text-lg shrink-0">
                {activity}
              </div>
              <div className="min-w-[120px]">
                <div className="font-bold text-lg">{formatWeight(wt)}</div>
                <div className="text-xs text-muted-foreground">{records.length} marks</div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div className="hidden sm:block">
                <div className="text-xs uppercase text-muted-foreground font-semibold">Avg Age</div>
                <div className={`font-bold text-lg ${getAgeingColor(avgAge)}`}>{avgAge !== null ? `${avgAge}d` : '-'}</div>
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
                      <TableCell className="font-mono font-medium whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><StatusDot activity={r.activity} ageingDays={r.ageingDays} project={r.job} category={r.category} ntltSubtype={r.ntltSubtype} />{r.markId}</span></TableCell>
                      <TableCell className="text-muted-foreground max-w-[150px] truncate">{r.section || '-'}</TableCell>
                      <TableCell className="text-right">{r.balanceQty}</TableCell>
                      <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{r.contractor || '-'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.assignDate || '-'}</TableCell>
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
