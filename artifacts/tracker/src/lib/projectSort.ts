// Global project sort — a single ordering for project-keyed lists across all
// pages and reports, driven by the header "Sort" control (TrackerContext).
//
// The three rank maps (templateRank, bucketRank, mfcDateByProject) are built
// once inside TrackerProvider and passed through context. Every consumer calls
// useProjectCompare() which reads from context — no per-page fetching.
import { useCallback } from "react";
import { useTracker, type ProjectSortKey } from "@/lib/store";

export { type ProjectSortKey };

export const PROJECT_SORT_OPTIONS: { id: ProjectSortKey; name: string }[] = [
  { id: "templates", name: "Job Templates List" },
  { id: "project", name: "Project Wise" },
  { id: "bucket", name: "Bucket List" },
  { id: "ageing", name: "Avg Ageing" },
  { id: "mfcDate", name: "MFC Date" },
  { id: "assignDate", name: "Assign Date" },
];

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
 * Returns a stable comparator over project codes honoring the global sort choice.
 * Keys may carry an "All"-mode prefix ("TLT: 920") or a batch suffix — the
 * plain project code (up to the first " - " / " / ", after any prefix) is
 * used for rank lookups; ties and unranked keys fall back to alphabetical.
 */
export function useProjectCompare(): ProjectCompare {
  const { projectSort, sortRanks } = useTracker();
  const { templateRank, bucketRank, mfcDateByProject } = sortRanks;

  return useCallback<ProjectCompare>(
    (a, b, extras) => {
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
