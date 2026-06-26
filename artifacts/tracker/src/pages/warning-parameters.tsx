import { useMemo, useRef, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Download, Upload } from "lucide-react";
import { LoginGate, LogoutButton } from "@/components/login-gate";
import { useSettings } from "@/lib/settings";
import { useTracker } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { exportToXlsx, type XlsxColumn } from "@/lib/export";
import {
  useGetImportRecords,
  getGetImportRecordsQueryKey,
  type GraceCell,
  type ActivityConfig,
  type PartialActivityConfig,
} from "@workspace/api-client-react";
import {
  PROCESS_STEP_LABELS,
  SEQUENCES,
  cumulativeTargets,
  resolveCell,
  isKnownIn,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_PRE_WARN,
  DEFAULT_STALLED_DAYS,
  type SettingsCategory,
  type NtltSubtype,
  type ScopeArg,
} from "@workspace/domain";

const ALL = "__ALL__";

// The four configurable warning categories shown in the selector. TLT is the
// original 12-step route (scope = project); the three NTLT categories follow
// their shorter sequences (scope = section).
const CATEGORIES: ReadonlyArray<{ key: SettingsCategory; label: string }> = [
  { key: "TLT", label: "TLT (Structures)" },
  { key: "NTLT_RSJ", label: "NTLT: RSJ Poles" },
  { key: "NTLT_EARTHING", label: "NTLT: Earthing" },
  { key: "NTLT_GENERAL", label: "NTLT: General" },
];

// The NTLT subtype for a settings category (null for TLT).
function subtypeForCategory(c: SettingsCategory): NtltSubtype | null {
  switch (c) {
    case "NTLT_RSJ":
      return "RSJ";
    case "NTLT_EARTHING":
      return "EARTHING";
    case "NTLT_GENERAL":
      return "GENERAL";
    default:
      return null;
  }
}

// Display label for any activity code (TLT codes have descriptions; NTLT-only
// codes fall back to a short label, else the code itself).
const NTLT_STEP_LABELS: Record<string, string> = {
  NTF: "Fit-up",
  NTFSW: "Fit-up & Side Weld",
  NTFW: "Final Weld",
};
function stepLabel(code: string): string {
  return (
    (PROCESS_STEP_LABELS as Record<string, string>)[code] ??
    NTLT_STEP_LABELS[code] ??
    code
  );
}

type BandKey = "yellow" | "orange" | "red";
type PreWarnKey = "pw1" | "pw2" | "pw3";

const PRE_WARNS: ReadonlyArray<{ key: PreWarnKey; label: string }> = [
  { key: "pw1", label: "Pre-warn 1" },
  { key: "pw2", label: "Pre-warn 2" },
  { key: "pw3", label: "Pre-warn 3" },
];

const BANDS: ReadonlyArray<{ key: BandKey; label: string }> = [
  { key: "yellow", label: "Blue" },
  { key: "orange", label: "Grey" },
  { key: "red", label: "Black" },
];

function toNum(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toPct(v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function cloneConfig(c: ActivityConfig): ActivityConfig {
  return {
    idealDays: c.idealDays,
    yellow: { ...c.yellow },
    orange: { ...c.orange },
    red: { ...c.red },
    preWarn: { ...c.preWarn },
  };
}

// Read the first worksheet of an .xlsx/.xls file into an array of row objects
// keyed by header label (header row = first row), mirroring the export layout.
async function readSheetRows(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
}

// Normalize a row's header keys (lowercase, strip non-alphanumerics) so the
// importer tolerates minor header edits / spacing when matching columns.
function normalizeKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    out[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = row[k];
  }
  return out;
}

// First value whose normalized header contains any of the given substrings.
function pickField(
  nr: Record<string, unknown>,
  subs: string[],
): unknown {
  for (const key of Object.keys(nr)) {
    if (subs.some((s) => key.includes(s))) return nr[key];
  }
  return undefined;
}

// Parse a non-negative integer day value (blank/non-numeric -> null = skip).
function parseDays(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

// Parse a 0..100 percentage (blank/non-numeric -> null = skip).
function parsePct(v: unknown): number | null {
  const n = parseDays(v);
  return n == null ? null : Math.min(100, n);
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
  const { toast } = useToast();
  const [category, setCategory] = useState<SettingsCategory>("TLT");
  const [project, setProject] = useState<string>(ALL);
  const graceFileRef = useRef<HTMLInputElement>(null);
  const preWarnFileRef = useRef<HTMLInputElement>(null);

  // The NTLT subtype for the active category (null = TLT). Drives where in the
  // settings object we read/write and which sequence we render.
  const sub = subtypeForCategory(category);
  // The activity codes for the active category (TLT = 12 steps; NTLT shorter).
  const seq = SEQUENCES[category] as readonly string[];
  // Switching category resets the scope selector back to the global default and
  // is what makes TLT vs NTLT independent.
  const onCategoryChange = (c: string) => {
    setCategory(c as SettingsCategory);
    setProject(ALL);
  };

  const { data: records } = useGetImportRecords(selectedImportId as number, {
    query: {
      queryKey: getGetImportRecordsQueryKey(selectedImportId as number),
      enabled: selectedImportId !== null,
    },
  });

  // Scope-key options for the dropdown: projects (Job) for TLT, sections
  // (group_key) for the active NTLT subtype, taken from the selected import.
  const scopeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of records ?? []) {
      if (r.active === false) continue;
      if (sub === null) {
        if ((r.category || "TLT") === "TLT" && r.job) set.add(r.job);
      } else if (r.category === "NTLT" && r.ntltSubtype === sub && r.groupKey) {
        set.add(r.groupKey);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [records, sub]);

  const isAll = project === ALL;

  // The full resolution scope for the engine helpers (category + key). A bare
  // string is the legacy TLT-project form; NTLT needs the explicit ScopeRef.
  const scope: ScopeArg =
    sub === null
      ? isAll
        ? undefined
        : project
      : { category, ntltSubtype: sub, key: isAll ? null : project };

  // Read the GLOBAL per-activity map for the active category.
  const readGlobal = (s: typeof settings): Record<string, ActivityConfig> =>
    sub === null ? s.activities : s.ntlt?.[sub]?.activities ?? {};

  // Read the sparse override map for the active category (perProject / perSection).
  const readOverrides = (
    s: typeof settings,
  ): Record<string, Record<string, PartialActivityConfig>> =>
    sub === null
      ? s.perProject ?? {}
      : s.ntlt?.[sub]?.perSection ?? {};

  // Produce next settings with the active category's global map replaced.
  const writeGlobal = (
    s: typeof settings,
    next: Record<string, ActivityConfig>,
  ): typeof settings => {
    if (sub === null) return { ...s, activities: next };
    const ntlt = { ...(s.ntlt ?? {}) };
    ntlt[sub] = { ...(ntlt[sub] ?? { activities: {} }), activities: next };
    return { ...s, ntlt };
  };

  // Produce next settings with the active category's override map replaced.
  const writeOverrides = (
    s: typeof settings,
    next: Record<string, Record<string, PartialActivityConfig>>,
  ): typeof settings => {
    if (sub === null) return { ...s, perProject: next };
    const ntlt = { ...(s.ntlt ?? {}) };
    ntlt[sub] = { ...(ntlt[sub] ?? { activities: {} }), perSection: next };
    return { ...s, ntlt };
  };

  // Cumulative targets resolved for the active scope + category sequence.
  const cumTargets = useMemo(
    () => cumulativeTargets(settings, scope, seq),
    [settings, scope, seq],
  );

  // The sparse override row for the selected scope key (undefined in global mode).
  const projectOverrides: Record<string, PartialActivityConfig> | undefined =
    isAll ? undefined : readOverrides(settings)[project];

  // Patch the GLOBAL config row for one activity (active category).
  const setActivity = (
    step: string,
    updater: (c: ActivityConfig) => ActivityConfig,
  ) =>
    updateSettings((prev) => {
      const g = readGlobal(prev);
      const cur = g[step] ?? cloneConfig(DEFAULT_ACTIVITY_CONFIG);
      return writeGlobal(prev, { ...g, [step]: updater(cur) });
    });

  // Patch the SPARSE override row for one activity, pruning empty rows/keys so
  // storage stays minimal (an empty row = full inheritance).
  const setProjectRow = (
    step: string,
    mutate: (row: PartialActivityConfig) => void,
  ) =>
    updateSettings((prev) => {
      const overrides = { ...readOverrides(prev) };
      const proj = { ...(overrides[project] ?? {}) };
      const row: PartialActivityConfig = { ...(proj[step] ?? {}) };
      mutate(row);
      if (Object.keys(row).length === 0) delete proj[step];
      else proj[step] = row;
      if (Object.keys(proj).length === 0) delete overrides[project];
      else overrides[project] = proj;
      return writeOverrides(prev, overrides);
    });

  // Apply a band-cell transformation to the active scope (global or project).
  // In project mode this CREATES/REPLACES that cell's override.
  const setBand = (
    step: string,
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
  const editValue = (step: string, band: BandKey, v: string) =>
    setBand(step, band, (prev) => ({
      mode: "manual",
      value: toNum(v),
      ...(prev?.percent !== undefined ? { percent: prev.percent } : {}),
    }));

  // Edit the PERCENT -> switch this cell to AUTO (keep last manual value).
  const editPercent = (step: string, band: BandKey, v: string) =>
    setBand(step, band, (prev) => ({
      mode: "auto",
      percent: toNum(v),
      ...(prev?.value !== undefined ? { value: prev.value } : {}),
    }));

  // Flip a MANUAL cell back to AUTO, re-deriving from its stored percentage.
  const useAuto = (step: string, band: BandKey) =>
    setBand(step, band, (prev) => ({
      mode: "auto",
      percent: prev?.percent ?? 0,
      ...(prev?.value !== undefined ? { value: prev.value } : {}),
    }));

  // Project mode only: drop a single band override so it inherits the global cell.
  const inheritBand = (step: string, band: BandKey) =>
    setProjectRow(step, (row) => {
      delete row[band];
    });

  // Edit ideal days. Global = full value; project = sparse override (empty clears).
  const setIdeal = (step: string, v: string) => {
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
  const clearRowOverride = (step: string) =>
    updateSettings((prev) => {
      const overrides = { ...readOverrides(prev) };
      const proj = { ...(overrides[project] ?? {}) };
      delete proj[step];
      if (Object.keys(proj).length === 0) delete overrides[project];
      else overrides[project] = proj;
      return writeOverrides(prev, overrides);
    });

  // Reset the whole selected scope back to global (drop all its overrides).
  const resetProject = () =>
    updateSettings((prev) => {
      const overrides = { ...readOverrides(prev) };
      delete overrides[project];
      return writeOverrides(prev, overrides);
    });

  // Reset the active category's GLOBAL rows to defaults. TLT in global mode uses
  // the existing whole-settings reset (byte-for-byte unchanged); NTLT resets just
  // that category's activities to its sequence defaults, leaving others intact.
  const resetCategoryGlobal = () => {
    if (sub === null) {
      reset();
      return;
    }
    updateSettings((prev) =>
      writeGlobal(
        prev,
        Object.fromEntries(
          seq.map((s) => [s, cloneConfig(DEFAULT_ACTIVITY_CONFIG)]),
        ),
      ),
    );
  };

  // Edit a pre-warning threshold (percent of cumulative target consumed).
  // Global = full value; project = sparse per-field override (empty clears).
  const setPreWarn = (step: string, key: PreWarnKey, v: string) => {
    if (isAll) {
      setActivity(step, (c) => {
        const n = cloneConfig(c);
        n.preWarn = { ...n.preWarn, [key]: toPct(v) };
        return n;
      });
    } else {
      setProjectRow(step, (row) => {
        const pw = { ...(row.preWarn ?? {}) };
        if (v.trim() === "") delete pw[key];
        else pw[key] = toPct(v);
        if (Object.keys(pw).length === 0) delete row.preWarn;
        else row.preWarn = pw;
      });
    }
  };

  // Project mode only: drop a single pre-warning override so it inherits global.
  const inheritPreWarn = (step: string, key: PreWarnKey) =>
    setProjectRow(step, (row) => {
      if (!row.preWarn) return;
      const pw = { ...row.preWarn };
      delete pw[key];
      if (Object.keys(pw).length === 0) delete row.preWarn;
      else row.preWarn = pw;
    });

  // Stalled-days threshold is GLOBAL only (no per-project override).
  const setStalledDays = (v: string) =>
    updateSettings((prev) => ({ ...prev, stalledDays: toNum(v) }));

  // Per-activity pre-warning display rows (effective values + override flags).
  const preWarnRows = useMemo(() => {
    const g = readGlobal(settings);
    return seq.map((step) => {
      const globalPw = g[step]?.preWarn ?? DEFAULT_PRE_WARN;
      const ovPw = isAll ? undefined : projectOverrides?.[step]?.preWarn;
      const cells = PRE_WARNS.map(({ key }) => {
        const inherited = globalPw[key];
        const overrideVal = ovPw?.[key];
        const overridden = isAll || overrideVal !== undefined;
        const effective = overrideVal ?? inherited;
        return { key, inherited, overrideVal, overridden, effective };
      });
      const [p1, p2, p3] = cells.map((c) => c.effective);
      const inverted = p1 > p2 || p2 > p3;
      const rowHasOverride = !!ovPw && Object.keys(ovPw).length > 0;
      return { step, cells, inverted, rowHasOverride };
    });
  }, [settings, isAll, projectOverrides, seq, sub]);

  const pwInvertedSteps = preWarnRows.filter((r) => r.inverted).map((r) => r.step);

  // Precompute, per activity, the effective (pre-ordering) grace days for each
  // band in the active scope, so we can render cells and flag inverted bands
  // (yellow > orange or orange > red). The status engine still auto-corrects the
  // order; this is only an editor hint to set sensible percentages.
  const rows = useMemo(() => {
    const g = readGlobal(settings);
    return seq.map((step) => {
      const globalCfg = g[step] ?? DEFAULT_ACTIVITY_CONFIG;
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
      return { step, ov, globalCfg, globalIdeal, effIdeal, bands, inverted, rowHasOverride };
    });
  }, [settings, isAll, project, projectOverrides, seq, sub]);

  const invertedSteps = rows.filter((r) => r.inverted).map((r) => r.step);

  // The word for the override scope in the active category (project vs section).
  const scopeNoun = sub === null ? "Project" : "Section";
  const allLabel = sub === null ? "All Projects" : "All Sections";

  // Filename-safe slug for the active scope, used by both Excel exports.
  const scopeSlug =
    (isAll ? `all-${scopeNoun.toLowerCase()}s` : project)
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "scope";

  // Export the per-activity targets & grace table (effective resolved days for
  // the active scope) as its own .xlsx.
  const exportGraceXlsx = () => {
    const cols: XlsxColumn[] = [
      { label: "Activity", field: "activity" },
      { label: "Description", field: "description" },
      { label: "Ideal Days", field: "idealDays", numeric: true, decimals: 0 },
      { label: "Cumulative Target (d)", field: "cumulativeTarget", numeric: true, decimals: 0 },
      { label: "Blue Grace (d)", field: "yellowGrace", numeric: true, decimals: 0 },
      { label: "Grey Grace (d)", field: "orangeGrace", numeric: true, decimals: 0 },
      { label: "Black Grace (d)", field: "redGrace", numeric: true, decimals: 0 },
    ];
    const out = rows.map((row) => {
      const byBand: Record<string, number> = {};
      for (const b of row.bands) byBand[b.key] = b.effectiveDays;
      return {
        activity: row.step,
        description: stepLabel(row.step),
        idealDays: row.effIdeal,
        cumulativeTarget: cumTargets[row.step],
        yellowGrace: byBand.yellow,
        orangeGrace: byBand.orange,
        redGrace: byBand.red,
      };
    });
    exportToXlsx(`targets-grace_${scopeSlug}.xlsx`, cols, out, {
      sheetName: "Targets & Grace",
    });
  };

  // Export the pre-warning thresholds table (effective percentages for the
  // active scope) as its own .xlsx.
  const exportPreWarnXlsx = () => {
    const cols: XlsxColumn[] = [
      { label: "Activity", field: "activity" },
      { label: "Description", field: "description" },
      { label: "Cumulative Target (d)", field: "cumulativeTarget", numeric: true, decimals: 0 },
      { label: "Pre-warn 1 %", field: "pw1", numeric: true, decimals: 0 },
      { label: "Pre-warn 2 %", field: "pw2", numeric: true, decimals: 0 },
      { label: "Pre-warn 3 %", field: "pw3", numeric: true, decimals: 0 },
    ];
    const out = preWarnRows.map((row) => {
      const byKey: Record<string, number> = {};
      for (const c of row.cells) byKey[c.key] = c.effective;
      return {
        activity: row.step,
        description: stepLabel(row.step),
        cumulativeTarget: cumTargets[row.step],
        pw1: byKey.pw1,
        pw2: byKey.pw2,
        pw3: byKey.pw3,
      };
    });
    exportToXlsx(`pre-warnings_${scopeSlug}.xlsx`, cols, out, {
      sheetName: "Pre-warnings",
    });
  };

  // Import a targets & grace .xlsx (as produced by the export) and apply ideal
  // days + grace bands (as MANUAL day cells) to the active scope. Unknown
  // activities and blank cells are skipped; "Cumulative target" is derived and
  // ignored on import.
  const importGraceXlsx = async (file: File) => {
    try {
      const raw = await readSheetRows(file);
      const parsed: {
        step: string;
        ideal: number | null;
        yellow: number | null;
        orange: number | null;
        red: number | null;
      }[] = [];
      for (const row of raw) {
        const nr = normalizeKeys(row);
        const code = String(pickField(nr, ["activity"]) ?? "")
          .trim()
          .toUpperCase();
        if (!code || !isKnownIn(seq, code)) continue;
        parsed.push({
          step: code as string,
          ideal: parseDays(pickField(nr, ["ideal"])),
          yellow: parseDays(pickField(nr, ["blue", "yellow"])),
          orange: parseDays(pickField(nr, ["grey", "gray", "orange"])),
          red: parseDays(pickField(nr, ["black", "red"])),
        });
      }
      if (parsed.length === 0) {
        toast({
          variant: "destructive",
          title: "Nothing imported",
          description: "No recognised activity rows found in the file.",
        });
        return;
      }
      updateSettings((prev) => {
        if (isAll) {
          const activities = { ...readGlobal(prev) };
          for (const p of parsed) {
            const next = cloneConfig(
              activities[p.step] ?? DEFAULT_ACTIVITY_CONFIG,
            );
            if (p.ideal != null) next.idealDays = p.ideal;
            if (p.yellow != null) next.yellow = { mode: "manual", value: p.yellow };
            if (p.orange != null) next.orange = { mode: "manual", value: p.orange };
            if (p.red != null) next.red = { mode: "manual", value: p.red };
            activities[p.step] = next;
          }
          return writeGlobal(prev, activities);
        }
        const overrides = { ...readOverrides(prev) };
        const proj = { ...(overrides[project] ?? {}) };
        for (const p of parsed) {
          const cur: PartialActivityConfig = { ...(proj[p.step] ?? {}) };
          if (p.ideal != null) cur.idealDays = p.ideal;
          if (p.yellow != null) cur.yellow = { mode: "manual", value: p.yellow };
          if (p.orange != null) cur.orange = { mode: "manual", value: p.orange };
          if (p.red != null) cur.red = { mode: "manual", value: p.red };
          if (Object.keys(cur).length === 0) delete proj[p.step];
          else proj[p.step] = cur;
        }
        if (Object.keys(proj).length === 0) delete overrides[project];
        else overrides[project] = proj;
        return writeOverrides(prev, overrides);
      });
      toast({
        title: "Targets & grace imported",
        description: `Applied ${parsed.length} ${
          parsed.length === 1 ? "activity" : "activities"
        } to ${isAll ? allLabel : project}.`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Import failed",
        description:
          err instanceof Error ? err.message : "Could not read the Excel file.",
      });
    }
  };

  // Import a pre-warnings .xlsx (as produced by the export) and apply the three
  // percentage thresholds per activity to the active scope. Unknown activities
  // and blank cells are skipped; "Cumulative target" is derived and ignored.
  const importPreWarnXlsx = async (file: File) => {
    try {
      const raw = await readSheetRows(file);
      const parsed: {
        step: string;
        pw1: number | null;
        pw2: number | null;
        pw3: number | null;
      }[] = [];
      for (const row of raw) {
        const nr = normalizeKeys(row);
        const code = String(pickField(nr, ["activity"]) ?? "")
          .trim()
          .toUpperCase();
        if (!code || !isKnownIn(seq, code)) continue;
        parsed.push({
          step: code as string,
          pw1: parsePct(pickField(nr, ["prewarn1", "pw1"])),
          pw2: parsePct(pickField(nr, ["prewarn2", "pw2"])),
          pw3: parsePct(pickField(nr, ["prewarn3", "pw3"])),
        });
      }
      if (parsed.length === 0) {
        toast({
          variant: "destructive",
          title: "Nothing imported",
          description: "No recognised activity rows found in the file.",
        });
        return;
      }
      updateSettings((prev) => {
        if (isAll) {
          const activities = { ...readGlobal(prev) };
          for (const p of parsed) {
            const next = cloneConfig(
              activities[p.step] ?? DEFAULT_ACTIVITY_CONFIG,
            );
            const pw = { ...next.preWarn };
            if (p.pw1 != null) pw.pw1 = p.pw1;
            if (p.pw2 != null) pw.pw2 = p.pw2;
            if (p.pw3 != null) pw.pw3 = p.pw3;
            next.preWarn = pw;
            activities[p.step] = next;
          }
          return writeGlobal(prev, activities);
        }
        const overrides = { ...readOverrides(prev) };
        const proj = { ...(overrides[project] ?? {}) };
        for (const p of parsed) {
          const cur: PartialActivityConfig = { ...(proj[p.step] ?? {}) };
          const pw = { ...(cur.preWarn ?? {}) };
          if (p.pw1 != null) pw.pw1 = p.pw1;
          if (p.pw2 != null) pw.pw2 = p.pw2;
          if (p.pw3 != null) pw.pw3 = p.pw3;
          if (Object.keys(pw).length === 0) delete cur.preWarn;
          else cur.preWarn = pw;
          if (Object.keys(cur).length === 0) delete proj[p.step];
          else proj[p.step] = cur;
        }
        if (Object.keys(proj).length === 0) delete overrides[project];
        else overrides[project] = proj;
        return writeOverrides(prev, overrides);
      });
      toast({
        title: "Pre-warnings imported",
        description: `Applied ${parsed.length} ${
          parsed.length === 1 ? "activity" : "activities"
        } to ${isAll ? allLabel : project}.`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Import failed",
        description:
          err instanceof Error ? err.message : "Could not read the Excel file.",
      });
    }
  };

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Warning Parameters
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
            Configure the reactive grace bands (raised after a mark overruns) and
            proactive pre-warnings (raised before it reaches its target). Ideal
            days accumulate down the process sequence into a cumulative target;
            each mark's live ageing is compared to that target. These settings are
            advisory and never change parsing, quantities, or ageing.
          </p>
        </div>
        <LogoutButton />
      </div>

      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-row items-center justify-between space-y-0 gap-3">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Per-activity targets &amp; grace
            </CardTitle>
            <div className="flex items-center gap-2">
              {saving && (
                <span className="text-xs text-muted-foreground">Saving...</span>
              )}
              <input
                ref={graceFileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importGraceXlsx(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => graceFileRef.current?.click()}
                className="h-8"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Import
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportGraceXlsx}
                className="h-8"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Excel
              </Button>
              {isAll ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetCategoryGlobal}
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
                  Reset this {scopeNoun.toLowerCase()}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                Category
              </label>
              <Select value={category} onValueChange={onCategoryChange}>
                <SelectTrigger className="h-9 w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                {scopeNoun}
              </label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger className="h-9 w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {allLabel} (global default)
                  </SelectItem>
                  {scopeKeys.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {isAll
              ? `Editing the global ${category === "TLT" ? "TLT" : sub} defaults that apply to every ${scopeNoun.toLowerCase()} without its own override.`
              : `Editing overrides for this ${scopeNoun.toLowerCase()}. Cells you leave untouched inherit the global default (shown greyed).`}
            {!isAll && selectedImportId === null && (
              <span className="block">
                Select an import on the Data view to list its{" "}
                {scopeNoun.toLowerCase()}s.
              </span>
            )}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Activity</th>
                  <th className="py-1.5 px-3 font-medium text-right">
                    Ideal days
                  </th>
                  <th className="py-1.5 px-3 font-medium text-right">
                    Cumulative target
                  </th>
                  {BANDS.map((b) => (
                    <th
                      key={b.key}
                      className="py-1.5 px-3 font-medium text-right"
                    >
                      {b.label} grace
                    </th>
                  ))}
                  {!isAll && <th className="py-1.5 pl-3 font-medium"></th>}
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
                      <td className="py-1.5 pr-3">
                        <span className="font-mono font-semibold">{step}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {stepLabel(step)}
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
                      <td className="py-1.5 px-3 text-right">
                        <NumberInput
                          type="number"
                          min={0}
                          value={
                            isAll
                              ? globalCfg.idealDays
                              : ov?.idealDays ?? ""
                          }
                          placeholder={isAll ? undefined : String(globalIdeal)}
                          onValueChange={(v) => setIdeal(step, v)}
                          className={`h-7 w-16 ml-auto tabular-nums text-right ${
                            !isAll && !idealOverridden
                              ? "text-muted-foreground"
                              : ""
                          } ${idealOverridden ? "ring-1 ring-primary/50" : ""}`}
                          aria-label={`${step} ideal days`}
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium text-muted-foreground">
                        {cumTargets[step]}d
                      </td>
                      {row.bands.map((b) => (
                        <td key={b.key} className="py-1.5 px-3">
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
          <div className="text-xs text-muted-foreground mt-3 space-y-1">
            <p>
              Grace is the overrun (days past the cumulative target) allowed
              before escalating. Type a day value to pin a cell (Manual); type a
              percent to auto-fill it from that activity's ideal days (Auto). Auto
              cells recompute when ideal days change; "use %" reverts a manual
              cell to its percentage. Blue &le; Grey &le; Black is enforced when
              classifying; anything past Grey is Black.
            </p>
            {invertedSteps.length > 0 && (
              <p className="text-ageing-red">
                Some activities have grace bands out of order (
                {invertedSteps.join(", ")}). The warning engine raises later bands
                to keep Blue &le; Grey &le; Black, but consider setting sensible
                percentages.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-row items-center justify-between space-y-0 gap-3">
            <CardTitle className="text-base uppercase tracking-wider text-muted-foreground">
              Pre-warnings (before target)
            </CardTitle>
            <div className="flex items-center gap-2">
              {saving && (
                <span className="text-xs text-muted-foreground">Saving...</span>
              )}
              <input
                ref={preWarnFileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importPreWarnXlsx(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => preWarnFileRef.current?.click()}
                className="h-8"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Import
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportPreWarnXlsx}
                className="h-8"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Excel
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground max-w-3xl">
            Pre-warnings fire while a mark is still within its cumulative target,
            based on the percent of the target its ageing has consumed. Three
            stages escalate Blue then Grey then Black as the mark approaches the
            target. Values are percentages (0&ndash;100) and must increase
            Pre-warn 1 &le; 2 &le; 3.
            {isAll
              ? " Editing the global defaults."
              : " Editing this project's overrides; blank cells inherit the global default."}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Activity</th>
                  <th className="py-1.5 px-3 font-medium text-right">
                    Cumulative target
                  </th>
                  {PRE_WARNS.map((p) => (
                    <th
                      key={p.key}
                      className="py-1.5 px-3 font-medium text-right"
                    >
                      {p.label} %
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preWarnRows.map((row) => (
                  <tr
                    key={row.step}
                    className="border-b border-border/50 hover:bg-muted/20 align-top"
                  >
                    <td className="py-1.5 pr-3">
                      <span className="font-mono font-semibold">{row.step}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {stepLabel(row.step)}
                      </span>
                      {!isAll && row.rowHasOverride && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-primary font-semibold">
                          override
                        </span>
                      )}
                      {row.inverted && (
                        <span className="block text-[10px] text-ageing-red mt-0.5">
                          stages out of order
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium text-muted-foreground">
                      {cumTargets[row.step]}d
                    </td>
                    {row.cells.map((cell) => (
                      <td key={cell.key} className="py-1.5 px-3">
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-1">
                            <NumberInput
                              type="number"
                              min={0}
                              max={100}
                              value={
                                isAll
                                  ? cell.inherited
                                  : cell.overrideVal ?? ""
                              }
                              placeholder={
                                isAll ? undefined : String(cell.inherited)
                              }
                              onValueChange={(v) =>
                                setPreWarn(row.step, cell.key, v)
                              }
                              className={`h-7 w-14 tabular-nums text-right ${
                                cell.overridden
                                  ? "ring-1 ring-primary/50"
                                  : "text-muted-foreground"
                              }`}
                              aria-label={`${row.step} ${cell.key} percent`}
                            />
                            <span className="text-[10px] text-muted-foreground w-3">
                              %
                            </span>
                          </div>
                          <div className="flex items-center gap-2 h-3.5 text-[9px] uppercase tracking-wider">
                            {!isAll && !cell.overridden && (
                              <span className="text-muted-foreground/70">
                                inherited
                              </span>
                            )}
                            {!isAll && cell.overridden && (
                              <button
                                type="button"
                                onClick={() =>
                                  inheritPreWarn(row.step, cell.key)
                                }
                                className="text-muted-foreground hover:text-foreground underline"
                              >
                                inherit
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs text-muted-foreground mt-3 space-y-2">
            {pwInvertedSteps.length > 0 && (
              <p className="text-ageing-red">
                Some activities have pre-warning stages out of order (
                {pwInvertedSteps.join(", ")}). They are raised to keep Pre-warn 1
                &le; 2 &le; 3 when classifying.
              </p>
            )}
            <div className="flex items-center gap-2 pt-1 border-t border-border/50">
              <label
                htmlFor="stalled-days"
                className="text-xs text-foreground font-medium"
              >
                Stalled after
              </label>
              <NumberInput
                id="stalled-days"
                type="number"
                min={0}
                value={settings.stalledDays ?? DEFAULT_STALLED_DAYS}
                onValueChange={(v) => setStalledDays(v)}
                className="h-7 w-16 tabular-nums text-right"
                aria-label="Stalled days threshold"
              />
              <span className="text-xs text-muted-foreground">
                days without any activity or production-date movement (global;
                flags stalled marks on the Overview).
              </span>
            </div>
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
  step: string;
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
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1">
        <NumberInput
          type="number"
          min={0}
          value={daysValue}
          placeholder={daysPlaceholder}
          onValueChange={(v) => onValue(v)}
          className={`h-7 w-14 tabular-nums text-right ${
            isManual ? "ring-1 ring-primary/50" : "text-muted-foreground"
          }`}
          aria-label={`${step} ${band} grace days`}
          title={isAuto ? "Auto-derived from percentage" : undefined}
        />
        <span className="text-[10px] text-muted-foreground w-3">d</span>
      </div>
      <div className="flex items-center gap-1">
        <NumberInput
          type="number"
          min={0}
          value={pctValue}
          placeholder={pctPlaceholder}
          onValueChange={(v) => onPercent(v)}
          className={`h-7 w-14 tabular-nums text-right ${
            isAuto ? "ring-1 ring-primary/50" : "text-muted-foreground"
          }`}
          aria-label={`${step} ${band} grace percent`}
        />
        <span className="text-[10px] text-muted-foreground w-3">%</span>
      </div>
      <div className="flex items-center gap-2 h-3 text-[9px] uppercase tracking-wider">
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
