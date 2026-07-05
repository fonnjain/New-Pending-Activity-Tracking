import { compareActivity } from "@workspace/domain";

export type RecordSortKey = "activity" | "ageing" | "contractor" | "structure";

export const RECORD_SORT_OPTIONS: { id: RecordSortKey; name: string }[] = [
  { id: "activity", name: "Activity" },
  { id: "ageing", name: "Ageing" },
  { id: "contractor", name: "Contractor" },
  { id: "structure", name: "Structure" },
];

type SortableRecord = {
  activity?: string | null;
  ageingDays?: number | null;
  contractor?: string | null;
  structure?: string | null;
  mfcBatch?: string | null;
  job?: string | null;
  markId?: string | null;
};

const byStr = (a: unknown, b: unknown) => String(a ?? "").localeCompare(String(b ?? ""));
const byAgeingDesc = (a: SortableRecord, b: SortableRecord) =>
  (b.ageingDays ?? -1) - (a.ageingDays ?? -1);
// Blank MFC batch displays/sorts as "Z" (last), matching the MFC-batch rollup
// convention elsewhere (job-dashboard.tsx `mfcVal`).
const byMfc = (a: SortableRecord, b: SortableRecord) =>
  byStr(a.mfcBatch || "Z", b.mfcBatch || "Z");

export function sortRecords<T extends SortableRecord>(rows: readonly T[], key: RecordSortKey): T[] {
  const arr = [...rows];
  switch (key) {
    case "ageing":
      arr.sort((a, b) => byAgeingDesc(a, b) || byStr(a.markId, b.markId));
      break;
    case "contractor":
      arr.sort(
        (a, b) =>
          byStr(a.contractor, b.contractor) ||
          byMfc(a, b) ||
          byStr(a.structure, b.structure) ||
          byStr(a.markId, b.markId),
      );
      break;
    case "structure":
      arr.sort(
        (a, b) =>
          byMfc(a, b) ||
          byStr(a.structure, b.structure) ||
          byStr(a.markId, b.markId) ||
          byAgeingDesc(a, b),
      );
      break;
    case "activity":
    default:
      arr.sort(
        (a, b) =>
          compareActivity(a.activity, b.activity) ||
          byMfc(a, b) ||
          byStr(a.structure, b.structure) ||
          byStr(a.markId, b.markId),
      );
      break;
  }
  return arr;
}
