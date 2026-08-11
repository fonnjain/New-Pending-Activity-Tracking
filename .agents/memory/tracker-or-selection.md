---
name: OR selection by as_on_date
description: loadLatestOrderReview must sort by as_on_date DESC, not id — bulk uploads assign higher ids to older-dated files.
---

## Rule
`loadLatestOrderReview()` in `artifacts/api-server/src/lib/dispatch.ts` must order by:
```
as_on_date DESC NULLS LAST, id DESC
```
Never by `id DESC` or `created_at DESC` alone.

**Why:** On 10-Aug-2026 the user bulk-uploaded all historical OR files in a single session. The DB assigned ids 32–52 in upload order, but the dates range from 11-Jul to 10-Aug. The 10-Aug file received id=47; the 28-Jul file received id=52 (highest). Sorting by id gave the 28-Jul file as "latest", which is wrong.

**How to apply:** Any new code path that needs "the current Order Review" must call `loadLatestOrderReview()` rather than building its own query. All three consumers — Data Check, Release Balance, Order Status (Project Wise) — call this shared helper; fixing it once fixes all three.

## Knock-on: OR rows are delete-then-insert (one current snapshot per project+structure)
`order_review_rows` has a unique constraint on `(project, structure)`. Each ingest deletes rows whose keys appear in the incoming file, then re-inserts them with the new `importId`. Keys absent from the new file are left in place with their old `importId` and are invisible to all features (every consumer filters `WHERE import_id = latest.id`).

After fixing the selection, the user must **re-upload the 10-Aug OR file** to restore its rows as the current snapshot. The newly uploaded OR will get a fresh id with `as_on_date = 2026-08-10`, making it the winner going forward.

## Row count: file vs DB discrepancy
The DB row count for a given import can be slightly lower than the distinct-structure count in the source file. The confirmed cause is not case — the user confirmed their distinct count was already uppercased. The likely cause is the leading-dash strip that the parser applies on the OR side (structures that start with a dash are normalised and may collapse onto an existing key). Not a data-loss risk; just a cosmetic count difference.

## DC7 tolerance
DC7 (`L > J`, release beyond WO) uses a 10 kg tolerance (0.010 MT). Sub-10 kg excess is weight-per-set rounding noise at 3 decimal places (173 structures sit at exactly 1.000 kg over in the 10-Aug file). At 10 kg the rule flags ~51 actionable structures; at 1 kg it flags 316 (mostly noise); at 0 kg it flags 463 and means nothing.
