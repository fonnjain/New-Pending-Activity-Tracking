import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListImports, useListContractorCategories, useListContractorAliases, useGetCurrentJobs, useGetInventoryBuckets, getGetInventoryBucketsQueryKey, useListInventoryManualE, useListInventoryMfcBatchColors, type Record } from "@workspace/api-client-react";
import { computeAutoBuckets } from "@/lib/inventory";
import { getActivityBundle, normalizeContractorName, resolveContractorKey, filterRecords, parseAssignDateMs, dateToDayKey, type RecordFilters } from "@workspace/domain";

// Sentinel prefix that marks an activity-bundle selection inside the single
// `filters.activity` slot. A plain activity code (e.g. "Y") is matched exactly;
// a "bundle:<id>" value is resolved to the bundle's member set and OR-matched.
const BUNDLE_PREFIX = "bundle:";

// Sentinel stored in `filters.job` for the "Current Jobs" set-membership mode
// (an uploaded list of project codes, not a real job value). Resolved into
// `RecordFilters.jobIn` by resolveActiveFilters; never itself matched against
// a record's `job` field.
export const CURRENT_JOBS_FILTER_VALUE = "__CURRENT_JOBS__";

// Sentinel stored in `filters.job` when the user picks "Select Multiple Jobs".
// The actual selected codes live in `filters.selectedJobs` (string[]). Resolved
// into `RecordFilters.jobIn` by resolveActiveFilters.
export const MULTI_JOBS_FILTER_VALUE = "__MULTI_JOBS__";
// Multi-template sentinel: job filter is a union of several named templates.
// The checked template ids live in filters.selectedTemplateIds.
export const MULTI_TEMPLATES_FILTER_VALUE = "__MULTI_TEMPLATES__";

// Job Templates — named project sets managed via the Job Templates admin page.
// Each template filter value embeds the template DB id so resolution is O(1).
export const TEMPLATE_FILTER_PREFIX = "__TEMPLATE_";
export function isTemplateFilter(v: string | null | undefined): v is string {
  return !!v?.startsWith(TEMPLATE_FILTER_PREFIX);
}
export function templateFilterValue(id: number): string {
  return `${TEMPLATE_FILTER_PREFIX}${id}__`;
}
export function extractTemplateId(v: string): number {
  return parseInt(v.slice(TEMPLATE_FILTER_PREFIX.length).replace(/__$/, ""), 10);
}
/** True when the filter is any kind of named project set (old current-jobs or new template). */
export function isNamedJobSetFilter(v: string | null | undefined): boolean {
  // Check string-equality branches before the type-guard call (isTemplateFilter
  // narrows v to `never`/`null|undefined` in the trailing else branch, causing
  // TS2367 if we compare v to another string literal after it).
  return v === CURRENT_JOBS_FILTER_VALUE || v === MULTI_TEMPLATES_FILTER_VALUE || isTemplateFilter(v);
}

/** Global view mode controlling how MFC Batch relates to Project in all grouping tables.
 *  - "project-with-mfc"  (default): Project is primary, MFC Batch is a sub-level under it.
 *  - "view-by-mfc":                 MFC Batch is primary within BOM/SubType; Projects nested below.
 *  - "project-then-mfc":            Flat combined key "{project}-{mfcBatch}" (no separate columns).
 */
export type MfcViewMode = "project-with-mfc" | "view-by-mfc" | "project-then-mfc";

export interface JobTemplate {
  id: number;
  name: string;
  category: string;
  sortOrder: number;
  members: string[];
}

export interface Filters {
  category: string; // "TLT" | "NTLT" (Order type) — a MODE, never null
  ntltSubtype: string | null; // "RSJ" | "EARTHING" | "GENERAL" (only within NTLT)
  job: string | null; // primary dimension in TLT mode
  section: string | null; // primary dimension in NTLT mode (matches groupKey)
  mfcBatch: string | null; // TLT sub-level: MFC batch (WO Batch No.), between Project and Structure
  structure: string | null;
  mark: string | null;
  contractor: string | null;
  contractorCategory: string | null; // CNC | SUB_CONTRACTOR | OUT_VENDOR | UNCLASSIFIED
  outVendorType: string | null; // FAB | GALVA (only meaningful with OUT_VENDOR)
  activity: string | null;
  holeOperation: string | null; // "PUNCHING" | "DRILLING" | "NOT_SET" (derived)
  dateRange: string | null;
  search: string;
  // Active only when job === MULTI_JOBS_FILTER_VALUE. Stores the user's checked
  // project codes. Cleared whenever job is changed to anything else.
  selectedJobs: string[];
  // Active only when job === MULTI_TEMPLATES_FILTER_VALUE. Stores the checked
  // template ids whose members are unioned to form the active job set.
  selectedTemplateIds: number[];
  // Multi-select job codes for the Jobs picker (replaces single-select filters.job
  // when non-empty). [] means no restriction. Cleared when filters.job is set to
  // any non-null value; setting selectedJobCodes clears filters.job.
  selectedJobCodes: string[];
  // Plant location multi-select: [] means "all locations"; ["unit_1"] filters to
  // only contractors assigned to Unit 1 in the contractor-categories overlay.
  plantLocations: string[];
}

// Pre-computed rank maps used by the global project sort.
// Lifted to context so they're built once and shared across all pages.
export interface ProjectSortRanks {
  templateRank: Map<string, number>;
  bucketRank: Map<string, number>;
  mfcDateByProject: Map<string, string>;
}

interface TrackerContextType {
  selectedImportId: number | null;
  setSelectedImportId: (id: number | null) => void;
  filters: Filters;
  setFilter: (key: keyof Filters, value: string | null) => void;
  setSelectedJobs: (jobs: string[]) => void;
  setSelectedTemplates: (ids: number[]) => void;
  setSelectedJobCodes: (codes: string[]) => void;
  setPlantLocations: (locations: string[]) => void;
  clearFilters: () => void;
  mfcViewMode: MfcViewMode;
  setMfcViewMode: (mode: MfcViewMode) => void;
  projectSort: ProjectSortKey;
  setProjectSort: (key: ProjectSortKey) => void;
  sortRanks: ProjectSortRanks;
}

// Global project sort applied wherever project lists are ordered (currently
// the Project Wise page). Lives in the tracker context so the choice follows
// the user across pages.
export type ProjectSortKey =
  | "templates" // Job Templates order (P1 members first, then P2, …)
  | "project" // alphabetical by project code
  | "bucket" // Bucket List order (Bucket A first, then Pre-B, B, C, D, E)
  | "ageing" // highest average ageing first
  | "mfcDate" // earliest Date of Client MFC first
  | "assignDate"; // earliest first assign date first

const defaultFilters: Filters = {
  category: "TLT",
  ntltSubtype: null,
  job: null,
  section: null,
  mfcBatch: null,
  structure: null,
  mark: null,
  contractor: null,
  contractorCategory: null,
  outVendorType: null,
  activity: null,
  holeOperation: null,
  dateRange: null,
  search: "",
  selectedJobs: [],
  selectedTemplateIds: [],
  selectedJobCodes: [],
  plantLocations: [],
};

const TrackerContext = createContext<TrackerContextType | undefined>(undefined);

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [selectedImportId, setSelectedImportIdState] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [mfcViewMode, setMfcViewMode] = useState<MfcViewMode>("project-with-mfc");
  const [projectSort, setProjectSort] = useState<ProjectSortKey>("templates");
  const { data: imports } = useListImports();

  // ── Rank maps for global project sort ───────────────────────────────────
  // Fetched once at the provider level so every page reads from the same
  // cache rather than each triggering its own useMemo computation.
  const jobTemplates = useJobTemplates();
  const { data: bucketsData } = useGetInventoryBuckets({
    query: { queryKey: getGetInventoryBucketsQueryKey() },
  });
  const { data: manualE = [] } = useListInventoryManualE();
  const { data: mfcBatchColors = [] } = useListInventoryMfcBatchColors();

  const sortRanks = useMemo((): ProjectSortRanks => {
    // Job Templates List rank.
    const templateRank = new Map<string, number>();
    let i = 0;
    for (const t of [...jobTemplates].sort((a, b) => a.sortOrder - b.sortOrder)) {
      for (const m of t.members) {
        const code = m.split(" - ")[0].trim();
        if (!templateRank.has(code)) templateRank.set(code, i++);
      }
    }

    // Bucket List rank: A → Pre-B → B → C → D → E.
    // Pre-B = B/C/D rows without a colour assignment (same gate as the page).
    const bucketRank = new Map<string, number>();
    const rawRows = bucketsData?.rows ?? [];
    const eExcludeKeys = new Set<string>();
    for (const e of manualE) {
      eExcludeKeys.add(`${e.projectCode}\u0001${e.mfcBatch ?? "Z"}`);
    }
    const buckets = computeAutoBuckets(rawRows, eExcludeKeys);
    const colourKeys = new Set<string>();
    for (const c of mfcBatchColors) {
      if (c.color) colourKeys.add(`${c.project}\u0001${c.mfcBatch}`);
    }
    const hasColour = (r: { project: string; mfcBatch: string }) =>
      colourKeys.has(`${r.project}\u0001${r.mfcBatch}`);
    const bucketTiers: { projects: string[]; tier: number }[] = [
      { projects: buckets.a.map((r) => r.project), tier: 0 },
      {
        projects: [...buckets.b, ...buckets.c, ...buckets.d]
          .filter((r) => !hasColour(r))
          .map((r) => r.project),
        tier: 1,
      },
      { projects: buckets.b.filter(hasColour).map((r) => r.project), tier: 2 },
      { projects: buckets.c.filter(hasColour).map((r) => r.project), tier: 3 },
      { projects: buckets.d.filter(hasColour).map((r) => r.project), tier: 4 },
      { projects: manualE.map((e) => e.projectCode), tier: 5 },
    ];
    for (const { projects, tier } of bucketTiers) {
      for (const p of projects) {
        const existing = bucketRank.get(p);
        if (existing === undefined || tier < existing) bucketRank.set(p, tier);
      }
    }

    // MFC Date rank: earliest Date of Client MFC across a project's batches.
    const mfcDateByProject = new Map<string, string>();
    for (const c of mfcBatchColors) {
      const v = String(c.dateOfClientMfc ?? "").trim();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      if (!d) continue;
      const existing = mfcDateByProject.get(c.project);
      if (!existing || d < existing) mfcDateByProject.set(c.project, d);
    }

    return { templateRank, bucketRank, mfcDateByProject };
  }, [jobTemplates, bucketsData, manualE, mfcBatchColors]);

  // When true the selection always tracks imports[0] (the newest upload).
  // Flips to false only when the user explicitly clicks a specific import in
  // the list (pinning). Flips back to true when the pinned import is deleted
  // or when the user resets to null.
  const followingLatest = useRef(true);

  // Public setter exposed via context.
  // Passing null means "go back to following latest".
  // Passing a specific id means "pin to this import".
  const setSelectedImportId = (id: number | null) => {
    if (id === null) {
      followingLatest.current = true;
      setSelectedImportIdState(null);
    } else {
      followingLatest.current = false;
      setSelectedImportIdState(id);
    }
  };

  // Clear any previously-persisted job filter so the default stays "All Jobs".
  useEffect(() => { try { localStorage.removeItem("vtpl:jobFilter"); } catch { /* ignore */ } }, []);

  // Keep the selection in sync with the imports list.
  // • When following latest: always track imports[0] so a fresh upload is
  //   reflected immediately once the list refreshes (avoids the race where
  //   setSelectedImportId(newId) fires before the list includes that id).
  // • When pinned: only recover if the pinned import was deleted.
  useEffect(() => {
    if (!imports) return;
    if (imports.length === 0) {
      followingLatest.current = true;
      if (selectedImportId !== null) setSelectedImportIdState(null);
      return;
    }
    if (followingLatest.current) {
      if (imports[0].id !== selectedImportId) setSelectedImportIdState(imports[0].id);
    } else {
      const exists = imports.some((s) => s.id === selectedImportId);
      if (!exists) {
        followingLatest.current = true;
        setSelectedImportIdState(imports[0].id);
      }
    }
  }, [imports, selectedImportId]);

  const setSelectedJobs = (jobs: string[]) => {
    setFilters((prev) => ({
      ...prev,
      selectedJobs: jobs,
      selectedTemplateIds: [],
      // This setter always clears the template selection, so a template
      // sentinel (e.g. MULTI_TEMPLATES "0 Templates") must never remain in
      // `job` — it would match nothing. A plain job code stays untouched
      // (job and mfcBatch are independent of the combo picker).
      job: isNamedJobSetFilter(prev.job) ? null : prev.job,
    }));
  };

  const setSelectedTemplates = (ids: number[]) => {
    setFilters((prev) => ({
      ...prev,
      selectedTemplateIds: ids,
      selectedJobs: [],
      mfcBatch: null,
      structure: null,
      mark: null,
      job: ids.length > 0 ? MULTI_TEMPLATES_FILTER_VALUE : null,
    }));
  };

  const setSelectedJobCodes = (codes: string[]) => {
    setFilters((prev) => ({
      ...prev,
      selectedJobCodes: codes,
      // Job-code multi-select and the single-select job sentinel occupy the same
      // filter dimension — clear the single-select when codes are set.
      job: codes.length > 0 ? null : prev.job,
      // Cascade: narrowing/changing the job dimension drops stale sub-selections.
      mfcBatch: null,
      structure: null,
      mark: null,
      // Named-set template selection is incompatible with explicit job codes.
      selectedTemplateIds: [],
    }));
  };

  const setPlantLocations = (locations: string[]) => {
    setFilters((prev) => ({ ...prev, plantLocations: locations }));
  };

  const setFilter = (key: keyof Filters, value: string | null) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // Cascading logic
      if (key === "category") {
        // The toggle drives BOTH filter dimension and grouping. Switching mode
        // resets every dimension filter to its "All" default so no stale
        // cross-mode selection (e.g. a TLT project carried into NTLT) persists.
        next.ntltSubtype = null;
        next.job = null;
        next.section = null;
        next.mfcBatch = null;
        next.structure = null;
        next.mark = null;
        // A TLT-scoped activity bundle is not offered outside TLT mode; drop it
        // so the activity filter can't silently empty an NTLT view. Plain codes
        // and ALL-scope bundles (Galvanizing/Yard) are valid everywhere and kept.
        if (next.activity?.startsWith(BUNDLE_PREFIX)) {
          const b = getActivityBundle(next.activity.slice(BUNDLE_PREFIX.length));
          if (b && b.scope === "TLT" && value !== "TLT") next.activity = null;
        }
      } else if (key === "job") {
        // TLT primary cascade: Project -> MFC -> Structure -> Mark
        next.mfcBatch = null;
        next.structure = null;
        next.mark = null;
        // selectedJobCodes is the multi-select version of the same dimension;
        // clear it when the single-select is explicitly set.
        next.selectedJobCodes = [];
        // selectedJobs (combo picker) is independent — do not clear it here.
        // Clear template list when leaving template mode.
        if (value !== MULTI_TEMPLATES_FILTER_VALUE) next.selectedTemplateIds = [];
      } else if (key === "mfcBatch") {
        // MFC sits between Project and Structure in TLT; narrowing it drops any
        // stale structure/mark selection from a different batch.
        next.structure = null;
        next.mark = null;
      } else if (key === "section") {
        // NTLT primary cascade: Section -> Sub-category -> Mark
        next.ntltSubtype = null;
        next.mark = null;
      } else if (key === "ntltSubtype") {
        // Sub-category narrows the Section list, so a section picked under a
        // different sub-category must not linger (it would yield empty data).
        next.section = null;
        next.mark = null;
      } else if (key === "structure") {
        next.mark = null;
      } else if (key === "contractorCategory") {
        // The FAB/GALVA tag only narrows Out-vendors; drop it whenever the
        // category is anything other than OUT_VENDOR so it can't silently empty
        // the view.
        if (value !== "OUT_VENDOR") next.outVendorType = null;
      }
      return next;
    });
  };

  // Clearing preserves the current Order Type mode (it is a mode, not a filter)
  // and resets every other dimension/secondary filter.
  const clearFilters = () =>
    setFilters((prev) => ({ ...defaultFilters, category: prev.category }));

  return (
    <TrackerContext.Provider value={{ selectedImportId, setSelectedImportId, filters, setFilter, setSelectedJobs, setSelectedTemplates, setSelectedJobCodes, setPlantLocations, clearFilters, mfcViewMode, setMfcViewMode, projectSort, setProjectSort, sortRanks }}>
      {children}
    </TrackerContext.Provider>
  );
}

export function useTracker() {
  const ctx = useContext(TrackerContext);
  if (!ctx) throw new Error("useTracker must be used within TrackerProvider");
  return ctx;
}

// Build a date safely: an out-of-range monthIndex is normalized, and the day is
// clamped to the last valid day of the target month so rolling windows don't
// drift at month-end (e.g. "3 months before May 31" -> Feb 28/29, not Mar 2/3).
function clampedDate(year: number, monthIndex: number, day: number): Date {
  const firstOfMonth = new Date(year, monthIndex, 1);
  const Y = firstOfMonth.getFullYear();
  const M = firstOfMonth.getMonth();
  const lastDay = new Date(Y, M + 1, 0).getDate();
  return new Date(Y, M, Math.min(day, lastDay));
}

export function dateRangeWindow(code: string | null): { start: Date; end: Date } | null {
  if (!code) return null;
  // Custom range encoded as "custom:YYYY-MM-DD:YYYY-MM-DD" (either side may be
  // blank while the user is still picking). End date is inclusive.
  if (code.startsWith("custom:")) {
    const [, s, e] = code.split(":");
    const startD = parseAssignDate(s);
    const endD = parseAssignDate(e);
    if (!startD || !endD) return null;
    const [lo, hi] = startD <= endD ? [startD, endD] : [endD, startD];
    const end = new Date(hi.getFullYear(), hi.getMonth(), hi.getDate() + 1); // exclusive
    return { start: lo, end };
  }
  // A single calendar month, encoded as "month:YYYY-MM" (e.g. "month:2026-06"
  // for June 2026). Whole-month window, end exclusive.
  if (code.startsWith("month:")) {
    const [, ym] = code.split(":");
    const [yStr, mStr] = (ym ?? "").split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (!y || !m || m < 1 || m > 12) return null;
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  }
  // A single calendar quarter, encoded as "quarter:YYYY-Q" (e.g.
  // "quarter:2026-2" for Q2 2026 = Apr-Jun 2026). Whole-quarter window, end
  // exclusive.
  if (code.startsWith("quarter:")) {
    const [, yq] = code.split(":");
    const [yStr, qStr] = (yq ?? "").split("-");
    const y = Number(yStr);
    const q = Number(qStr);
    if (!y || !q || q < 1 || q > 4) return null;
    const startMonth = (q - 1) * 3;
    return { start: new Date(y, startMonth, 1), end: new Date(y, startMonth + 3, 1) };
  }
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const day = now.getDate();
  const endExclusive = new Date(y, mo, day + 1); // start of tomorrow (local)
  switch (code) {
    case "1d": return { start: new Date(y, mo, day), end: endExclusive };
    case "7d": return { start: new Date(y, mo, day - 6), end: endExclusive };
    case "15d": return { start: new Date(y, mo, day - 14), end: endExclusive };
    case "3m": return { start: clampedDate(y, mo - 3, day), end: endExclusive };
    case "6m": return { start: clampedDate(y, mo - 6, day), end: endExclusive };
    case "9m": return { start: clampedDate(y, mo - 9, day), end: endExclusive };
    case "1y": return { start: clampedDate(y - 1, mo, day), end: endExclusive };
    default: return null;
  }
}

// Thin wrapper over the shared domain parser (single source of truth) returning
// a Date for the local date-window helpers above.
function parseAssignDate(s: string | null | undefined): Date | null {
  const ms = parseAssignDateMs(s);
  return ms === null ? null : new Date(ms);
}

export function isWithinDateRange(assignDate: string | null | undefined, code: string | null): boolean {
  const win = dateRangeWindow(code);
  if (!win) return true;
  const d = parseAssignDate(assignDate);
  if (!d) return false;
  return d >= win.start && d < win.end;
}

// Live contractor sub-category overlay: normalized contractor name -> entry.
// Joined to records at read time; an unmapped contractor is treated as
// UNCLASSIFIED. This NEVER alters parsing/ageing/dedup/qty or the contractor
// string — it only powers descriptive filters/labels.
export interface ContractorCategoryInfo {
  category: string; // CONTRACTOR_CATEGORIES value
  outVendorType: string[]; // FAB/GALVA tags
  displayName: string;
  plantLocation: string | null; // unit_1 | unit_2 | null
}

// Raw alias map: normalizedAliasKey → canonicalKey. Used by useContractorCategoryMap
// to fold aliases into the category lookup, and exported for components that need
// to know the alias-→-canonical key mapping directly (e.g. the Dedup UI).
export function useContractorAliasMap(): Map<string, string> {
  const { data } = useListContractorAliases();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const row of data ?? []) {
      m.set(row.aliasKey, row.canonicalKey);
    }
    return m;
  }, [data]);
}

// Re-export resolveContractorKey so consumers can import from store without
// depending on @workspace/domain directly.
export { resolveContractorKey };

export function useContractorCategoryMap(): Map<string, ContractorCategoryInfo> {
  const { data: categories } = useListContractorCategories();
  const aliasMap = useContractorAliasMap();
  return useMemo(() => {
    const m = new Map<string, ContractorCategoryInfo>();
    for (const row of categories ?? []) {
      m.set(row.nameKey, {
        category: row.category,
        outVendorType: row.outVendorType ?? [],
        displayName: row.displayName,
        plantLocation: row.plantLocation ?? null,
      });
    }
    // Pre-populate alias keys → canonical ContractorCategoryInfo so that
    // contractorCategoryFor(aliasContractor, categoryMap) transparently returns
    // the canonical entry without any call-site changes.
    //
    // IMPORTANT: alias mappings are applied UNCONDITIONALLY, overwriting any
    // contractor_categories row that might exist for the alias key. A row in
    // contractor_categories for an alias key is a stale artefact (e.g. created
    // before the merge was approved, or by an erroneous empty-alias approval).
    // The alias table is always the higher-authority source of truth — letting
    // a stale categories row shadow an alias would silently break dedup.
    for (const [aliasKey, canonicalKey] of aliasMap) {
      const canonical = m.get(canonicalKey);
      if (canonical) m.set(aliasKey, canonical); // alias always wins
    }
    return m;
  }, [categories, aliasMap]);
}

// Resolve a contractor's category info from the overlay map, defaulting to
// UNCLASSIFIED with no tags when the contractor is not mapped.
export function contractorCategoryFor(
  contractor: string | null | undefined,
  map: Map<string, ContractorCategoryInfo>,
): ContractorCategoryInfo {
  const hit = map.get(normalizeContractorName(contractor));
  return hit ?? { category: "UNCLASSIFIED", outVendorType: [], displayName: contractor ?? "", plantLocation: null };
}

// Live "Current Jobs" list (uploaded project codes) as a Set, plus its raw
// meta. Powers the "Current Jobs" Job filter option; empty when nothing has
// been uploaded (or after a clear) -- selecting it then legitimately yields
// zero records rather than falling back to "All".
export function useCurrentJobsSet() {
  const { data } = useGetCurrentJobs();
  const set = useMemo(() => new Set(data?.codes ?? []), [data]);
  return { set, meta: data?.meta ?? null };
}

// All job templates from the server, used by the filter dropdown and the
// active-job-set resolver.
export function useJobTemplates(): JobTemplate[] {
  const { data } = useQuery<JobTemplate[]>({
    queryKey: ["job-templates"],
    queryFn: () =>
      fetch("/api/job-templates", { credentials: "include" }).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
  });
  return data ?? [];
}

// Returns the project-code Set for the currently active filter, handling both
// the legacy "Current Jobs" sentinel and the new named-template sentinels.
// Use this everywhere pages need to resolve the active named set.
export function useActiveJobSet(): ReadonlySet<string> {
  const { filters } = useTracker();
  const { set: currentJobsSet } = useCurrentJobsSet();
  const templates = useJobTemplates();

  return useMemo(() => {
    if (filters.job === CURRENT_JOBS_FILTER_VALUE) return currentJobsSet;
    if (isTemplateFilter(filters.job)) {
      // Single-template (legacy path — kept for backward compat).
      const id = extractTemplateId(filters.job);
      const tpl = templates.find((t) => t.id === id);
      return new Set<string>(tpl?.members ?? []);
    }
    if (filters.job === MULTI_TEMPLATES_FILTER_VALUE) {
      // Union of all checked template member sets.
      const union = new Set<string>();
      for (const id of filters.selectedTemplateIds) {
        const tpl = templates.find((t) => t.id === id);
        if (tpl) tpl.members.forEach((m) => union.add(m));
      }
      return union;
    }
    return new Set<string>();
  }, [filters.job, filters.selectedTemplateIds, currentJobsSet, templates]);
}

// Resolve the active filters into the shared RecordFilters shape plus the
// concrete date window (epoch ms, computed from LOCAL today). `namedJobSet`
// resolves both the legacy CURRENT_JOBS_FILTER_VALUE sentinel and the new
// template sentinels into a set-membership filter; pass the result of
// useActiveJobSet() when calling from a component, or null when the caller
// knows named-set filters can't be active.
export function resolveActiveFilters(
  filters: Filters,
  namedJobSet?: ReadonlySet<string> | null,
): {
  filters: RecordFilters;
  dateWindow: { start: number; end: number } | null;
} {
  const win = dateRangeWindow(filters.dateRange);
  const isNamedSet = isNamedJobSetFilter(filters.job);
  return {
    filters: {
      category: filters.category,
      ntltSubtype: filters.ntltSubtype,
      // Named-set filters expand to jobIn (set membership); everything else is
      // a plain job code or null (= all). MULTI_JOBS_FILTER_VALUE is a legacy
      // sentinel that is no longer set by setSelectedJobs; guard it for safety.
      job: isNamedSet ? null : (filters.job === MULTI_JOBS_FILTER_VALUE ? null : filters.job),
      // selectedJobCodes: multi-select job code filter (OR within set, AND with others).
      // Mutually exclusive with the single-select `job` in the UI, but not at the
      // resolved level — both are null when neither is active.
      selectedJobCodes: filters.selectedJobCodes.length > 0
        ? new Set(filters.selectedJobCodes)
        : null,
      // jobIn: named-set wins; otherwise combo-picker selections (combo keys like
      // "920 - C") are used — the domain filterRecords checks both the plain job
      // code and the "job - mfcBatch" form so these match correctly.
      jobIn: isNamedSet
        ? (namedJobSet ?? new Set<string>())
        : filters.selectedJobs.length > 0
          ? new Set(filters.selectedJobs)
          : null,
      section: filters.section,
      mfcBatch: filters.mfcBatch,
      structure: filters.structure,
      mark: filters.mark,
      contractor: filters.contractor,
      contractorCategory: filters.contractorCategory,
      outVendorType: filters.outVendorType,
      activity: filters.activity,
      holeOperation: filters.holeOperation,
      search: filters.search,
    },
    dateWindow: win ? { start: dateToDayKey(win.start), end: dateToDayKey(win.end) } : null,
  };
}

export function useFilteredRecords(records: Record[] | undefined) {
  const { filters } = useTracker();
  const categoryMap = useContractorCategoryMap();
  const aliasMap = useContractorAliasMap();
  const activeJobSet = useActiveJobSet();

  return useMemo(() => {
    if (!records) return [];
    const { filters: rf, dateWindow } = resolveActiveFilters(filters, activeJobSet);
    let result = filterRecords(records, rf, { dateWindow, categoryMap, aliasMap });
    // Plant location post-filter: restrict to contractors whose plantLocation is
    // in the selected set. An unclassified/unmapped contractor (plantLocation null)
    // is excluded when any location is selected.
    if (filters.plantLocations.length > 0) {
      const plantSet = new Set(filters.plantLocations);
      result = result.filter((r) => {
        const info = contractorCategoryFor(r.contractor, categoryMap);
        return info.plantLocation != null && plantSet.has(info.plantLocation);
      });
    }
    return result;
  }, [records, filters, categoryMap, aliasMap, activeJobSet]);
}
