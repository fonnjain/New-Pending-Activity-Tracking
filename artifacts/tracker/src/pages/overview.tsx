import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { formatWeight } from "@/lib/utils";
import { useMemo } from "react";
import { ChangesPanel } from "@/components/changes-panel";
import { ageingCell, isCutting } from "@/lib/ageing";

export default function Overview() {
  const { selectedImportId } = useTracker();
  
  if (!selectedImportId) {
    return <EmptyState />;
  }

  return <OverviewContent />;
}

function OverviewContent() {
  const { selectedImportId } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);

  const {
    totalMarks, totalQty, totalWt, avgAgeing, contractorsCount, structuresCount,
    topAgedMarks, busiestContractors, age0to30, age31to60, age60Plus,
    notStarted, noProductionDate, noAgeing,
    p0to30, p31to60, p60Plus, pNoAgeing,
  } = useMemo(() => {
    const totalMarks = records.length;
    const totalQty = records.reduce((sum, r) => sum + r.balanceQty, 0);
    const totalWt = records.reduce((sum, r) => sum + r.balanceWt, 0);

    const recordsWithAgeing = records.filter(r => r.ageingDays !== null);
    const avgAgeing = recordsWithAgeing.length ?
      Math.round(recordsWithAgeing.reduce((sum, r) => sum + (r.ageingDays || 0), 0) / recordsWithAgeing.length) : 0;

    const contractorsCount = new Set(records.map(r => r.contractor).filter(Boolean)).size;
    const structuresCount = new Set(records.map(r => r.structure).filter(Boolean)).size;

    const topAgedMarks = [...recordsWithAgeing]
      .sort((a, b) => (b.ageingDays || 0) - (a.ageingDays || 0))
      .slice(0, 8);

    const contractorMap = new Map<string, { weight: number, count: number }>();
    records.forEach(r => {
      const c = r.contractor || "Unassigned";
      if (!contractorMap.has(c)) contractorMap.set(c, { weight: 0, count: 0 });
      const stat = contractorMap.get(c)!;
      stat.weight += r.balanceWt;
      stat.count += 1;
    });

    const busiestContractors = Array.from(contractorMap.entries())
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 5);

    const age0to30 = recordsWithAgeing.filter(r => r.ageingDays !== null && r.ageingDays <= 30).length;
    const age31to60 = recordsWithAgeing.filter(r => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60).length;
    const age60Plus = recordsWithAgeing.filter(r => r.ageingDays !== null && r.ageingDays > 60).length;

    const noDate = records.filter(r => r.ageingDays === null);
    const notStarted = noDate.filter(r => isCutting(r.activity)).length;
    const noProductionDate = noDate.length - notStarted;
    const noAgeing = noDate.length;
    const totalAged = age0to30 + age31to60 + age60Plus + noAgeing || 1;

    return {
      totalMarks, totalQty, totalWt, avgAgeing, contractorsCount, structuresCount,
      topAgedMarks, busiestContractors, age0to30, age31to60, age60Plus,
      notStarted, noProductionDate, noAgeing,
      p0to30: (age0to30 / totalAged) * 100,
      p31to60: (age31to60 / totalAged) * 100,
      p60Plus: (age60Plus / totalAged) * 100,
      pNoAgeing: (noAgeing / totalAged) * 100,
    };
  }, [records]);

  return (
    <div className="space-y-6">
      {selectedImportId && <ChangesPanel importId={selectedImportId} />}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiTile title="Pending Marks" value={totalMarks} />
        <KpiTile title="Balance Qty" value={totalQty.toLocaleString()} />
        <KpiTile title="Balance Wt" value={formatWeight(totalWt)} />
        <KpiTile title="Avg Ageing (d)" value={avgAgeing} />
        <KpiTile title="Contractors" value={contractorsCount} />
        <KpiTile title="Structures" value={structuresCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Ageing Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-6 rounded-sm overflow-hidden mb-3">
            <div style={{ width: `${p0to30}%` }} className="bg-ageing-green transition-all" title="0-30 Days" />
            <div style={{ width: `${p31to60}%` }} className="bg-ageing-amber transition-all" title="31-60 Days" />
            <div style={{ width: `${p60Plus}%` }} className="bg-ageing-red transition-all" title="60+ Days" />
            <div style={{ width: `${pNoAgeing}%` }} className="bg-ageing-neutral transition-all" title="No ageing date" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-green" />0-30d ({age0to30})</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-amber" />31-60d ({age31to60})</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-ageing-red" />60d+ ({age60Plus})</div>
            <div className="flex items-center gap-1.5" title="Not started: activity C, no production date. No production date: progressed past cutting but date missing."><div className="w-3 h-3 rounded-sm bg-ageing-neutral" />No ageing date ({noAgeing}) — {notStarted} not started, {noProductionDate} no prod. date</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase text-muted-foreground tracking-wider">Top Aged Marks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topAgedMarks.map(m => (
                <div key={m.id} className="flex justify-between items-center text-sm p-2 bg-muted/30 hover:bg-muted/50 transition-colors rounded-md border border-transparent hover:border-border">
                  <div>
                    <div className="font-mono font-medium text-foreground">{m.markId}</div>
                    <div className="text-xs text-muted-foreground">{m.contractor || 'Unassigned'}</div>
                  </div>
                  <div className={`font-bold tabular-nums ${getAgeingColor(m.ageingDays)}`}>
                    {m.ageingDays}d
                  </div>
                </div>
              ))}
              {topAgedMarks.length === 0 && <div className="text-sm text-muted-foreground">No marks with assign dates.</div>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase text-muted-foreground tracking-wider">Busiest Contractors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {busiestContractors.map(([c, stats]) => (
                <div key={c} className="flex justify-between items-center text-sm p-2 bg-muted/30 hover:bg-muted/50 transition-colors rounded-md border border-transparent hover:border-border">
                  <div className="font-medium text-foreground">{c}</div>
                  <div className="text-right">
                    <div className="font-bold tabular-nums">{formatWeight(stats.weight)}</div>
                    <div className="text-xs text-muted-foreground">{stats.count} marks</div>
                  </div>
                </div>
              ))}
              {busiestContractors.length === 0 && <div className="text-sm text-muted-foreground">No contractors found.</div>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiTile({ title, value }: { title: string, value: string | number }) {
  return (
    <Card className="shadow-sm border-border bg-card">
      <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
        <p className="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 line-clamp-1">{title}</p>
        <p className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6">
      <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
      <h2 className="text-2xl font-bold mb-2">No Active Import</h2>
      <p className="text-muted-foreground max-w-md mb-8">
        Upload a balance and activity report to start tracking shop-floor progress and ageing.
      </p>
      <Link href="/data">
        <Button size="lg" className="px-8 font-bold tracking-wide">
          GO TO DATA UPLOAD
        </Button>
      </Link>
    </div>
  );
}

export function getAgeingColor(days: number | null): string {
  if (days === null) return "ageing-neutral";
  if (days <= 30) return "ageing-green";
  if (days <= 60) return "ageing-amber";
  return "ageing-red";
}

export function getAgeingBgColor(days: number | null): string {
  if (days === null) return "bg-ageing-neutral";
  if (days <= 30) return "bg-ageing-green";
  if (days <= 60) return "bg-ageing-amber";
  return "bg-ageing-red";
}
