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

## Knock-on: OR rows are UPSERTed (one current snapshot)
`order_review_rows` has a unique constraint on `(project, structure)`. Each ingest UPSERTs rows with the new `importId`. If OR files are ingested in id order (oldest→newest), the final `order_review_rows` state reflects the last-ingested file (highest id), not the latest by date.

After fixing the selection, the user must **re-upload the 10-Aug OR file** to restore its rows as the current snapshot. The newly uploaded OR will get a fresh id with `as_on_date = 2026-08-10`, making it the winner going forward.
