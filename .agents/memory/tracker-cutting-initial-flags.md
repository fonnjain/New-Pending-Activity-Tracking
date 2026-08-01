---
name: WIP case classification, is_initial_cutting, and Cutting balance correctness
description: The four mutually exclusive WIP cases (Col A x Col G), classifyWipCase() in domain, job_card_status schema, and the per-import isolation migration.
---

## The WIP case classification

`classifyWipCase()` in `lib/domain/src/index.ts`. Returns `WipCase` = `NOT_RELEASED | CUTTING | IN_PRODUCTION | FINISHED_GOODS | UNCLASSIFIED`.

Logic (two-path):
1. **When `jobCardStatus != null` (new-format files):** uses Col G directly — no proxies.
2. **Legacy fallback (`jobCardStatus = null`):** uses `isInitialCutting` + activity (structural facts: Initial always C, FG always blank activity).

`isActiveCutting()` in `ageing.ts` delegates to `classifyWipCase(r) === "CUTTING"`. All call sites unchanged.

## Schema (post-Aug 2026 migration)

Three classification fields exist at two levels:

**`record_pool` (shared across all imports — global latest state):**
- `is_initial_cutting BOOLEAN NOT NULL DEFAULT false` — pool-level flag; reflects most-recent upload; fallback for pre-migration imports
- `job_card_status TEXT` — Col G value; overwritten by each upload's `onConflictDoUpdate`
- `job_card_type TEXT` — Col A value; same

**`import_rows` (per-import snapshots — isolation layer):**
- `job_card_status TEXT` — NULLABLE; Col G as of THIS import's file upload; null for pre-migration rows
- `job_card_type TEXT` — NULLABLE; Col A as of THIS import; null for pre-migration rows

**Why the per-import layer exists:** `record_pool` rows are shared via hash. When import N+1 uploads the same mark with a different status (INITIAL→AUTHORIZED), `onConflictDoUpdate` overwrites the pool columns, retroactively corrupting views of import N. Storing per-import snapshots prevents this.

## COALESCE pattern (canonical — apply at every SQL query site)

```sql
-- is this mark Initial in THIS import?
COALESCE(upper(ir.job_card_status) = 'INITIAL', rp.is_initial_cutting, false)

-- effective type for this import
COALESCE(ir.job_card_type, rp.job_card_type)

-- effective status for this import
COALESCE(ir.job_card_status, rp.job_card_status)
```

COALESCE null-propagation: `'AUTHORIZED' = 'INITIAL'` = false (non-null) → returns false immediately.
`null = 'INITIAL'` = null → falls through to next arg.

## History: the date-filter null-assignDate bug (fixed)

`lib/domain/src/aggregate.ts` `filterRecords` and `job-dashboard.tsx` incorrectly excluded
null-assignDate records when a date window was active. Fixed to treat null as "always passes".

**Why:** For Activity=C, many Authorized marks have no Assign Date yet (pending assignment).
The filter was wrongly treating null assignDate as "outside the window."

## History: the merge pre-check bug (fixed)

`imports.ts` had `if (poolIdByHash.has(hash)) continue;` that prevented `onConflictDoUpdate`
from running for existing pool rows on re-upload. Removed — now ALL rows go through upsert.

## History: the retroactive-corruption incident (root cause of the per-import migration)

Root cause: `onConflictDoUpdate` unconditionally overwrote `is_initial_cutting`, `job_card_status`,
and `job_card_type` on the shared pool whenever a newer upload touched the same hash.
Effect: 85 marks that changed INITIAL→AUTHORIZED between 31-Jul and 01-Aug showed up as
AUTHORIZED in the 31-Jul view after the 01-Aug upload — 9,518 shown vs 9,603 actual.

Fix: per-import `import_rows.job_card_status` + COALESCE pattern at all query sites.
Verified: after re-upload of 31-Jul and 01-Aug files, 31-Jul shows exactly 9,603 / 2,075.584 MT.

## What distinguishes Initial from Authorized null-assign marks

- ONLY the "Job Card Status" column (Col G) from the Excel file
- NOT distinguishable by: assign_date, contractor, last_production_date, mfc_batch, work_order_no
- The pool-level proxy (activity=C AND assign_date IS NULL AND contractor IS NULL) over-counts
  because some Authorized marks also have null assign_date. Do NOT rely on this proxy for accuracy;
  always use the per-import `ir.job_card_status` when available.

## Boot backfill (still applies to old-format imports)

`backfillInitialCutting()` in `index.ts` — sets `rp.is_initial_cutting = true` for
`activity=C AND assign_date IS NULL AND contractor IS NULL`. Still needed for imports 5–32
(old WIP format, no Type/Status columns) where `ir.job_card_status` is always null. The COALESCE
fallback to `rp.is_initial_cutting` handles those imports correctly.
