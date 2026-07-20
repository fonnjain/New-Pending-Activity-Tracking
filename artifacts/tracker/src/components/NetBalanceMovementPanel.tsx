import type { ProductionMovementDay } from "@workspace/api-client-react";
import { compareActivity } from "@workspace/domain";
import { Card } from "@/components/ui/card";

function netBalanceCellClass(v: number): string {
  const abs = Math.abs(v);
  if (abs < 0.5) return "text-muted-foreground";
  if (v < 0) return "text-green-700 font-medium";
  if (v < 10) return "text-amber-600 font-medium";
  return "text-red-600 font-semibold";
}

function fmtNetDelta(v: number): string {
  const abs = Math.abs(v);
  if (abs < 0.01) return "-";
  const sign = v > 0 ? "+" : "-";
  const num = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  return sign + num;
}

interface Props {
  days: ProductionMovementDay[];
  isLoading?: boolean;
}

export function NetBalanceMovementPanel({ days, isLoading = false }: Props) {
  if (!isLoading && days.length === 0) return null;

  const actSet = new Set<string>();
  for (const day of days) {
    for (const act of Object.keys(day.netBalance)) {
      actSet.add(act);
    }
  }
  const sortedActs = [...actSet].sort(compareActivity);

  return (
    <Card>
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Net Balance Movement
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Balance weight change (MT) between consecutive imports — negative = clearing, positive = accumulating.
        </p>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 text-sm font-semibold min-w-[80px]">Activity</th>
                {days.map((day) => (
                  <th
                    key={day.dayKey}
                    className="text-right px-3 py-2 font-semibold whitespace-nowrap min-w-[72px]"
                  >
                    <span className={day.isGap ? "text-amber-600" : "text-primary/80"}>
                      {day.dayLabel}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {sortedActs.map((act) => {
                const vals = days.map((d) => {
                  const v = d.netBalance[act];
                  return v !== undefined ? v : null;
                });
                const hasAny = vals.some((v) => v !== null && Math.abs(v) >= 0.5);
                return (
                  <tr key={act} className={hasAny ? "hover:bg-muted/30" : "opacity-40"}>
                    <td className="px-4 py-1.5 font-bold font-mono text-sm">{act}</td>
                    {vals.map((v, i) => (
                      <td
                        key={days[i].dayKey}
                        className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${v !== null ? netBalanceCellClass(v) : "text-muted-foreground"}`}
                      >
                        {v !== null ? fmtNetDelta(v) : "-"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
