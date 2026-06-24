import { useMemo } from "react";
import { useTracker, useFilteredRecords } from "@/lib/store";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type Record as ApiRecord,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { formatWeight } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import {
  lifecycleStatus,
  migrateTurnaroundSettings,
  type LifecycleResult,
} from "@workspace/domain";
import { LIFECYCLE_LABELS, lifecycleBgColor, lifecycleTextColor } from "@/lib/turnaround";
import { TurnaroundWarnings } from "@/components/turnaround-warnings";
import { AiTurnaroundReport } from "@/components/ai-turnaround-report";
import { EmptyState } from "./overview";
import { SlidersHorizontal, Clock } from "lucide-react";

export default function TurnaroundView() {
  const { selectedImportId } = useTracker();
  if (!selectedImportId) return <EmptyState />;
  return <TurnaroundContent importId={selectedImportId} />;
}

function TurnaroundContent({ importId }: { importId: number }) {
  const { data: allRecords } = useGetImportRecords(importId, {
    query: { enabled: true, queryKey: getGetImportRecordsQueryKey(importId) },
  });
  const records = useFilteredRecords(allRecords);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" /> Turnaround
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Deep dive into how marks are tracking against their cumulative
            targets. Advisory and display-only — never changes ageing, activity,
            or thresholds.
          </p>
        </div>
        <Link href="/warning-parameters">
          <Button variant="outline" size="sm" className="h-8 gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            Warning Parameters
          </Button>
        </Link>
      </div>

      <TurnaroundWarnings records={records} />
      <ContractorOverrun records={records} />
      <UrgencyWorklist records={records} />
      <AiTurnaroundReport />
    </div>
  );
}

// Average overrun (and breach counts) grouped by contractor, worst first.
function ContractorOverrun({ records }: { records: ApiRecord[] }) {
  const { settings: rawSettings } = useSettings();
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );

  const rows = useMemo(() => {
    const map = new Map<
      string,
      { total: number; breached: number; overrunSum: number; overrunCount: number }
    >();
    for (const r of records) {
      const res = lifecycleStatus(
        { activity: r.activity, ageingDays: r.ageingDays, project: r.job },
        settings,
      );
      const key = r.contractor || "Unassigned";
      const g = map.get(key) ?? { total: 0, breached: 0, overrunSum: 0, overrunCount: 0 };
      g.total++;
      if (res.status.startsWith("breach")) g.breached++;
      if (res.overrun !== null && res.overrun > 0) {
        g.overrunSum += res.overrun;
        g.overrunCount++;
      }
      map.set(key, g);
    }
    return [...map.entries()]
      .map(([contractor, g]) => ({
        contractor,
        total: g.total,
        breached: g.breached,
        avgOverrun: g.overrunCount ? Math.round(g.overrunSum / g.overrunCount) : null,
      }))
      .sort(
        (a, b) =>
          (b.avgOverrun ?? -1) - (a.avgOverrun ?? -1) || b.breached - a.breached,
      );
  }, [records, settings]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Overrun by Contractor
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No records for the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Contractor</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Marks</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Breached</th>
                  <th className="py-1.5 font-medium text-right">Avg Overrun</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((g) => (
                  <tr key={g.contractor} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-1.5 pr-3">{g.contractor}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{g.total}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {g.breached > 0 ? (
                        <span className="font-semibold text-ageing-red">{g.breached}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-semibold">
                      {g.avgOverrun !== null ? `+${g.avgOverrun}d` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && (
              <div className="text-xs text-muted-foreground mt-2">
                Showing top 50 of {rows.length}.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Marks within target, ordered by days-to-target ascending — the soonest to
// breach come first. Excludes already-breached (those are in TurnaroundWarnings)
// and n/a marks.
function UrgencyWorklist({ records }: { records: ApiRecord[] }) {
  const { settings: rawSettings } = useSettings();
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );

  const items = useMemo(() => {
    const out: Array<{ r: ApiRecord; res: LifecycleResult }> = [];
    for (const r of records) {
      const res = lifecycleStatus(
        { activity: r.activity, ageingDays: r.ageingDays, project: r.job },
        settings,
      );
      if (res.status === "na" || res.status.startsWith("breach")) continue;
      if (res.daysToTarget === null) continue;
      out.push({ r, res });
    }
    out.sort((a, b) => (a.res.daysToTarget ?? Infinity) - (b.res.daysToTarget ?? Infinity));
    return out;
  }, [records, settings]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Closest to Target ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No within-target marks with a defined target for the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Mark</th>
                  <th className="py-1.5 pr-3 font-medium">Activity</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Ageing</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Target</th>
                  <th className="py-1.5 pr-3 font-medium text-right">To Target</th>
                  <th className="py-1.5 pr-3 font-medium">Contractor</th>
                  <th className="py-1.5 font-medium text-right">Wt</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 100).map(({ r, res }) => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-1.5 pr-3 font-mono">{r.markId}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.activity}</td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${lifecycleBgColor(res.status)}`} />
                        <span className={`text-xs font-semibold ${lifecycleTextColor(res.status)}`}>
                          {LIFECYCLE_LABELS[res.status]}
                        </span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {r.ageingDays !== null ? `${r.ageingDays}d` : "-"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {res.target !== null ? `${res.target}d` : "-"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">
                      {res.daysToTarget !== null ? `${res.daysToTarget}d` : "-"}
                    </td>
                    <td className="py-1.5 pr-3">{r.contractor || "Unassigned"}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatWeight(r.balanceWt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length > 100 && (
              <div className="text-xs text-muted-foreground mt-2">
                Showing closest 100 of {items.length}.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
