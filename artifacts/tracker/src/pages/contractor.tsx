import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetSnapshotRecords, getGetSnapshotRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";

export default function ContractorView() {
  const { selectedSnapshotId } = useTracker();
  if (!selectedSnapshotId) return <EmptyState />;
  return <ContractorContent />;
}

function ContractorContent() {
  const { selectedSnapshotId } = useTracker();
  const { data: allRecords } = useGetSnapshotRecords(selectedSnapshotId as number, {
    query: { enabled: !!selectedSnapshotId, queryKey: getGetSnapshotRecordsQueryKey(selectedSnapshotId as number) }
  });
  const records = useFilteredRecords(allRecords);

  const conMap = new Map<string, any[]>();
  records.forEach(r => {
    const c = r.contractor || "Unassigned";
    if (!conMap.has(c)) conMap.set(c, []);
    conMap.get(c)!.push(r);
  });

  const stats = Array.from(conMap.entries()).map(([name, recs]) => {
    const withAge = recs.filter(r => r.ageingDays !== null);
    return {
      name,
      marks: recs.length,
      qty: recs.reduce((sum, r) => sum + r.balanceQty, 0),
      weight: recs.reduce((sum, r) => sum + r.balanceWt, 0),
      avgAge: withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays!, 0) / withAge.length) : null,
      c0to30: withAge.filter(r => r.ageingDays !== null && r.ageingDays <= 30).length,
      c31to60: withAge.filter(r => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60).length,
      c60Plus: withAge.filter(r => r.ageingDays !== null && r.ageingDays > 60).length,
    };
  });

  // Sort by weight desc
  const sortedStats = [...stats].sort((a, b) => b.weight - a.weight);
  
  const unassignedCount = stats.find(s => s.name === "Unassigned")?.marks || 0;
  const busiest = sortedStats[0]?.name || "-";
  const mostAged = [...stats].sort((a, b) => (b.avgAge || 0) - (a.avgAge || 0))[0]?.name || "-";

  const maxWeight = Math.max(...sortedStats.map(s => s.weight), 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile title="Contractors" value={conMap.has("Unassigned") ? conMap.size - 1 : conMap.size} />
        <KpiTile title="Busiest (Wt)" value={busiest} />
        <KpiTile title="Most Aged" value={mostAged} />
        <KpiTile title="Unassigned Marks" value={unassignedCount} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Workload (kg)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {sortedStats.map(s => (
                <div key={s.name} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="font-semibold text-foreground">{s.name}</span>
                    <span className="text-muted-foreground font-mono">{Math.round(s.weight).toLocaleString()}</span>
                  </div>
                  <div className="h-2.5 bg-muted rounded-full overflow-hidden flex">
                    <div 
                      className="bg-secondary transition-all h-full" 
                      style={{ width: `${(s.weight / maxWeight) * 100}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground text-right">
                    {s.marks} marks • {s.qty} pcs
                  </div>
                </div>
              ))}
              {sortedStats.length === 0 && <div className="text-muted-foreground text-sm">No data available.</div>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Ageing Matrix (Marks)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contractor</TableHead>
                    <TableHead className="text-right">0-30</TableHead>
                    <TableHead className="text-right">31-60</TableHead>
                    <TableHead className="text-right">60+</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedStats.map(s => (
                    <TableRow key={s.name}>
                      <TableCell className="font-medium text-xs">{s.name}</TableCell>
                      <TableCell className={`text-right tabular-nums ${s.c0to30 > 0 ? 'bg-ageing-green/10 font-bold ageing-green' : 'text-muted-foreground'}`}>{s.c0to30}</TableCell>
                      <TableCell className={`text-right tabular-nums ${s.c31to60 > 0 ? 'bg-ageing-amber/10 font-bold ageing-amber' : 'text-muted-foreground'}`}>{s.c31to60}</TableCell>
                      <TableCell className={`text-right tabular-nums ${s.c60Plus > 0 ? 'bg-ageing-red/10 font-bold ageing-red' : 'text-muted-foreground'}`}>{s.c60Plus}</TableCell>
                      <TableCell className="text-right font-bold tabular-nums bg-muted/30">{s.c0to30 + s.c31to60 + s.c60Plus}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Summary</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contractor</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt (kg)</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedStats.map(s => (
                  <TableRow key={s.name}>
                    <TableCell className="font-bold">{s.name}</TableCell>
                    <TableCell className="text-right">{s.marks}</TableCell>
                    <TableCell className="text-right">{s.qty}</TableCell>
                    <TableCell className="text-right">{Math.round(s.weight)}</TableCell>
                    <TableCell className={`text-right font-bold tabular-nums ${getAgeingColor(s.avgAge)}`}>
                      {s.avgAge !== null ? `${s.avgAge}d` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
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
