import { lifecycleStatus, scopeFor, sequenceFor } from "@workspace/domain";
import { useSettings } from "@/lib/settings";
import { lifecycleBgColor, LIFECYCLE_LABELS } from "@/lib/turnaround";

// Small lifecycle indicator for per-mark tables. The fixed ageing-scale color
// stays on the Ageing column; this dot shows the cumulative-target lifecycle
// status (pre-warning before target, breach after). Renders nothing when the
// mark has no target / no ageing (status "na"), unless it is flagged stalled.
export function StatusDot({
  activity,
  ageingDays,
  project,
  category,
  ntltSubtype,
  groupKey,
  stalled = false,
}: {
  activity: string | null;
  ageingDays: number | null;
  project?: string | null;
  category?: string | null;
  ntltSubtype?: string | null;
  groupKey?: string | null;
  stalled?: boolean;
}) {
  const { settings } = useSettings();
  const res = lifecycleStatus(
    {
      activity,
      ageingDays,
      scope: scopeFor({ category, ntltSubtype, job: project, groupKey }),
      sequence: sequenceFor({ category, ntltSubtype }),
    },
    settings,
  );
  if (res.status === "na" && !stalled) return null;

  const base =
    res.target === null
      ? LIFECYCLE_LABELS[res.status]
      : res.overrun !== null && res.overrun > 0
        ? `${LIFECYCLE_LABELS[res.status]} — +${res.overrun}d over ${res.target}d target`
        : `${LIFECYCLE_LABELS[res.status]} — ${res.consumedPct ?? 0}% of ${res.target}d target` +
          (res.daysToTarget !== null ? ` (${res.daysToTarget}d to target)` : "");
  const title = stalled ? `${base} — stalled (no movement)` : base;

  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {res.status !== "na" && (
        <span
          className={`inline-block w-2 h-2 rounded-full ${lifecycleBgColor(res.status)}`}
          title={title}
        />
      )}
      {stalled && (
        <span
          className="inline-block w-2 h-2 rounded-sm bg-foreground/70 ring-1 ring-foreground/30"
          title={title}
        />
      )}
    </span>
  );
}
