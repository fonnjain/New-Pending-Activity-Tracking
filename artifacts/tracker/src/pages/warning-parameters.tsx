import { useMemo } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { useSettings } from "@/lib/settings";
import {
  PROCESS_SEQUENCE,
  PROCESS_STEP_LABELS,
  cumulativeTargets,
  DEFAULT_ACTIVITY_GRACE,
  type ProcessStep,
} from "@workspace/domain";

function toNum(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type GraceField = "idealDays" | "yellowGrace" | "orangeGrace" | "redGrace";

export default function WarningParameters() {
  return (
    <LoginGate>
      <WarningParametersContent />
    </LoginGate>
  );
}

function WarningParametersContent() {
  const { settings, updateSettings, reset, saving } = useSettings();

  const cumTargets = useMemo(
    () => cumulativeTargets(settings),
    [settings],
  );

  const setField = (step: ProcessStep, field: GraceField, v: string) =>
    updateSettings((prev) => {
      const cur = prev.activities[step] ?? { ...DEFAULT_ACTIVITY_GRACE };
      return {
        ...prev,
        activities: {
          ...prev.activities,
          [step]: { ...cur, [field]: toNum(v) },
        },
      };
    });

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Warning Parameters
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
            Set the ideal days and Yellow / Orange / Red grace (in days) for each
            activity. Ideal days accumulate down the process sequence into a
            cumulative target; each mark's live ageing is compared to that target
            and the activity's own grace bands to raise a warning. These settings
            are advisory and never change parsing, quantities, or ageing.
          </p>
        </div>
        <LogoutButton />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
            Per-activity targets &amp; grace (days)
          </CardTitle>
          <div className="flex items-center gap-3">
            {saving && (
              <span className="text-xs text-muted-foreground">Saving...</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={reset}
              className="h-8"
            >
              Reset to defaults
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Activity</th>
                  <th className="py-2 px-3 font-medium text-right">
                    Ideal days
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Cumulative target
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Yellow grace
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Orange grace
                  </th>
                  <th className="py-2 pl-3 font-medium text-right">Red grace</th>
                </tr>
              </thead>
              <tbody>
                {PROCESS_SEQUENCE.map((step) => {
                  const g = settings.activities[step] ?? DEFAULT_ACTIVITY_GRACE;
                  return (
                    <tr
                      key={step}
                      className="border-b border-border/50 hover:bg-muted/20"
                    >
                      <td className="py-1.5 pr-3">
                        <span className="font-mono font-semibold">{step}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {PROCESS_STEP_LABELS[step]}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={g.idealDays}
                          onChange={(e) =>
                            setField(step, "idealDays", e.target.value)
                          }
                          className="h-8 w-20 ml-auto tabular-nums text-right"
                          aria-label={`${step} ideal days`}
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium text-muted-foreground">
                        {cumTargets[step]}d
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={g.yellowGrace}
                          onChange={(e) =>
                            setField(step, "yellowGrace", e.target.value)
                          }
                          className="h-8 w-20 ml-auto tabular-nums text-right"
                          aria-label={`${step} yellow grace`}
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={g.orangeGrace}
                          onChange={(e) =>
                            setField(step, "orangeGrace", e.target.value)
                          }
                          className="h-8 w-20 ml-auto tabular-nums text-right"
                          aria-label={`${step} orange grace`}
                        />
                      </td>
                      <td className="py-1.5 pl-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={g.redGrace}
                          onChange={(e) =>
                            setField(step, "redGrace", e.target.value)
                          }
                          className="h-8 w-20 ml-auto tabular-nums text-right"
                          aria-label={`${step} red grace`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Grace is the overrun (days past the cumulative target) allowed before
            escalating. Yellow &le; Orange &le; Red is enforced on save; anything
            past Orange is Red.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
