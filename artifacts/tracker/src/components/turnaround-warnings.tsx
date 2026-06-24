import { useMemo } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { formatWeight } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import {
  alertStatus,
  cumulativeTargets,
  normalizeActivity,
  sortActivities,
  type AlertStatus,
  type AlertResult,
} from "@workspace/domain";
import {
  ALERT_LABELS,
  statusBgColor,
  statusTextColor,
} from "@/lib/turnaround";
import type { Record as ApiRecord } from "@workspace/api-client-react";

const STATUS_ORDER: AlertStatus[] = ["green", "yellow", "orange", "red", "na"];

function emptyCounts(): globalThis.Record<AlertStatus, number> {
  return { green: 0, yellow: 0, orange: 0, red: 0, na: 0 };
}

export function TurnaroundWarnings({ records }: { records: ApiRecord[] }) {
  const { settings } = useSettings();

  const { counts, byActivity, drill } = useMemo(() => {
    const cumTargets = cumulativeTargets(settings.idealDays);
    const counts = emptyCounts();
    const actMap = new Map<
      string,
      { target: number | null; counts: globalThis.Record<AlertStatus, number>; total: number }
    >();
    const drill: Array<{ r: ApiRecord; res: AlertResult }> = [];

    for (const r of records) {
      const res = alertStatus(
        { activity: r.activity, ageingDays: r.ageingDays },
        settings,
      );
      counts[res.status]++;

      const norm = normalizeActivity(r.activity) || "—";
      let bucket = actMap.get(norm);
      if (!bucket) {
        bucket = {
          target: res.target,
          counts: emptyCounts(),
          total: 0,
        };
        actMap.set(norm, bucket);
      }
      bucket.counts[res.status]++;
      bucket.total++;

      if (res.status === "orange" || res.status === "red") {
        drill.push({ r, res });
      }
    }

    drill.sort((a, b) => (b.res.overrun ?? 0) - (a.res.overrun ?? 0));

    const orderedKeys = sortActivities([...actMap.keys()]);
    const byActivity = orderedKeys.map((k) => ({ activity: k, ...actMap.get(k)! }));

    return { counts, byActivity, drill };
  }, [records, settings]);

  const total = records.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
          Turnaround Warnings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary strip */}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          {STATUS_ORDER.map((s) => (
            <div
              key={s}
              className="flex flex-col items-center justify-center rounded-md border border-border p-3 text-center"
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`w-3 h-3 rounded-sm ${statusBgColor(s)}`} />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {ALERT_LABELS[s]}
                </span>
              </div>
              <span className="text-2xl font-bold tabular-nums">
                {counts[s]}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {total ? Math.round((counts[s] / total) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>

        {/* Per-activity breakdown */}
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            By activity
          </div>
          <div className="space-y-1.5">
            {byActivity.map((a) => (
              <div
                key={a.activity}
                className="flex items-center gap-3 text-sm"
              >
                <span className="font-mono font-medium w-10 shrink-0">
                  {a.activity}
                </span>
                <span className="text-xs text-muted-foreground w-20 shrink-0 tabular-nums">
                  {a.target === null ? "no target" : `target ${a.target}d`}
                </span>
                <div className="flex h-4 flex-1 rounded-sm overflow-hidden min-w-[80px]">
                  {STATUS_ORDER.map((s) =>
                    a.counts[s] > 0 ? (
                      <div
                        key={s}
                        className={statusBgColor(s)}
                        style={{ width: `${(a.counts[s] / a.total) * 100}%` }}
                        title={`${ALERT_LABELS[s]}: ${a.counts[s]}`}
                      />
                    ) : null,
                  )}
                </div>
                <span className="text-xs text-muted-foreground w-10 text-right tabular-nums shrink-0">
                  {a.total}
                </span>
              </div>
            ))}
            {byActivity.length === 0 && (
              <div className="text-sm text-muted-foreground">
                No records for the selected filters.
              </div>
            )}
          </div>
        </div>

        {/* Orange/Red drill list */}
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            Over target ({drill.length})
          </div>
          {drill.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Nothing past the orange threshold. Good standing.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">Mark</th>
                    <th className="py-1.5 pr-3 font-medium">Activity</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Ageing</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Target</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Overrun</th>
                    <th className="py-1.5 pr-3 font-medium">Contractor</th>
                    <th className="py-1.5 font-medium text-right">Wt</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.slice(0, 100).map(({ r, res }) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/50 hover:bg-muted/30"
                    >
                      <td className="py-1.5 pr-3 font-mono">{r.markId}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.activity}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {r.ageingDays}d
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {res.target}d
                      </td>
                      <td
                        className={`py-1.5 pr-3 text-right tabular-nums font-bold ${statusTextColor(res.status)}`}
                      >
                        +{res.overrun}d
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.contractor || "Unassigned"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatWeight(r.balanceWt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {drill.length > 100 && (
                <div className="text-xs text-muted-foreground mt-2">
                  Showing top 100 of {drill.length} by overrun.
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
