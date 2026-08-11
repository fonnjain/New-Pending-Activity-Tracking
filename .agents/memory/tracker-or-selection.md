---
name: OR selection by as_on_date
description: loadLatestOrderReview and loadLatestWipImport must sort by date DESC, not id — bulk uploads assign higher ids to older-dated files.
---

## Rule
Both `loadLatestOrderReview()` and `loadLatestWipImport()` in `artifacts/api-server/src/lib/dispatch.ts` must order by:
```
reportDate/asOnDate DESC NULLS LAST, id DESC
```
Never by `id DESC` or `created_at DESC` alone.

**Why:** On 10-Aug-2026 the user bulk-uploaded all historical WIP and OR files. The DB assigned ids in upload order; older-dated files got higher ids. Sorting by id alone gave the wrong "latest".

**How to apply:** Every call site that needs "the current WIP state" must call `loadLatestWipImport()` from dispatch.ts. Every call site that needs "the current Order Review" must call `loadLatestOrderReview()`. Never build a raw `orderBy(desc(importsTable.id)).limit(1)` query for this purpose.

`loadLatestWipImport()` is now used in:
- dispatch.ts (seedDispatchFromOrderReview, loadNewestWipStructureKeys)
- routes: erpRules, releaseBalance, fabricationProjectCompletion, inventory, jobTemplates, dataCheck
- lib: currentJobs

The predecessor/traversal queries (productionMovement, ai, imports changes/movement/velocity) also sort by `reportDate DESC NULLS LAST, id DESC` — keeping id-based WHERE clauses for chain traversal but using date for ordering within the window.

## Knock-on: OR rows are delete-then-insert (one current snapshot per project+structure)
`order_review_rows` has a unique constraint on `(project, structure)`. Each ingest deletes rows whose keys appear in the incoming file, then re-inserts them with the new `importId`. Keys absent from the new file are left in place with their old `importId` and are invisible to all features (every consumer filters `WHERE import_id = latest.id`).

## Row count: file vs DB discrepancy
The DB row count for a given import can be slightly lower than the distinct-structure count in the source file. The confirmed cause is NOT case — the user confirmed their distinct count was already uppercased. The likely cause is the leading-dash strip that the parser applies on the OR side (structures starting with a dash normalise and may collapse onto an existing key). Not a data-loss risk.

## DC7 tolerance
DC7 (`L > J`, release beyond WO) uses a 10 kg tolerance (0.010 MT). Sub-10 kg excess is weight-per-set rounding noise at 3 decimal places (173 structures sit at exactly 1.000 kg over in the 10-Aug file). At 10 kg the rule flags ~49 actionable structures; at 1 kg it flags 316 (mostly noise); at 0 kg it flags 463.

## DC11 dropped
Derived N−O (galv − inspection) ≠ 0 was a normal condition (yard + FG pool), not an anomaly. DC8 already catches the real problem (inspection ahead of galvanising). Col V (Balance Inspection) is not stored in the DB — parser skips index 21.

## Stale-date guard (OR uploads)
The commit route rejects a commit with 409 when the file's `as_on_date` < current newest OR's `as_on_date`. Returns `{ staleDateWarning: true, fileAsOnDate, existingAsOnDate }`. The upload panel intercepts this and shows an amber override banner with "Upload anyway" (posts `forceStaleDate: true`) instead of a generic error toast.
