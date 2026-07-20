import { useMemo, useState } from "react";
import type { ContractorBalanceMovementDay } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";

type Measure = "produced" | "received" | "released" | "newIntake" | "netChange";

const MEASURES: { key: Measure; label: string; description: string }[] = [
  {
    key: "produced",
    label: "Produced",
    description: "Work actually completed or advanced — same-contractor weight reductions plus marks that fully left WIP. Excludes reassignments and new intake.",
  },
  {
    key: "received",
    label: "Received",
    description: "Marks reassigned IN to this contractor from another — movement, not production.",
  },
  {
    key: "released",
    label: "Released",
    description: "Marks reassigned OUT from this contractor to another — movement, not production.",
  },
  {
    key: "newIntake",
    label: "New Intake",
    description: "New marks appearing in this snapshot attributed to this contractor.",
  },
  {
    key: "netChange",
    label: "Net Change",
    description: "Overall balance delta (current total minus previous total). Combines production, reassignment and new intake.",
  },
];

function fmtMt(v: number, measure: Measure): string {
  const abs = Math.abs(v);
  if (abs < 0.005) return "-";
  const sign = measure === "netChange" && v > 0 ? "+" : measure === "netChange" && v < 0 ? "-" : "";
  const num = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  return sign + num;
}

function cellClass(v: number, measure: Measure): string {
  const abs = Math.abs(v);
  if (abs < 0.005) return "text-muted-foreground";
  if (measure === "produced") {
    if (abs < 5) return "text-foreground";
    if (abs < 20) return "text-blue-700 font-medium";
    return "text-blue-800 font-semibold";
  }
  if (measure === "netChange") {
    if (v < -0.005) return "text-green-700 font-medium";
    if (v < 10) return "text-amber-600 font-medium";
    return "text-red-600 font-semibold";
  }
  return "text-muted-foreground/80";
}

interface Props {
  days: ContractorBalanceMovementDay[];
  isLoading?: boolean;
}

export function ContractorNetMovementPanel({ days, isLoading = false }: Props) {
  const [measure, setMeasure] = useState<Measure>("produced");

  const sortedContractors = useMemo(() => {
    const totalProduced = new Map<string, number>();
    for (const day of days) {
      for (const [con, m] of Object.entries(day.contractors)) {
        totalProduced.set(con, (totalProduced.get(con) ?? 0) + m.produced);
      }
    }
    return [...totalProduced.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([con]) => con);
  }, [days]);

  if (!isLoading && days.length === 0) return null;

  const activeMeasure = MEASURES.find((m) => m.key === measure)!;

  return (
    <Card>
      <div className="px-4 pt-4 pb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Net Balance Movement — Contractor Wise
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
            {activeMeasure.description} Rows sorted by total Produced (desc). MT to 2 dp.
          </p>
        </div>
        {/* Measure selector tabs */}
        <div className="flex flex-wrap gap-1 shrink-0">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMeasure(m.key)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap
                ${measure === m.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <>
          <div className="px-4 pb-2">
            <p className="text-[11px] text-muted-foreground italic">
              Produced = work done; Received / Released = reassignment between contractors; Net = combined movement.
            </p>
          </div>
          <div className="overflow-x-auto pb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-4 py-2 text-sm font-semibold min-w-[11rem] max-w-[16rem]">
                    Contractor
                  </th>
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
                  <th className="text-right px-3 py-2 font-semibold whitespace-nowrap text-muted-foreground min-w-[60px]">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sortedContractors.map((con) => {
                  const vals = days.map((d) => d.contractors[con]?.[measure] ?? null);
                  const hasAny = vals.some((v) => v !== null && Math.abs(v) >= 0.005);
                  const total = vals.reduce<number>((s, v) => s + (v ?? 0), 0);
                  return (
                    <tr key={con} className={hasAny ? "hover:bg-muted/30" : "opacity-40"}>
                      <td className="px-4 py-1.5 text-sm font-medium text-foreground leading-tight break-words whitespace-normal max-w-[16rem]">
                        {con}
                      </td>
                      {vals.map((v, i) => (
                        <td
                          key={days[i].dayKey}
                          className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${
                            v !== null ? cellClass(v, measure) : "text-muted-foreground"
                          }`}
                        >
                          {v !== null ? fmtMt(v, measure) : "-"}
                        </td>
                      ))}
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap font-semibold ${cellClass(total, measure)}`}
                      >
                        {fmtMt(total, measure)}
                      </td>
                    </tr>
                  );
                })}
                {sortedContractors.length === 0 && (
                  <tr>
                    <td
                      colSpan={days.length + 2}
                      className="px-4 py-6 text-center text-muted-foreground"
                    >
                      No contractor data available.
                    </td>
                  </tr>
                )}
              </tbody>
              {/* Foot row — column totals for the selected measure */}
              {sortedContractors.length > 0 && (
                <tfoot className="border-t bg-muted/40">
                  <tr>
                    <td className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
                      Total
                    </td>
                    {days.map((day) => {
                      const colTotal = sortedContractors.reduce(
                        (s, con) => s + (day.contractors[con]?.[measure] ?? 0),
                        0,
                      );
                      return (
                        <td
                          key={day.dayKey}
                          className={`px-3 py-1.5 text-right tabular-nums font-semibold ${cellClass(colTotal, measure)}`}
                        >
                          {fmtMt(colTotal, measure)}
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right tabular-nums font-bold text-foreground">
                      {fmtMt(
                        days.reduce(
                          (s, day) =>
                            s +
                            sortedContractors.reduce(
                              (cs, con) => cs + (day.contractors[con]?.[measure] ?? 0),
                              0,
                            ),
                          0,
                        ),
                        measure,
                      )}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
