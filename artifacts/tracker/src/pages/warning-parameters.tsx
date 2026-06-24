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
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type GraceCell,
  type ActivityConfig,
  type PartialActivityConfig,
} from "@workspace/api-client-react";
import {
  PROCESS_SEQUENCE,
  PROCESS_STEP_LABELS,
  cumulativeTargets,
  resolveCell,
  DEFAULT_ACTIVITY_CONFIG,
  type ProcessStep,
} from "@workspace/domain";

const ALL = "__ALL__";

type BandKey = "yellow" | "orange" | "red";

const BANDS: ReadonlyArray<{ key: BandKey; label: string }> = [
  { key: "yellow", label: "Yellow" },
  { key: "orange", label: "Orange" },
  { key: "red", label: "Red" },
];

function toNum(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function cloneConfig(c: ActivityConfig): ActivityConfig {
  return {
    idealDays: c.idealDays,
    yellow: { ...c.yellow },
    orange: { ...c.orange },
    red: { ...c.red },
  };
}

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
  const projectOverrides: Record<string, PartialActivityConfig> | undefined =
    isAll ? undefined : settings.perProject?.[project];

  // Patch the GLOBAL ("All Projects") config row for one activity.
  const setActivity = (
    step: ProcessStep,
    updater: (c: ActivityConfig) => ActivityConfig,
  ) =>
    updateSettings((prev) => {
      const cur = prev.activities[step] ?? cloneConfig(DEFAULT_ACTIVITY_CONFIG);
      return {
        ...prev,
        activities: { ...prev.activities, [step]: updater(cur) },
      };
    });

  // Patch the SPARSE per-project override row for one activity, pruning empty
  // rows/projects so storage stays minimal (an empty row = full inheritance).
  const setProjectRow = (
    step: ProcessStep,
    mutate: (row: PartialActivityConfig) => void,
  ) =>
    updateSettings((prev) => {
      const perProject = { ...(prev.perProject ?? {}) };
      const proj = { ...(perProject[project] ?? {}) };
      const row: PartialActivityConfig = { ...(proj[step] ?? {}) };
      mutate(row);
      if (Object.keys(row).length === 0) delete proj[step];
      else proj[step] = row;
      if (Object.keys(proj).length === 0) delete perProject[project];
      else perProject[project] = proj;
      return { ...prev, perProject };
    });

  // Apply a band-cell transformation to the active scope (global or project).
  // In project mode this CREATES/REPLACES that cell's override.
  const setBand = (
    step: ProcessStep,
    band: BandKey,
    make: (prev: GraceCell | undefined) => GraceCell,
  ) => {
    if (isAll) {
      setActivity(step, (c) => {
        const n = cloneConfig(c);
        n[band] = make(c[band]);
        return n;
      });
    } else {
      setProjectRow(step, (row) => {
        row[band] = make(row[band]);
      });
    }
  };

  // Edit the grace DAYS directly -> pin this cell to MANUAL (keep last percent).
  const editValue = (step: ProcessStep, band: BandKey, v: string) =>
    setBand(step, band, (prev) => ({
      mode: "manual",
      value: toNum(v),
      ...(prev?.percent !== undefined ? { percent: prev.percent } : {}),
    }));

  // Edit the PERCENT -> switch this cell to AUTO (keep last manual value).
  const editPercent = (step: ProcessStep, band: BandKey, v: string) =>
    setBand(step, band, (prev) => ({
      mode: "auto",
      percent: toNum(v),
      ...(prev?.value !== undefined ? { value: prev.value } : {}),
    }));

  // Flip a MANUAL cell back to AUTO, re-deriving from its stored percentage.
  const useAuto = (step: ProcessStep, band: BandKey) =>
    setBand(step, band, (prev) => ({
      mode: "auto",
      percent: prev?.percent ?? 0,
      ...(prev?.value !== undefined ? { value: prev.value } : {}),
    }));

  // Project mode only: drop a single band override so it inherits the global cell.
  const inheritBand = (step: ProcessStep, band: BandKey) =>
    setProjectRow(step, (row) => {
      delete row[band];
    });

  // Edit ideal days. Global = full value; project = sparse override (empty clears).
  const setIdeal = (step: ProcessStep, v: string) => {
    if (isAll) {
      setActivity(step, (c) => ({ ...cloneConfig(c), idealDays: toNum(v) }));
    } else {
      setProjectRow(step, (row) => {
        if (v.trim() === "") delete row.idealDays;
        else row.idealDays = toNum(v);
      });
    }
  };

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

  // Precompute, per activity, the effective (pre-ordering) grace days for each
  // band in the active scope, so we can render cells and flag inverted bands
  // (yellow > orange or orange > red). The status engine still auto-corrects the
  // order; this is only an editor hint to set sensible percentages.
  const rows = useMemo(() => {
    return PROCESS_SEQUENCE.map((step) => {
      const globalCfg = settings.activities[step] ?? DEFAULT_ACTIVITY_CONFIG;
      const ov = isAll ? undefined : projectOverrides?.[step];
      const globalIdeal = globalCfg.idealDays;
      const effIdeal = isAll ? globalIdeal : ov?.idealDays ?? globalIdeal;
      const bands = BANDS.map(({ key }) => {
        const inheritedCell = globalCfg[key];
        const inheritedDays = resolveCell(inheritedCell, globalIdeal);
        const activeCell = isAll ? globalCfg[key] : ov?.[key];
        const overridden = isAll || !!activeCell;
        const resolvedCell = activeCell ?? inheritedCell;
        const resolvedIdeal = overridden ? effIdeal : globalIdeal;
        const effectiveDays = resolveCell(resolvedCell, resolvedIdeal);
        return {
          key,
          inheritedCell,
          inheritedDays,
          activeCell,
          overridden,
          effectiveDays,
        };
      });
      const [y, o, r] = bands.map((b) => b.effectiveDays);
      const inverted = y > o || o > r;
      const rowHasOverride = !!ov && Object.keys(ov).length > 0;
      return { step, ov, globalCfg, globalIdeal, bands, inverted, rowHasOverride };
    });
  }, [settings, isAll, project, projectOverrides]);

  const invertedSteps = rows.filter((r) => r.inverted).map((r) => r.step);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Warning Parameters
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
            Set the ideal days and Yellow / Orange / Red grace for each activity.
            A grace cell can be Manual (a pinned day value) or Auto (a percentage
            of that activity's own ideal days). Ideal days accumulate down the
            process sequence into a cumulative target; each mark's live ageing is
            compared to that target and the activity's grace bands to raise a
            warning. These settings are advisory and never change parsing,
            quantities, or ageing.
          </p>
        </div>
        <LogoutButton />
      </div>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Per-activity targets &amp; grace
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
                : "Editing overrides for this project. Cells you leave untouched inherit the global default (shown greyed)."}
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
                  {BANDS.map((b) => (
                    <th
                      key={b.key}
                      className="py-2 px-3 font-medium text-right"
                    >
                      {b.label} grace
                    </th>
                  ))}
                  {!isAll && <th className="py-2 pl-3 font-medium"></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { step, ov, globalCfg, globalIdeal, rowHasOverride } =
                    row;
                  const idealOverridden = !isAll && ov?.idealDays !== undefined;
                  return (
                    <tr
                      key={step}
                      className="border-b border-border/50 hover:bg-muted/20 align-top"
                    >
                      <td className="py-2 pr-3">
                        <span className="font-mono font-semibold">{step}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {PROCESS_STEP_LABELS[step]}
                        </span>
                        {!isAll && rowHasOverride && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-primary font-semibold">
                            override
                          </span>
                        )}
                        {row.inverted && (
                          <span className="block text-[10px] text-ageing-red mt-0.5">
                            bands out of order
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={
                            isAll
                              ? globalCfg.idealDays
                              : ov?.idealDays ?? ""
                          }
                          placeholder={isAll ? undefined : String(globalIdeal)}
                          onChange={(e) => setIdeal(step, e.target.value)}
                          className={`h-7 w-16 ml-auto tabular-nums text-right ${
                            !isAll && !idealOverridden
                              ? "text-muted-foreground"
                              : ""
                          } ${idealOverridden ? "ring-1 ring-primary/50" : ""}`}
                          aria-label={`${step} ideal days`}
                        />
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-medium text-muted-foreground">
                        {cumTargets[step]}d
                      </td>
                      {row.bands.map((b) => (
                        <td key={b.key} className="py-2 px-3">
                          <GraceCellEditor
                            step={step}
                            band={b.key}
                            effectiveDays={b.effectiveDays}
                            inheritedDays={b.inheritedDays}
                            inheritedCell={b.inheritedCell}
                            activeCell={b.activeCell}
                            overridden={b.overridden}
                            isProject={!isAll}
                            onValue={(v) => editValue(step, b.key, v)}
                            onPercent={(v) => editPercent(step, b.key, v)}
                            onUseAuto={() => useAuto(step, b.key)}
                            onInherit={() => inheritBand(step, b.key)}
                          />
                        </td>
                      ))}
                      {!isAll && (
                        <td className="py-2 pl-3 text-right">
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
          <div className="text-xs text-muted-foreground mt-3 space-y-1">
            <p>
              Grace is the overrun (days past the cumulative target) allowed
              before escalating. Type a day value to pin a cell (Manual); type a
              percent to auto-fill it from that activity's ideal days (Auto). Auto
              cells recompute when ideal days change; "use %" reverts a manual
              cell to its percentage.
            </p>
            <p>
              Yellow &le; Orange &le; Red is enforced when classifying; anything
              past Orange is Red.
            </p>
            {invertedSteps.length > 0 && (
              <p className="text-ageing-red">
                Some activities have grace bands out of order (
                {invertedSteps.join(", ")}). The warning engine raises later bands
                to keep Yellow &le; Orange &le; Red, but consider setting sensible
                percentages.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// One grace band cell editor: a days input (Manual) stacked over a percent input
// (Auto). The active mode is ring-highlighted; the other is muted. Editing days
// pins to Manual; editing percent switches to Auto. In project mode an
// untouched cell inherits the global value (greyed placeholders) until edited.
function GraceCellEditor({
  step,
  band,
  effectiveDays,
  inheritedDays,
  inheritedCell,
  activeCell,
  overridden,
  isProject,
  onValue,
  onPercent,
  onUseAuto,
  onInherit,
}: {
  step: ProcessStep;
  band: BandKey;
  effectiveDays: number;
  inheritedDays: number;
  inheritedCell: GraceCell;
  activeCell: GraceCell | undefined;
  overridden: boolean;
  isProject: boolean;
  onValue: (v: string) => void;
  onPercent: (v: string) => void;
  onUseAuto: () => void;
  onInherit: () => void;
}) {
  const cell = activeCell ?? inheritedCell;
  const isAuto = overridden && cell.mode === "auto";
  const isManual = overridden && cell.mode === "manual";

  const daysValue: number | "" = !overridden
    ? ""
    : isManual
      ? cell.value ?? 0
      : effectiveDays;
  const daysPlaceholder = overridden ? undefined : String(inheritedDays);

  const pctValue: number | "" =
    overridden && cell.percent !== undefined ? cell.percent : "";
  const pctPlaceholder = overridden
    ? undefined
    : inheritedCell.mode === "auto"
      ? String(inheritedCell.percent ?? 0)
      : "";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Input
          type="number"
          min={0}
          value={daysValue}
          placeholder={daysPlaceholder}
          onChange={(e) => onValue(e.target.value)}
          className={`h-7 w-14 tabular-nums text-right ${
            isManual ? "ring-1 ring-primary/50" : "text-muted-foreground"
          }`}
          aria-label={`${step} ${band} grace days`}
          title={isAuto ? "Auto-derived from percentage" : undefined}
        />
        <span className="text-[10px] text-muted-foreground w-3">d</span>
      </div>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          min={0}
          value={pctValue}
          placeholder={pctPlaceholder}
          onChange={(e) => onPercent(e.target.value)}
          className={`h-7 w-14 tabular-nums text-right ${
            isAuto ? "ring-1 ring-primary/50" : "text-muted-foreground"
          }`}
          aria-label={`${step} ${band} grace percent`}
        />
        <span className="text-[10px] text-muted-foreground w-3">%</span>
      </div>
      <div className="flex items-center gap-2 h-3.5 text-[9px] uppercase tracking-wider">
        {isAuto && <span className="text-primary font-semibold">auto</span>}
        {isManual && (
          <button
            type="button"
            onClick={onUseAuto}
            className="text-muted-foreground hover:text-foreground underline"
          >
            use %
          </button>
        )}
        {!overridden && (
          <span className="text-muted-foreground/70">inherited</span>
        )}
        {isProject && overridden && (
          <button
            type="button"
            onClick={onInherit}
            className="text-muted-foreground hover:text-foreground underline"
          >
            inherit
          </button>
        )}
      </div>
    </div>
  );
}
