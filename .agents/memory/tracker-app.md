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
