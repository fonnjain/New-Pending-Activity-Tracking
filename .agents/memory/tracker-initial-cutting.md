---
name: Initial Cutting exclusion
description: isInitialCutting field added to record_pool to exclude pre-release marks from Cutting balance figures
---

## Rule
Marks with `Job Card Status = "Initial"` AND `activity = "C"` must NOT contribute to any
Cutting (C) balance figure. They are already counted as Release Balance (double-count otherwise).

**Why:** These unreleased marks have activity=C in the WIP file but haven't been released to
the shop yet. Counting them in Cutting inflates the fabrication load figures.

## Implementation
- `record_pool.is_initial_cutting boolean NOT NULL DEFAULT false`
- Set in `parse.ts`: `base.isInitialCutting = activityUpper === "C" && jcStatus === "INITIAL"`
  (reads by header name "Job Card Status", NOT column position; NOT hashed; no rowType check needed)
- Returned in record API response (`imports.ts` line ~357 mapping)
- Shared predicate: `isActiveCutting(r)` in `ageing.ts` — `isCutting(r.activity) && !r.isInitialCutting`
- `onConflictDoUpdate` in imports.ts propagates parse-logic fixes on re-upload

## Boot backfill (CRITICAL — col added with DEFAULT false, no re-upload propagates it)
`is_initial_cutting = NOT NULL DEFAULT false` means ALL rows written before the column existed
read `false`. A re-upload using `onConflictDoUpdate` only fixes hash-matched rows on each
specific re-upload. The reliable prod fix is a boot backfill:

`backfill.ts::backfillInitialCutting()` wired in `index.ts` — fires on every boot, self-draining:
```sql
UPDATE record_pool
SET    is_initial_cutting = true
WHERE  upper(trim(activity)) = 'C'
  AND  assign_date is null
  AND  contractor  is null
  AND  is_initial_cutting = false
```
**Proxy is reliable:** ALL Initial marks have no assign_date AND no contractor.
Authorized marks always have a contractor. After one run the WHERE matches zero rows.

## Consumers (ALL use `isActiveCutting` — ONE shared predicate)
1. `ageing.ts` — defines `isActiveCutting(r)` (the canonical predicate)
2. `job-dashboard.tsx` — phase loop uses `isActiveCutting(r)` gate
3. `activity.tsx` — grouping: `if (isCutting(r.activity) && !isActiveCutting(r)) return`
4. `reports.tsx` — `fabLoadMatch()` gate + per-row continue
5. `contractor.tsx` — fab load filter
6. `plant-operation.tsx` — In-Hand load
7. `fabricationProjectCompletion.ts` (server) — SQL: `eq(isInitialCutting, false)`

## NOT changed
- `aggregate.ts::isCuttingActivity()` — used only for "notStarted" ageing label, not balance
- `isCutting()` in `ageing.ts` — activity-string predicate, kept for ageing callers
- Total project weight/marks/qty — Initial marks remain in project totals
- Release Balance / Release Balance Computed — Initial marks contribute to these
- No other activity applies the isInitialCutting filter
