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
  lifecycleStatus,
  migrateTurnaroundSettings,
  normalizeActivity,
  sortActivities,
  scopeFor,
  sequenceFor,
  LIFECYCLE_ORDER,
  type LifecycleStatus,
  type LifecycleResult,
} from "@workspace/domain";
import {
  LIFECYCLE_LABELS,
  LIFECYCLE_IS_BREACH,
  lifecycleBgColor,
  lifecycleTextColor,
} from "@/lib/turnaround";
import type { Record as ApiRecord } from "@workspace/api-client-react";

const STATUS_ORDER: LifecycleStatus[] = LIFECYCLE_ORDER;

function emptyCounts(): globalThis.Record<LifecycleStatus, number> {
  return {
    green: 0,
    prewarn1: 0,
    prewarn2: 0,
    prewarn3: 0,
    breach1: 0,
    breach2: 0,
    breach3: 0,
    na: 0,
  };
}

export function TurnaroundWarnings({ records }: { records: ApiRecord[] }) {
  const { settings: rawSettings } = useSettings();
  // Defensive: classify on normalized (validated, band-ordered) settings so a
  // transient in-flight draft with inverted bands can never mislabel a mark.
  const settings = useMemo(
    () => migrateTurnaroundSettings(rawSettings),
    [rawSettings],
  );

  const { counts, byActivity, drill } = useMemo(() => {
    const counts = emptyCounts();
    const actMap = new Map<
      string,
      {
        target: number | null;
        // With per-project overrides the same activity can resolve to different
        // targets across projects in a mixed-project set; flag that so we don't
        // show a single misleading number.
        targetVaries: boolean;
        counts: globalThis.Record<LifecycleStatus, number>;
        total: number;
      }
    >();
    const drill: Array<{ r: ApiRecord; res: LifecycleResult }> = [];

    for (const r of records) {
      const res = lifecycleStatus(
        { activity: r.activity, ageingDays: r.ageingDays, scope: scopeFor(r), sequence: sequenceFor(r) },
        settings,
      );
      counts[res.status]++;

      const norm = normalizeActivity(r.activity) || "—";
      let bucket = actMap.get(norm);
      if (!bucket) {
        bucket = {
          target: res.target,
          targetVaries: false,
          counts: emptyCounts(),
          total: 0,
        };
        actMap.set(norm, bucket);
      } else if (res.target !== bucket.target) {
        bucket.targetVaries = true;
      }
      bucket.counts[res.status]++;
      bucket.total++;

      if (LIFECYCLE_IS_BREACH[res.status]) {
        drill.push({ r, res });
      }
    }

    drill.sort((a, b) => (b.res.overrun ?? 0) - (a.res.overrun ?? 0));

    const orderedKeys = sortActivities([...actMap.keys()]);
    const byActivity = orderedKeys.map((k) => ({ activity: k, ...actMap.get(k)! }));

    return { counts, byActivity, drill };
  }, [records, settings]);

  const total = records.length;
  const preWarnTotal =
    counts.prewarn1 + counts.prewarn2 + counts.prewarn3;
  const breachTotal = counts.breach1 + counts.breach2 + counts.breach3;

  // When the filtered records belong to a single project that has its own
  // overrides, flag that custom (non-global) parameters are in effect.
  const customProject = useMemo(() => {
    const jobs = new Set<string>();
    for (const r of records) if (r.job) jobs.add(r.job);
    if (jobs.size !== 1) return null;
    const only = [...jobs][0];
    const ov = settings.perProject?.[only];
    return ov && Object.keys(ov).length > 0 ? only : null;
  }, [records, settings]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          Turnaround Lifecycle
          {customProject && (
            <span
              className="text-[10px] uppercase tracking-wider text-primary font-semibold normal-case"
              title={`Custom warning parameters are set for project ${customProject}`}
            >
              custom params
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Phase summary */}
        <div className="grid grid-cols-3 gap-3">
          <PhaseTile
            label="On track"
            value={counts.green}
            total={total}
            cls="bg-lc-green"
          />
          <PhaseTile
            label="Pre-warning"
            value={preWarnTotal}
            total={total}
            cls="bg-lc-prewarn2"
          />
          <PhaseTile
            label="Breached"
            value={breachTotal}
            total={total}
            cls="bg-lc-breach3"
          />
        </div>

        {/* Full 8-state strip */}
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
          {STATUS_ORDER.map((s) => (
            <div
              key={s}
              className="flex flex-col items-center justify-center rounded-md border border-border p-2 text-center"
            >
              <div className="flex items-center gap-1 mb-1">
                <span className={`w-3 h-3 rounded-sm ${lifecycleBgColor(s)}`} />
              </div>
              <span className="text-lg font-bold tabular-nums">{counts[s]}</span>
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground leading-tight">
                {LIFECYCLE_LABELS[s]}
              </span>
            </div>
          ))}
        </div>

        {/* Legend: pre-warning vs breach */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
          <span className="font-semibold uppercase tracking-wider">
            Pre-warning (within target):
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-prewarn1" /> 1
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-prewarn2" /> 2
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-prewarn3" /> 3
          </span>
          <span className="font-semibold uppercase tracking-wider">
            Breach (over target):
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-breach1" /> 1
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-breach2" /> 2
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-lc-breach3" /> 3
          </span>
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
                  {a.targetVaries
                    ? "target varies"
                    : a.target === null
                      ? "no target"
                      : `target ${a.target}d`}
                </span>
                <div className="flex h-4 flex-1 rounded-sm overflow-hidden min-w-[80px]">
                  {STATUS_ORDER.map((s) =>
                    a.counts[s] > 0 ? (
                      <div
                        key={s}
                        className={lifecycleBgColor(s)}
                        style={{ width: `${(a.counts[s] / a.total) * 100}%` }}
                        title={`${LIFECYCLE_LABELS[s]}: ${a.counts[s]}`}
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

        {/* Breach drill list */}
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            Over target ({drill.length})
          </div>
          {drill.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Nothing past the target. Good standing.
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
                        className={`py-1.5 pr-3 text-right tabular-nums font-bold ${lifecycleTextColor(res.status)}`}
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

function PhaseTile({
  label,
  value,
  total,
  cls,
}: {
  label: string;
  value: number;
  total: number;
  cls: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-border p-3 text-center">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-3 h-3 rounded-sm ${cls}`} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {total ? Math.round((value / total) * 100) : 0}%
      </span>
    </div>
  );
}
