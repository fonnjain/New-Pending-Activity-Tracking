// Global project sort — a single ordering for project-keyed lists across all
// pages and reports, driven by the header "Sort" control (TrackerContext).
//
// Options that need external data (Job Templates order, Bucket List order,
// MFC dates) are resolved here from the same sources the respective pages
// use. "Avg Ageing" / "Assign Date" need per-page aggregates: callers that
// have them pass extras; callers that don't fall back to alphabetical.
import { useMemo, useCallback } from "react";
import {
  useTracker,
  useJobTemplates,
  type ProjectSortKey,
} from "@/lib/store";
import { useInventoryData } from "@/lib/inventory";
import { useListInventoryMfcBatchColors } from "@workspace/api-client-react";

export const PROJECT_SORT_OPTIONS: { id: ProjectSortKey; name: string }[] = [
  { id: "templates", name: "Job Templates List" },
  { id: "project", name: "Project Wise" },
  { id: "bucket", name: "Bucket List" },
  { id: "ageing", name: "Avg Ageing" },
  { id: "mfcDate", name: "MFC Date" },
  { id: "assignDate", name: "Assign Date" },
];

const isoDateStr = (s: unknown): string | null => {
  const v = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export interface ProjectSortExtras {
  /** Average ageing (days) for a project key; higher sorts first. */
  avgAge?: (job: string) => number | null | undefined;
  /** Earliest assign date (ISO yyyy-mm-dd) for a project key; earlier sorts first. */
  firstAssign?: (job: string) => string | null | undefined;
}

export type ProjectCompare = (
  a: string,
  b: string,
  extras?: ProjectSortExtras,
) => number;

/**
 * Returns a comparator over project codes honoring the global sort choice.
 * Keys may carry an "All"-mode prefix ("TLT: 920") or a batch suffix — the
 * plain project code (up to the first " - " / " / ", after any prefix) is
 * used for rank lookups; ties and unranked keys fall back to alphabetical.
 */
export function useProjectCompare(): ProjectCompare {
  const { projectSort } = useTracker();
  const jobTemplates = useJobTemplates();
  const { buckets, manualE } = useInventoryData();
  const { data: mfcBatchColors = [] } = useListInventoryMfcBatchColors();

  // Job Templates List: P1's members first (in member order), then P2's, …
  // Members may be plain codes or combo keys ("821 - Z") — rank the plain code.
  const templateRank = useMemo(() => {
    const rank = new Map<string, number>();
    let i = 0;
    for (const t of [...jobTemplates].sort((a, b) => a.sortOrder - b.sortOrder)) {
      for (const m of t.members) {
        const code = m.split(" - ")[0].trim();
        if (!rank.has(code)) rank.set(code, i++);
      }
    }
    return rank;
  }, [jobTemplates]);

  // Bucket List: earliest bucket in the A → Pre-B → B → C → D → E progression.
  // Pre-B mirrors the Bucket List colour gate: a B/C/D row whose
  // project+batch has no colour assigned sits in "Awaiting Colour Assignment".
  const bucketRank = useMemo(() => {
    const colourKeys = new Set<string>();
    for (const c of mfcBatchColors) {
      if (c.color) colourKeys.add(`${c.project}\u0001${c.mfcBatch}`);
    }
    const hasColour = (r: { project: string; mfcBatch: string }) =>
      colourKeys.has(`${r.project}\u0001${r.mfcBatch}`);
    const rank = new Map<string, number>();
    const tiers: { projects: string[]; tier: number }[] = [
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
    for (const { projects, tier } of tiers) {
      for (const p of projects) {
        const existing = rank.get(p);
        if (existing === undefined || tier < existing) rank.set(p, tier);
      }
    }
    return rank;
  }, [buckets, manualE, mfcBatchColors]);

  // MFC Date: earliest Date of Client MFC across the project's batches.
  const mfcDateByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of mfcBatchColors) {
      const d = isoDateStr(c.dateOfClientMfc);
      if (!d) continue;
      const existing = map.get(c.project);
      if (!existing || d < existing) map.set(c.project, d);
    }
    return map;
  }, [mfcBatchColors]);

  return useCallback<ProjectCompare>(
    (a, b, extras) => {
      // Strip "All"-mode prefixes; rank maps are keyed by plain project code.
      const plainA = plainProject(a);
      const plainB = plainProject(b);
      const alpha = () => a.localeCompare(b);
      const asc = (ra: number | string | undefined, rb: number | string | undefined) => {
        if (ra !== undefined && rb !== undefined && ra !== rb) return ra < rb ? -1 : 1;
        if (ra !== undefined && rb === undefined) return -1;
        if (ra === undefined && rb !== undefined) return 1;
        return alpha();
      };
      switch (projectSort) {
        case "templates":
          return asc(templateRank.get(plainA), templateRank.get(plainB));
        case "bucket":
          return asc(bucketRank.get(plainA), bucketRank.get(plainB));
        case "mfcDate":
          return asc(mfcDateByProject.get(plainA), mfcDateByProject.get(plainB));
        case "ageing": {
          const ga = extras?.avgAge?.(a);
          const gb = extras?.avgAge?.(b);
          if (ga == null && gb == null) return alpha();
          return (gb ?? -1) - (ga ?? -1) || alpha();
        }
        case "assignDate":
          return asc(
            extras?.firstAssign?.(a) ?? undefined,
            extras?.firstAssign?.(b) ?? undefined,
          );
        case "project":
        default:
          return alpha();
      }
    },
    [projectSort, templateRank, bucketRank, mfcDateByProject],
  );
}

/** Extract the plain project code from a possibly prefixed/suffixed key. */
export function plainProject(key: string): string {
  return key
    .replace(/^(?:TLT|NTLT): /, "")
    .split(" - ")[0]
    .split(" / ")[0]
    .trim();
}
