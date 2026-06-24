import { alertStatus } from "@workspace/domain";
import { useSettings } from "@/lib/settings";
import { statusBgColor, ALERT_LABELS } from "@/lib/turnaround";

// Small turnaround-alert indicator for per-mark tables. The fixed ageing-scale
// color stays on the Ageing column; this dot shows the cumulative-target status.
// Renders nothing when the mark has no target / no ageing (status "na").
export function StatusDot({
  activity,
  ageingDays,
}: {
  activity: string | null;
  ageingDays: number | null;
}) {
  const { settings } = useSettings();
  const res = alertStatus({ activity, ageingDays }, settings);
  if (res.status === "na") return null;
  const title =
    res.overrun !== null && res.overrun > 0
      ? `${ALERT_LABELS[res.status]} — +${res.overrun}d over ${res.target}d target`
      : `${ALERT_LABELS[res.status]} — within ${res.target}d target`;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusBgColor(res.status)}`}
      title={title}
    />
  );
}
