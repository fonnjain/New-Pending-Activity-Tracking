import { useMemo, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { useSettings } from "@/lib/settings";
import { useTracker } from "@/lib/store";
import { useGetImportRecords, getGetImportRecordsQueryKey } from "@workspace/api-client-react";
import {
  PROCESS_SEQUENCE,
  PROCESS_STEP_LABELS,
  cumulativeTargets,
  DEFAULT_ACTIVITY_GRACE,
  type ProcessStep,
  type PartialActivityGrace,
} from "@workspace/domain";

const ALL = "__ALL__";

function toNum(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type GraceField = "idealDays" | "yellowGrace" | "orangeGrace" | "redGrace";

const FIELDS: GraceField[] = [
  "idealDays",
  "yellowGrace",
  "orangeGrace",
  "redGrace",
];

export default function WarningParameters() {
  return (
    <LoginGate>
      <WarningParametersContent />
    </LoginGate>
  );
}

function WarningParametersContent() {
  const { settings, updateSettings, reset, saving } = useSettings();
  const { selectedImportId } = useTracker();
  const [project, setProject] = useState<string>(ALL);

  const { data: records } = useGetImportRecords(selectedImportId as number, {
    query: {
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
      enabled: selectedImportId !== null,
    },
  });

  // Distinct projects (Job) present in the selected import, for the dropdown.
  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const r of records ?? []) {
      if (r.job) set.add(r.job);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [records]);

  const isAll = project === ALL;

  // Cumulative targets resolved for the active scope (global when "All Projects").
  const cumTargets = useMemo(
    () => cumulativeTargets(settings, isAll ? undefined : project),
    [settings, isAll, project],
  );

  // The sparse override row for the selected project (undefined in global mode).
  const projectOverrides: Record<string, PartialActivityGrace> | undefined =
    isAll ? undefined : settings.perProject?.[project];

  // Edit a GLOBAL ("All Projects") value: always a full row.
  const setGlobalField = (step: ProcessStep, field: GraceField, v: string) =>
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

  // Edit a per-project OVERRIDE field. Empty string clears the override for that
  // field (inherits global); empty rows/projects are pruned so storage stays minimal.
  const setProjectField = (step: ProcessStep, field: GraceField, v: string) =>
    updateSettings((prev) => {
      const perProject = { ...(prev.perProject ?? {}) };
      const proj = { ...(perProject[project] ?? {}) };
      const row: PartialActivityGrace = { ...(proj[step] ?? {}) };
      if (v.trim() === "") {
        delete row[field];
      } else {
        row[field] = toNum(v);
      }
      if (Object.keys(row).length === 0) delete proj[step];
      else proj[step] = row;
      if (Object.keys(proj).length === 0) delete perProject[project];
      else perProject[project] = proj;
      return { ...prev, perProject };
    });

  // Clear all overrides for one activity row (revert to global).
  const clearRowOverride = (step: ProcessStep) =>
    updateSettings((prev) => {
      const perProject = { ...(prev.perProject ?? {}) };
      const proj = { ...(perProject[project] ?? {}) };
      delete proj[step];
      if (Object.keys(proj).length === 0) delete perProject[project];
      else perProject[project] = proj;
      return { ...prev, perProject };
    });

  // Reset the whole selected project back to "All Projects" (drop all overrides).
  const resetProject = () =>
    updateSettings((prev) => {
      const perProject = { ...(prev.perProject ?? {}) };
      delete perProject[project];
      return { ...prev, perProject };
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
        <CardHeader className="space-y-4">
          <div className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Per-activity targets &amp; grace (days)
            </CardTitle>
            <div className="flex items-center gap-3">
              {saving && (
                <span className="text-xs text-muted-foreground">Saving...</span>
              )}
              {isAll ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={reset}
                  className="h-8"
                >
                  Reset to defaults
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetProject}
                  disabled={!projectOverrides}
                  className="h-8"
                >
                  Reset this project
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Project
            </label>
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger className="h-9 w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Projects (global default)</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isAll
                ? "Editing the global defaults that apply to every project without its own override."
                : "Editing overrides for this project. Empty cells inherit the global default (shown as the greyed placeholder)."}
              {!isAll && selectedImportId === null && (
                <span className="block">
                  Select an import on the Data view to list its projects.
                </span>
              )}
            </p>
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
                  <th className="py-2 px-3 font-medium text-right">Red grace</th>
                  {!isAll && <th className="py-2 pl-3 font-medium"></th>}
                </tr>
              </thead>
              <tbody>
                {PROCESS_SEQUENCE.map((step) => {
                  const g = settings.activities[step] ?? DEFAULT_ACTIVITY_GRACE;
                  const ov = projectOverrides?.[step];
                  const rowHasOverride = !!ov && Object.keys(ov).length > 0;
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
                        {!isAll && rowHasOverride && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-primary font-semibold">
                            override
                          </span>
                        )}
                      </td>
                      {FIELDS.map((field, idx) => {
                        // Cumulative target column sits after "idealDays".
                        const cell = (
                          <td
                            key={field}
                            className="py-1.5 px-3 text-right"
                          >
                            {isAll ? (
                              <Input
                                type="number"
                                min={0}
                                value={g[field]}
                                onChange={(e) =>
                                  setGlobalField(step, field, e.target.value)
                                }
                                className="h-8 w-20 ml-auto tabular-nums text-right"
                                aria-label={`${step} ${field}`}
                              />
                            ) : (
                              <Input
                                type="number"
                                min={0}
                                value={ov?.[field] ?? ""}
                                placeholder={String(g[field])}
                                onChange={(e) =>
                                  setProjectField(step, field, e.target.value)
                                }
                                className={`h-8 w-20 ml-auto tabular-nums text-right ${
                                  ov?.[field] === undefined
                                    ? "text-muted-foreground"
                                    : "ring-1 ring-primary/50"
                                }`}
                                aria-label={`${step} ${field}`}
                              />
                            )}
                          </td>
                        );
                        if (idx === 0) {
                          return [
                            cell,
                            <td
                              key="cumtarget"
                              className="py-1.5 px-3 text-right tabular-nums font-medium text-muted-foreground"
                            >
                              {cumTargets[step]}d
                            </td>,
                          ];
                        }
                        return cell;
                      })}
                      {!isAll && (
                        <td className="py-1.5 pl-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => clearRowOverride(step)}
                            disabled={!rowHasOverride}
                            className="h-7 text-xs"
                          >
                            Clear
                          </Button>
                        </td>
                      )}
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
