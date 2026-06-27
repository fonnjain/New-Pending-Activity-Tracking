---
name: Tracker server-side aggregation parity
description: How the tracker keeps server-computed summaries byte-identical to the old client-side aggregation, and the timezone hazard to avoid.
---

# Server-side aggregation parity (Balance & Activity Tracker)

To speed up the slow data load, record filtering + Overview rollups were moved into a shared lib (`lib/domain/src/aggregate.ts`, re-exported from `@workspace/domain`) so the CLIENT and the api-server run the *same* code. The Overview page calls `POST /imports/{id}/summary` instead of downloading the ~40MB `/records` payload.

## The rule: date windows are calendar DAY-KEYS, not epoch ms
**Why:** the client resolves its date window from *local* "today", but the server parses each row's assign date in the *server's* timezone. Mixing a client-local ms window with server-local date parsing shifts rows by a day at the window edges when client/server timezones differ — breaking the byte-identical invariant.
**How to apply:** the window is passed as `{start,end}` = `YYYYMMDD` integers (inclusive start / exclusive end) via `dateToDayKey(date)` on the client; `filterRecords` compares each row via `assignDayKey(assignDate)` (pure string arithmetic, no Date/TZ). This is byte-identical to the old local-midnight Date comparison because all window boundaries are day-aligned. `parseAssignDateMs` still exists but is for client-local Date helpers only — do NOT use it for window filtering.

## Other parity gotchas
- Any active date window EXCLUDES rows with a blank/unparseable assign date (same as the old client predicate). So a "wide" window can show fewer marks than no-filter — expected, not a regression.
- Category default coercion: `(r.category || "TLT")` — a null-category row counts as TLT; ALL mode skips the category check. Keep this exact when adding pages.
- Velocity items computation is factored into `computeVelocityItems(target, settings)` reused by `/velocity` and `/summary`; keep one implementation so both stay in sync.
- Baseline parity numbers for the only import (id=5): TLT marks 37997, qty 659412, wt 6898619.86, avgAge 30, 39 contractors, 536 structures, ageing 25296/10898/1803; ALL 38163, ageing 25394/10902/1804, noAgeing 63.
