import { useTracker, useFilteredRecords } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import { EmptyState, getAgeingColor } from "./overview";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { formatWeight } from "@/lib/utils";
import { Search, ChevronLeft } from "lucide-react";

const ROW_CAP = 200;

export default function AgeingView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <AgeingContent />;
}

function AgeingContent() {
  const { selectedImportId } = useTracker();
  const { data: allRecords } = useGetImportRecords(selectedImportId as number, {
    query: { enabled: !!selectedImportId, queryKey: getGetImportRecordsQueryKey(selectedImportId as number) }
  });
  const records = useFilteredRecords(allRecords);
  const [search, setSearch] = useState("");

  const [drill, setDrill] = useState<{ type: "contractor" | "activity"; value: string } | null>(null);

  const {
    totalMarks, totalQty, totalWt, avgAgeing, age0to30, age31to60, age60Plus, actStats, ctrStats,
  } = useMemo(() => {
    const withAge = records.filter(r => r.ageingDays !== null);
    const totalMarks = records.length;
    const totalQty = records.reduce((sum, r) => sum + r.balanceQty, 0);
    const totalWt = records.reduce((sum, r) => sum + r.balanceWt, 0);
    const avgAgeing = withAge.length ? Math.round(withAge.reduce((sum, r) => sum + r.ageingDays!, 0) / withAge.length) : 0;

    const age0to30 = withAge.filter(r => r.ageingDays !== null && r.ageingDays <= 30);
    const age31to60 = withAge.filter(r => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60);
    const age60Plus = withAge.filter(r => r.ageingDays !== null && r.ageingDays > 60);

    // Group by activity for matrix
    const activities = new Map<string, any[]>();
    records.forEach(r => {
      const act = r.activity || "Unassigned";
      if (!activities.has(act)) activities.set(act, []);
      activities.get(act)!.push(r);
    });

    const actStats = Array.from(activities.entries()).map(([act, actRecs]) => {
      const actWithAge = actRecs.filter(r => r.ageingDays !== null);
      return {
        activity: act,
        marks: actRecs.length,
        qty: actRecs.reduce((sum, r) => sum + r.balanceQty, 0),
        weight: actRecs.reduce((sum, r) => sum + r.balanceWt, 0),
        avgAge: actWithAge.length ? Math.round(actWithAge.reduce((sum, r) => sum + r.ageingDays!, 0) / actWithAge.length) : null,
        c0to30: actWithAge.filter(r => r.ageingDays !== null && r.ageingDays <= 30).length,
        c31to60: actWithAge.filter(r => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60).length,
        c60Plus: actWithAge.filter(r => r.ageingDays !== null && r.ageingDays > 60).length,
      };
    }).sort((a, b) => (b.avgAge || 0) - (a.avgAge || 0));

    // Group by contractor
    const contractors = new Map<string, any[]>();
    records.forEach(r => {
      const c = r.contractor || "No Contractor";
      if (!contractors.has(c)) contractors.set(c, []);
      contractors.get(c)!.push(r);
    });
    const ctrStats = Array.from(contractors.entries()).map(([contractor, recs]) => {
      const wAge = recs.filter(r => r.ageingDays !== null);
      return {
        contractor,
        marks: recs.length,
        qty: recs.reduce((s, r) => s + r.balanceQty, 0),
        weight: recs.reduce((s, r) => s + r.balanceWt, 0),
        avgAge: wAge.length ? Math.round(wAge.reduce((s, r) => s + r.ageingDays!, 0) / wAge.length) : null,
        c0to30: wAge.filter(r => r.ageingDays !== null && r.ageingDays <= 30).length,
        c31to60: wAge.filter(r => r.ageingDays !== null && r.ageingDays > 30 && r.ageingDays <= 60).length,
        c60Plus: wAge.filter(r => r.ageingDays !== null && r.ageingDays > 60).length,
      };
    }).sort((a, b) => (b.avgAge || 0) - (a.avgAge || 0));

    return { totalMarks, totalQty, totalWt, avgAgeing, age0to30, age31to60, age60Plus, actStats, ctrStats };
  }, [records]);

  const sortedFull = useMemo(
    () => [...records].sort((a, b) => (b.ageingDays || 0) - (a.ageingDays || 0)),
    [records]
  );

  const filteredFull = useMemo(() => {
    if (!search) return sortedFull;
    const q = search.toLowerCase();
    return sortedFull.filter(r =>
      r.markId.toLowerCase().includes(q) || r.contractor?.toLowerCase().includes(q) || r.section?.toLowerCase().includes(q)
    );
  }, [sortedFull, search]);

  const visibleFull = filteredFull.slice(0, ROW_CAP);

  if (drill) {
    const detailRecords = records.filter(r =>
      drill.type === "contractor"
        ? (r.contractor || "No Contractor") === drill.value
        : (r.activity || "Unassigned") === drill.value
    );
    return (
      <AgeingDetail
        title={drill.value}
        subtitle={drill.type === "contractor" ? "Contractor" : "Activity"}
        records={detailRecords}
        onBack={() => setDrill(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile title="Pending Marks" value={totalMarks} />
        <KpiTile title="Balance Qty" value={totalQty.toLocaleString()} />
        <KpiTile title="Balance Wt" value={formatWeight(totalWt)} />
        <KpiTile title="Avg Ageing (d)" value={avgAgeing} />
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <BucketCard title="0-30 Days" records={age0to30} colorClass="bg-ageing-green" textColorClass="ageing-green" />
        <BucketCard title="31-60 Days" records={age31to60} colorClass="bg-ageing-amber" textColorClass="ageing-amber" />
        <BucketCard title="60+ Days" records={age60Plus} colorClass="bg-ageing-red" textColorClass="ageing-red" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Contractor-wise Ageing</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[500px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                <TableRow>
                  <TableHead>Contractor</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                  <TableHead className="text-right">0-30</TableHead>
                  <TableHead className="text-right">31-60</TableHead>
                  <TableHead className="text-right">60+</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ctrStats.map(stat => (
                  <TableRow
                    key={stat.contractor}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setDrill({ type: "contractor", value: stat.contractor })}
                  >
                    <TableCell className="font-bold">{stat.contractor}</TableCell>
                    <TableCell className="text-right">{stat.marks}</TableCell>
                    <TableCell className="text-right">{stat.qty}</TableCell>
                    <TableCell className="text-right">{formatWeight(stat.weight)}</TableCell>
                    <TableCell className={`text-right font-bold ${getAgeingColor(stat.avgAge)}`}>{stat.avgAge !== null ? `${stat.avgAge}d` : '-'}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c0to30}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c31to60}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c60Plus}</TableCell>
                  </TableRow>
                ))}
                {ctrStats.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-4 text-muted-foreground">No contractors to display.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Activity-wise Ageing</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Marks</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Avg Ageing</TableHead>
                  <TableHead className="text-right">0-30</TableHead>
                  <TableHead className="text-right">31-60</TableHead>
                  <TableHead className="text-right">60+</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actStats.map(stat => (
                  <TableRow
                    key={stat.activity}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setDrill({ type: "activity", value: stat.activity })}
                  >
                    <TableCell className="font-bold">{stat.activity}</TableCell>
                    <TableCell className="text-right">{stat.marks}</TableCell>
                    <TableCell className="text-right">{stat.qty}</TableCell>
                    <TableCell className="text-right">{formatWeight(stat.weight)}</TableCell>
                    <TableCell className={`text-right font-bold ${getAgeingColor(stat.avgAge)}`}>{stat.avgAge !== null ? `${stat.avgAge}d` : '-'}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c0to30}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c31to60}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{stat.c60Plus}</TableCell>
                  </TableRow>
                ))}
                {actStats.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-4 text-muted-foreground">No activities to display.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">Full Pending Work</CardTitle>
            <span className="text-xs text-muted-foreground">
              {filteredFull.length > ROW_CAP
                ? `Showing top ${ROW_CAP} of ${filteredFull.length} — refine with search or filters`
                : `${filteredFull.length} marks`}
            </span>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search marks..."
              className="pl-9 h-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[600px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                <TableRow>
                  <TableHead>Mark</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Contractor</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                  <TableHead className="text-right">Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleFull.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono font-medium">{r.markId}</TableCell>
                    <TableCell className="text-xs truncate max-w-[150px]">{r.section}</TableCell>
                    <TableCell className="text-xs font-semibold">{r.activity}</TableCell>
                    <TableCell className="text-xs">{r.contractor}</TableCell>
                    <TableCell className="text-right">{r.balanceQty}</TableCell>
                    <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">{r.assignDate}</TableCell>
                    <TableCell className={`text-right font-bold ${getAgeingColor(r.ageingDays)}`}>
                      {r.ageingDays !== null ? `${r.ageingDays}d` : '-'}
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

function AgeingDetail({ title, subtitle, records, onBack }: { title: string, subtitle: string, records: any[], onBack: () => void }) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () => [...records].sort((a, b) => (b.ageingDays || 0) - (a.ageingDays || 0)),
    [records]
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(r =>
      [r.markId, r.structure, r.section, r.activity, r.contractor].some(v =>
        String(v ?? "").toLowerCase().includes(q)
      )
    );
  }, [sorted, search]);

  const totalQty = useMemo(() => filtered.reduce((s, r) => s + r.balanceQty, 0), [filtered]);
  const totalWt = useMemo(() => filtered.reduce((s, r) => s + r.balanceWt, 0), [filtered]);
  const visible = showAll ? filtered : filtered.slice(0, ROW_CAP);

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
          <p className="text-xs text-muted-foreground uppercase tracking-wider">{subtitle}</p>
          <h2 className="text-xl font-bold tracking-tight truncate">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {filtered.length.toLocaleString()} marks • {totalQty.toLocaleString()} pcs • {formatWeight(totalWt)}
          </p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search mark, structure, section, activity..."
          className="pl-9"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[600px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                <TableRow>
                  <TableHead>Mark</TableHead>
                  <TableHead>Structure</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Contractor</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Wt</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                  <TableHead className="text-right">Ageing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono font-medium whitespace-nowrap">{r.markId}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.structure || '-'}</TableCell>
                    <TableCell className="text-xs truncate max-w-[150px]">{r.section}</TableCell>
                    <TableCell className="text-xs font-semibold">{r.activity}</TableCell>
                    <TableCell className="text-xs">{r.contractor}</TableCell>
                    <TableCell className="text-right">{r.balanceQty}</TableCell>
                    <TableCell className="text-right">{formatWeight(r.balanceWt)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">{r.assignDate}</TableCell>
                    <TableCell className={`text-right font-bold ${getAgeingColor(r.ageingDays)}`}>
                      {r.ageingDays !== null ? `${r.ageingDays}d` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-4 text-muted-foreground">No marks found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {filtered.length > ROW_CAP && (
            <div className="p-3 text-center text-xs text-muted-foreground border-t">
              {showAll ? (
                <span>
                  Showing all {filtered.length.toLocaleString()} marks.{" "}
                  <button type="button" onClick={() => setShowAll(false)} className="text-primary font-medium hover:underline">Show less</button>
                </span>
              ) : (
                <span>
                  Showing first {ROW_CAP.toLocaleString()} of {filtered.length.toLocaleString()} marks.{" "}
                  <button type="button" onClick={() => setShowAll(true)} className="text-primary font-medium hover:underline">Show all</button>{" "}
                  or search to narrow.
                </span>
              )}
            </div>
          )}
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
        <p className="text-xl sm:text-2xl font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function BucketCard({ title, records, colorClass, textColorClass }: { title: string, records: any[], colorClass: string, textColorClass: string }) {
  const marks = records.length;
  const wt = records.reduce((sum, r) => sum + r.balanceWt, 0);
  
  return (
    <Card className={`border-l-4 ${colorClass.replace('bg-', 'border-')}`}>
      <CardContent className="p-4">
        <h4 className={`text-sm font-bold uppercase tracking-wider mb-2 ${textColorClass}`}>{title}</h4>
        <div className="flex justify-between items-end">
          <div className="text-2xl font-bold">{marks} <span className="text-sm font-normal text-muted-foreground">marks</span></div>
          <div className="text-sm font-medium text-muted-foreground">{formatWeight(wt)}</div>
        </div>
      </CardContent>
    </Card>
  );
}
