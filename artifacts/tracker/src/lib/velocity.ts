import { useMemo } from "react";
import {
  useGetImportVelocity,
  getGetImportVelocityQueryKey,
  type VelocityItem,
  type VelocityResponse,
} from "@workspace/api-client-react";
import type { VelocityStatus, VelocityTrend } from "@workspace/domain";

// Identity key matching the backend velocity endpoint + movement/diff engines
// (markId + jobCardNo). Used to join velocity data back onto records.
export function velocityKey(
  markId: string | null | undefined,
  jobCardNo: string | null | undefined,
): string {
  return `${markId ?? ""}\u0001${jobCardNo ?? ""}`;
}

export interface VelocityInfo {
  // Per-identity velocity item.
  itemsByKey: Map<string, VelocityItem>;
  items: VelocityItem[];
  projects: VelocityResponse["projects"];
  contractors: VelocityResponse["contractors"];
  stages: VelocityResponse["stages"];
  hasHistory: boolean;
  windowReports: number;
  isLoading: boolean;
  velocityFor: (
    markId: string | null | undefined,
    jobCardNo: string | null | undefined,
  ) => VelocityItem | null;
}

// Fetch per-mark velocity (pace / ETA / trend / status) for an import and expose
// a lookup. Aggregates are returned for the Stuck Projects / Turnaround pages.
export function useVelocityInfo(importId: number | null): VelocityInfo {
  const { data, isLoading } = useGetImportVelocity(importId as number, {
    query: {
      enabled: importId !== null,
      queryKey: getGetImportVelocityQueryKey(importId as number),
    },
  });

  return useMemo(() => {
    const itemsByKey = new Map<string, VelocityItem>();
    for (const item of data?.items ?? []) {
      itemsByKey.set(velocityKey(item.markId, item.jobCardNo), item);
    }
    const velocityFor = (
      markId: string | null | undefined,
      jobCardNo: string | null | undefined,
    ) => itemsByKey.get(velocityKey(markId, jobCardNo)) ?? null;
    return {
      itemsByKey,
      items: data?.items ?? [],
      projects: data?.projects ?? [],
      contractors: data?.contractors ?? [],
      stages: data?.stages ?? [],
      hasHistory: data?.hasHistory ?? false,
      windowReports: data?.windowReports ?? 0,
      isLoading,
      velocityFor,
    };
  }, [data, isLoading]);
}

export const VELOCITY_LABELS: Record<VelocityStatus, string> = {
  moving: "Moving",
  slow: "Slow",
  stalled: "Stalled",
  insufficient: "No history",
};

export const VELOCITY_DESCRIPTIONS: Record<VelocityStatus, string> = {
  moving: "Advancing at or near its expected pace",
  slow: "Moving but materially slower than expected",
  stalled: "No movement for the stalled threshold or longer",
  insufficient: "Not enough snapshot history to compute pace yet",
};

// Tailwind text-color classes per velocity status (display-only; independent of
// the ageing/alert scales). Stalled = red, slow = amber, moving = green.
export function velocityStatusColor(status: VelocityStatus): string {
  switch (status) {
    case "moving":
      return "text-emerald-600";
    case "slow":
      return "text-amber-600";
    case "stalled":
      return "text-red-600";
    default:
      return "text-slate-400";
  }
}

export function velocityStatusBg(status: VelocityStatus): string {
  switch (status) {
    case "moving":
      return "bg-emerald-500";
    case "slow":
      return "bg-amber-500";
    case "stalled":
      return "bg-red-500";
    default:
      return "bg-slate-300";
  }
}

export const TREND_LABELS: Record<VelocityTrend, string> = {
  accelerating: "Accelerating",
  steady: "Steady",
  decelerating: "Decelerating",
  stalled: "Stalled",
  unknown: "Unknown",
};

// A simple directional glyph for a trend (no emojis: ASCII arrows).
export function trendArrow(trend: VelocityTrend): string {
  switch (trend) {
    case "accelerating":
      return "\u2191"; // up
    case "decelerating":
      return "\u2193"; // down
    case "steady":
      return "\u2192"; // right
    case "stalled":
      return "\u2014"; // em dash
    default:
      return "\u00b7"; // middle dot
  }
}

// Format a nullable day-count for display (one decimal, "-" when null).
export function fmtDays(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(1);
}
