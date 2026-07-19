---
name: Initial Cutting exclusion
description: isInitialCutting field added to record_pool to exclude pre-release marks from Cutting balance figures
---

## Rule
Marks with `Type = "Job Card Not Started"` AND `Job Card Status = "Initial"` (col A + col G in WIP v2) must NOT contribute to any Cutting (C) balance figure. They are already counted as Release Balance (double-count otherwise).

**Why:** These unreleased marks have activity=C in the WIP file but haven't been released to the shop yet. Counting them in Cutting inflates the fabrication load figures.

## Implementation (added 2026-07-19)
- `record_pool.is_initial_cutting boolean NOT NULL DEFAULT false`
- Set in `parse.ts` from `rowType === "JOB CARD NOT STARTED" && jcStatus === "INITIAL"` (NOT hashed)
- Returned in record API response (`imports.ts` mapping)
- Shared predicate: `isActiveCutting(r)` in `ageing.ts`

## Backfill proxy for existing rows
`UPDATE record_pool SET is_initial_cutting = true WHERE UPPER(activity)='C' AND assign_date IS NULL AND contractor IS NULL`
This proxy is reliable: ALL Initial marks have no assign_date AND no contractor; Authorized marks with no assign_date DO have a contractor.

## Consumers updated
1. `fabricationProjectCompletion.ts` — SQL: `eq(isInitialCutting, false)` added
2. `activity.tsx` — grouping skips Initial marks (`if (r.isInitialCutting) return`)
3. `job-dashboard.tsx` — phase loop: `!(key==="cutting" && r.isInitialCutting)`
4. `plant-operation.tsx` — In-Hand load: `act==="C" && !r.isInitialCutting`
5. `reports.tsx` `fabLoadMatch()` — top-level gate: `if (r.isInitialCutting) return false`

## NOT changed
- `aggregate.ts::isCuttingActivity()` — used only for "notStarted" ageing label, not balance
- `isCutting()` in `ageing.ts` — activity-string predicate, kept for ageing callers
- Total project weight/marks/qty — Initial marks remain in project totals (part of overall balance)
