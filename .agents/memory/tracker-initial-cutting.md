---
name: Initial Cutting exclusion
description: Per-import job_card_status in import_rows prevents retroactive corruption of is_initial_cutting across imports
---

## Rule
Marks with `Job Card Status = "Initial"` must NOT contribute to any Cutting (C) balance figure.
They are already counted as Release Balance (double-count otherwise).

**Why:** These unreleased marks have activity=C in the WIP file but haven't been released to
the shop yet. Counting them in Cutting inflates the fabrication load figures.

## Architecture (post-migration, Aug 2026)

**The retroactive-corruption problem:** `record_pool` rows are shared across all imports.
`onConflictDoUpdate` was unconditionally overwriting `is_initial_cutting` (and `job_card_status`,
`job_card_type`) whenever a later import touched the same hash. An 01-Aug upload retroactively
corrupted the 31-Jul view for 85 marks that changed status INITIAL→AUTHORIZED between the two dates.

**The fix:** `job_card_status` and `job_card_type` are now stored **per-import** in `import_rows`:
- `import_rows.job_card_status` — per-import snapshot of Col G ("INITIAL" | "AUTHORIZED" | null)
- `import_rows.job_card_type` — per-import snapshot of Col A ("Job Card Not Started" | ... | null)

Both columns are NULL for imports uploaded before the migration (pre-Aug 2026). Those fall back
to the pool-level `rp.is_initial_cutting` flag via COALESCE.

## COALESCE pattern used at all query sites

```sql
-- Boolean: is this mark Initial IN THIS import?
COALESCE(upper(ir.job_card_status) = 'INITIAL', rp.is_initial_cutting, false)

-- Text: effective job_card_type for this import
COALESCE(ir.job_card_type, rp.job_card_type)

-- Text: effective job_card_status for this import  
COALESCE(ir.job_card_status, rp.job_card_status)
```

**How COALESCE handles the cases:**
- `ir.job_card_status = 'INITIAL'` → true (this import says Initial)
- `ir.job_card_status = 'AUTHORIZED'` → false (this import says Authorized — non-null, returns false)
- `ir.job_card_status = null` (pre-migration import) → falls through to `rp.is_initial_cutting`
- both null → false

## Files that apply this pattern

All query sites replaced pool-level references with the COALESCE expression:
1. `artifacts/api-server/src/routes/imports.ts` — `serializeRecord` (returned in records API)
2. `artifacts/api-server/src/lib/parseWipReleaseBalance.ts` — `backfillReleaseBalanceFromPool` + `backfillAssignmentBalanceFromPool`
3. `artifacts/api-server/src/routes/productionMovement.ts` — mark-rows select
4. `artifacts/api-server/src/routes/fabricationProjectCompletion.ts` — four query sites (Cutting/Release/Assignment balance)
5. `artifacts/api-server/src/routes/erpRules.ts` — rawRows select

## Pool-level flag kept as fallback

`record_pool.is_initial_cutting` and `record_pool.job_card_status` / `record_pool.job_card_type`
are **retained** — they serve as fallback for pre-migration imports that have no `ir.job_card_status`.
The `onConflictDoUpdate` still writes them (reflects most-recent-upload state only; correct for
the latest import even without the per-import column).

## Boot backfill (still needed for very old imports)

`backfillInitialCutting()` in `index.ts` — fires on every boot, sets `is_initial_cutting = true`
for pool rows where `activity=C AND assign_date IS NULL AND contractor IS NULL`. Remains accurate
for old-format imports (pre-Type/Status columns) where `ir.job_card_status` is always null.

## Consumers on the frontend (unchanged — read `isInitialCutting` from records API)

`serializeRecord` now computes `isInitialCutting` from the COALESCE expression, so the frontend
receives the correct per-import value. `classifyWipCase()` in domain reads `jobCardStatus` directly
(already correct; no change needed).

## Verified figures after migration (import 37 = 31-Jul-2026)

Release Balance: **9,603 marks / 2,075.584 MT** — matches user's independent count exactly.
Delta vs 01-Aug (import 38): 85 INITIAL→AUTHORIZED transitions correctly isolated per-import.
