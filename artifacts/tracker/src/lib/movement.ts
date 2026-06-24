import { useMemo } from "react";
import {
  useGetImportMovement,
  getGetImportMovementQueryKey,
} from "@workspace/api-client-react";
import { resolveStalledDays } from "@workspace/domain";
import { useSettings } from "@/lib/settings";

// Identity key matching the backend movement endpoint + diff engine
// (markId + jobCardNo). Used to join movement data back onto records.
export function movementKey(
  markId: string | null | undefined,
  jobCardNo: string | null | undefined,
): string {
  return `${markId ?? ""}\u0001${jobCardNo ?? ""}`;
}

export interface StalledInfo {
  // days-without-movement per identity (null when no usable history)
  daysByKey: Map<string, number | null>;
  // resolved stalled threshold (global setting)
  stalledDays: number;
  // whether the data is usable (endpoint had prior imports to compare against)
  hasHistory: boolean;
  isLoading: boolean;
  // true when this mark has been stalled >= threshold (false when unknown)
  isStalled: (markId: string | null | undefined, jobCardNo: string | null | undefined) => boolean;
  // days since last movement (null when unknown)
  daysFor: (markId: string | null | undefined, jobCardNo: string | null | undefined) => number | null;
}

// Fetch per-mark movement (days since last activity/production-date change) for
// an import and expose a stalled predicate. Degrades gracefully: when there is
// no history (first import) nothing is ever flagged stalled.
export function useStalledInfo(importId: number | null): StalledInfo {
  const { settings } = useSettings();
  const stalledDays = resolveStalledDays(settings);

  const { data, isLoading } = useGetImportMovement(importId as number, {
    query: {
      enabled: importId !== null,
      queryKey: getGetImportMovementQueryKey(importId as number),
    },
  });

  return useMemo(() => {
    const daysByKey = new Map<string, number | null>();
    for (const item of data?.items ?? []) {
      daysByKey.set(
        movementKey(item.markId, item.jobCardNo),
        item.daysSinceLastMovement,
      );
    }
    const hasHistory = data?.hasHistory ?? false;
    const daysFor = (
      markId: string | null | undefined,
      jobCardNo: string | null | undefined,
    ) => daysByKey.get(movementKey(markId, jobCardNo)) ?? null;
    const isStalled = (
      markId: string | null | undefined,
      jobCardNo: string | null | undefined,
    ) => {
      if (!hasHistory) return false;
      const d = daysFor(markId, jobCardNo);
      return d !== null && d >= stalledDays;
    };
    return { daysByKey, stalledDays, hasHistory, isLoading, isStalled, daysFor };
  }, [data, stalledDays, isLoading]);
}
