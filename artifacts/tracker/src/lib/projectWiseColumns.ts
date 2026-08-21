// ─── Project Wise column set — single source of truth ───────────────────────
// The on-screen table header (job-dashboard.tsx) and the Excel export builder
// both read from this module so their labels can never drift apart again
// (same consolidation as QC_ACTIVITY_SET / GALV_ACTIVITY_SET in lib/domain).
//
// Conventions:
// - `uiLabel` is the on-screen header text (units implied by context).
// - `exportLabel` is the self-describing spreadsheet header (carries units and
//   the activity qualifier the UI shows beneath the phase name).
// - `uiVisible: false` marks export-only columns; they are grouped last and
//   the first of them carries EXPORT_ONLY_NOTE as a header comment.
// - A phase with a two-line UI header (name + "wt / marks") exports as TWO
//   columns suffixed "Wt (MT)" and "Marks".

export const EXPORT_ONLY_NOTE =
  "Columns beyond this point are export-only and are not shown on screen.";

export type PhaseLike = {
  key: string;
  label: string;
  subLabel?: string;
  activities: readonly string[];
};

// The qualifier the UI renders under a phase name, e.g. "(No contractor)",
// "(C)", "(HG, RFI, NH, B, HAB, W, Q, TS)". Empty string when there is none.
export function phaseQualifier(ph: PhaseLike): string {
  if (ph.subLabel) return `(${ph.subLabel})`;
  if (ph.activities.length) return `(${ph.activities.join(", ")})`;
  return "";
}

export type ProjectWiseColumn = {
  uiLabel: string;
  exportLabel: string;
  field: string;
  numeric?: boolean;
  decimals?: number;
  total?: boolean;
  uiVisible: boolean;
  headerNote?: string;
};

// Fixed leading columns (after the primary Project/Group column).
// Release Balance Computed has a two-line wt/marks UI header, so it exports as
// an (MT) + Marks pair like every phase bucket.
export function leadingColumns(): ProjectWiseColumn[] {
  return [
    { uiLabel: "Work Order Qty", exportLabel: "Work Order Qty (MT)", field: "workOrderMt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "Dispatch Qty", exportLabel: "Dispatch Qty (MT)", field: "dispatchMt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "Dispatch Balance", exportLabel: "Dispatch Balance (MT)", field: "dispatchBalanceMt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "FG (Order Review)", exportLabel: "FG (Order Review) (MT)", field: "fgOverviewComputedMt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "Release Balance Computed", exportLabel: "Release Balance Computed (MT)", field: "releaseBalanceComputedMt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "Release Balance Computed", exportLabel: "Release Balance Computed Marks", field: "releaseBalanceComputedMarks", numeric: true, decimals: 0, total: true, uiVisible: true },
  ];
}

// Stage/phase columns. Each phase exports a "<label> <qualifier> Wt (MT)" +
// "<label> <qualifier> Marks" pair, mirroring the UI's two-line wt/marks
// header. The FG (WIP file) bucket keeps its historical export labels
// ("FG (WIP file) (MT)" — the name is already self-describing, so no
// qualifier) and now gains the previously missing Marks column.
export function stageColumns(phases: readonly PhaseLike[], opts: { isNtlt: boolean }): ProjectWiseColumn[] {
  return phases.flatMap((ph): ProjectWiseColumn[] => {
    if (!opts.isNtlt && ph.key === "dispatch") {
      return [
        { uiLabel: ph.label, exportLabel: "FG (WIP file) (MT)", field: "fgWipWt", numeric: true, decimals: 3, total: true, uiVisible: true },
        { uiLabel: ph.label, exportLabel: "FG (WIP file) Marks", field: "fgWipMarks", numeric: true, decimals: 0, total: true, uiVisible: true },
      ];
    }
    const q = phaseQualifier(ph);
    const base = q ? `${ph.label} ${q}` : ph.label;
    const fieldBase = opts.isNtlt
      ? `ntlt_${ph.key}`
      : ph.key === "awaitingAssignment" ? "awaitingAssignment"
      : ph.key === "cutting" ? "cutting"
      : ph.key === "quality" ? "quality"
      : ph.key === "galvanising" ? "galvanising"
      : ph.key;
    return [
      { uiLabel: ph.label, exportLabel: `${base} Wt (MT)`, field: opts.isNtlt ? `${fieldBase}_wt` : `${fieldBase}Wt`, numeric: true, decimals: 3, total: true, uiVisible: true },
      { uiLabel: ph.label, exportLabel: `${base} Marks`, field: opts.isNtlt ? `${fieldBase}_marks` : `${fieldBase}Marks`, numeric: true, decimals: 0, total: true, uiVisible: true },
    ];
  });
}

// Trailing columns: the UI-visible Total/Avg Ageing pair, then the six
// export-only columns, grouped last. The three ageing buckets cover ASSIGNED
// marks only (Release Balance and Awaiting Assignment marks have no assign
// date and therefore no age) — the "(assigned)" qualifier makes the shortfall
// against Total Marks self-explaining.
export function trailingColumns(): ProjectWiseColumn[] {
  return [
    { uiLabel: "Total", exportLabel: "Total Wt (MT)", field: "totalWt", numeric: true, decimals: 3, total: true, uiVisible: true },
    { uiLabel: "Total", exportLabel: "Total Marks", field: "marks", numeric: true, decimals: 0, total: true, uiVisible: true },
    { uiLabel: "Avg Ageing", exportLabel: "Avg Ageing (d)", field: "avgAge", numeric: true, decimals: 0, uiVisible: true },
    { uiLabel: "", exportLabel: "First Assign", field: "firstAssign", uiVisible: false, headerNote: EXPORT_ONLY_NOTE },
    { uiLabel: "", exportLabel: "Structures", field: "structures", numeric: true, decimals: 0, uiVisible: false },
    { uiLabel: "", exportLabel: "Balance Qty", field: "qty", numeric: true, decimals: 0, total: true, uiVisible: false },
    { uiLabel: "", exportLabel: "0-30d (assigned)", field: "c0to30", numeric: true, decimals: 0, uiVisible: false },
    { uiLabel: "", exportLabel: "31-60d (assigned)", field: "c31to60", numeric: true, decimals: 0, uiVisible: false },
    { uiLabel: "", exportLabel: "60d+ (assigned)", field: "c60Plus", numeric: true, decimals: 0, uiVisible: false },
  ];
}

// The full export column list for a given mode. `groupLabel` is the primary
// dimension header ("Project" / "Section" / "Group").
export function projectWiseExportColumns(
  groupLabel: string,
  phases: readonly PhaseLike[],
  opts: { isNtlt: boolean },
): Array<{ label: string; field: string; numeric?: boolean; decimals?: number; total?: boolean; headerNote?: string }> {
  const cols: ProjectWiseColumn[] = [
    { uiLabel: groupLabel, exportLabel: groupLabel, field: "job", uiVisible: true },
    ...leadingColumns(),
    ...stageColumns(phases, opts),
    ...trailingColumns(),
  ];
  return cols.map(({ exportLabel, field, numeric, decimals, total, headerNote }) => ({
    label: exportLabel,
    field,
    numeric,
    decimals,
    total,
    headerNote,
  }));
}
