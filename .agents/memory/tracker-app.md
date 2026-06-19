---
name: Balance & Activity Tracker
description: Domain rules and non-obvious decisions for the xlsx-driven tracker app
---

# Balance & Activity Tracker

Mobile-first web app: upload one Excel report -> one "snapshot" with de-duped "records".

## Durable decisions
- **Ageing is computed live at read time, never stored.** `ageingDays = today - Assign Date`.
  **Why:** ageing must stay current without re-uploading; storing it would go stale.
- **Parse summary stored as jsonb on the snapshot.**
  **Why:** rowsRead and duplicateMarksCollapsed cannot be reconstructed from the de-duped records.
- **Re-upload replaces by reportDate OR label.** Both keys are matched independently (OR), and match+delete+insert run in one transaction with `.for("update")`.
  **Why:** spec says same date or label replaces; pre-transaction lookups race.

## Parse rules (artifacts/api-server/src/lib/parse.ts)
- Header on 3rd row (`range: 2`), forward-fill Project Code, normalize "794."->794 / "920.0"->920.
- markTail strips the full `"<job> <alias>-"` prefix, NOT a naive split on first hyphen.
- Dedupe one row per mark_id: latest Assign Date wins, tie -> largest Balance Qty.
- Ageing colors everywhere: green <=30, amber 31-60, red >60, neutral when no date.

## Frontend gotchas
- Tailwind v4: never `@apply` a custom utility class (e.g. tabular-nums) — use the raw CSS property.
- React Query hooks require an explicit `queryKey` in `query` options (e.g. getGetSnapshotRecordsQueryKey(id)).
- Default snapshot selection lives in TrackerProvider (store.tsx): auto-selects newest, recovers if selected is deleted.

## Performance (all client-side aggregation)
- Every view recomputes KPIs/buckets/groupings/sorts from the selected snapshot's records on each render; `useFilteredRecords` filters too. ALL of this MUST stay wrapped in `useMemo` keyed on `[records]` (and `filters`/`search` where relevant), or typing in any search box re-runs full aggregation + re-renders and the browser hangs on large real datasets.
  **Why:** a real uploaded report has thousands of marks; without memoization the app froze ("slow and hanging").
- Large record tables must be bounded. Ageing "Full Pending Work" caps rendered rows at `ROW_CAP` (200) with a "Showing top N of M" notice; search/filters narrow it. If full browsing is needed later, add pagination/virtualization rather than removing the cap.
