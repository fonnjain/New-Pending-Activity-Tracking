import { useState, useMemo } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useSettings } from "@/lib/settings";
import {
  PROCESS_SEQUENCE,
  cumulativeTargets,
  type GraceMode,
} from "@workspace/domain";
import { ChevronDown } from "lucide-react";

function toNum(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function TurnaroundSettings() {
  const { settings, updateSettings, reset, saving } = useSettings();
  const [open, setOpen] = useState(false);

  const cumTargets = useMemo(
    () => cumulativeTargets(settings.idealDays),
    [settings.idealDays],
  );
  const unit = settings.graceMode === "percent" ? "%" : "d";

  const setIdeal = (step: string, v: string) =>
    updateSettings((prev) => ({
      ...prev,
      idealDays: { ...prev.idealDays, [step]: toNum(v) },
    }));

  const setGrace = (field: "yellowMax" | "orangeMax", v: string) =>
    updateSettings({ [field]: toNum(v) });

  const setMode = (mode: GraceMode) => updateSettings({ graceMode: mode });

  const toggleOverride = (step: string, on: boolean) =>
    updateSettings((prev) => {
      const overrides = { ...prev.overrides };
      if (on)
        overrides[step] = overrides[step] ?? {
          yellowMax: prev.yellowMax,
          orangeMax: prev.orangeMax,
        };
      else delete overrides[step];
      return { ...prev, overrides };
    });

  const setOverride = (
    step: string,
    field: "yellowMax" | "orangeMax",
    v: string,
  ) =>
    updateSettings((prev) => {
      const cur = prev.overrides[step] ?? {
        yellowMax: prev.yellowMax,
        orangeMax: prev.orangeMax,
      };
      return {
        ...prev,
        overrides: { ...prev.overrides, [step]: { ...cur, [field]: toNum(v) } },
      };
    });

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Turnaround Targets
            </CardTitle>
            <div className="flex items-center gap-3">
              {saving && (
                <span className="text-xs text-muted-foreground">Saving…</span>
              )}
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            {/* Ideal days per activity */}
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Ideal days per activity (cumulative target shown)
              </Label>
              <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {PROCESS_SEQUENCE.map((step) => (
                  <div key={step} className="flex flex-col gap-1">
                    <Label className="text-xs font-mono">
                      {step}{" "}
                      <span className="text-muted-foreground font-normal">
                        (={cumTargets[step]}d)
                      </span>
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      value={settings.idealDays[step] ?? 0}
                      onChange={(e) => setIdeal(step, e.target.value)}
                      className="h-8 tabular-nums"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Global grace bands + mode */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Yellow up to (+{unit})
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={settings.yellowMax}
                  onChange={(e) => setGrace("yellowMax", e.target.value)}
                  className="h-8 w-24 tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Orange up to (+{unit})
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={settings.orangeMax}
                  onChange={(e) => setGrace("orangeMax", e.target.value)}
                  className="h-8 w-24 tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Grace mode
                </Label>
                <div className="flex rounded-md border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setMode("absolute")}
                    className={`px-3 h-8 text-xs font-semibold ${settings.graceMode === "absolute" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}
                  >
                    Days
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("percent")}
                    className={`px-3 h-8 text-xs font-semibold ${settings.graceMode === "percent" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}
                  >
                    % of target
                  </button>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={reset} className="h-8">
                Reset to defaults
              </Button>
            </div>

            {/* Per-activity overrides */}
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Per-activity overrides (optional)
              </Label>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {PROCESS_SEQUENCE.map((step) => {
                  const ov = settings.overrides[step];
                  const enabled = !!ov;
                  return (
                    <div
                      key={step}
                      className="flex items-center gap-2 rounded-md border border-border p-2"
                    >
                      <Checkbox
                        checked={enabled}
                        onCheckedChange={(c) => toggleOverride(step, !!c)}
                        id={`ov-${step}`}
                      />
                      <Label
                        htmlFor={`ov-${step}`}
                        className="font-mono text-xs w-10"
                      >
                        {step}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        disabled={!enabled}
                        value={ov ? ov.yellowMax : settings.yellowMax}
                        onChange={(e) =>
                          setOverride(step, "yellowMax", e.target.value)
                        }
                        className="h-7 w-16 tabular-nums"
                        title={`Yellow up to (+${unit})`}
                      />
                      <Input
                        type="number"
                        min={0}
                        disabled={!enabled}
                        value={ov ? ov.orangeMax : settings.orangeMax}
                        onChange={(e) =>
                          setOverride(step, "orangeMax", e.target.value)
                        }
                        className="h-7 w-16 tabular-nums"
                        title={`Orange up to (+${unit})`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
