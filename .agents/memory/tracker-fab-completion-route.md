---
name: Fab completion route design
description: Per-mark batch attribution, IS NOT TRUE guard, OpenAPI field coverage for the fabrication-project-completion-tlt endpoint.
---

## Rule
All five pool queries in `fabricationProjectCompletion.ts` (tltStructures, releaseAgg, assignmentAgg, cuttingAgg, fabMidAgg) group by `(job, structure, mfcBatch)`.  No `MAX(mfc_batch)` anywhere.  Cutting query uses `IS NOT TRUE` on `is_initial_cutting` (not `= false`) so newly inserted rows with NULL are included in cutting, not silently omitted.  Release and assignment inline pool queries replace the pre-computed table lookups (`releaseBalanceWipTable`, `assignmentBalanceWipTable`) so figures are import-scoped and batch-accurate by construction.

**Why:**
- One mark with a different batch caused `MAX(mfc_batch)` to shift the entire structure's 657 MT to the wrong batch row (e.g. project 900 / 4QMD3 C→Z).
- `eq(isInitialCutting, false)` silently excluded NULL rows on fresh re-uploads before the boot backfill ran, under-reporting cutting balance.

**OpenAPI:**
`FabricationProjectCompletionRow` and `FabricationProjectCompletionTotals` declare: `mfcBatch` (nullable string), `hgBalanceMt`, `rfiBalanceMt`, `nhBalanceMt`, `bBalanceMt`, `habBalanceMt`, `wBalanceMt` (all double).  Run `pnpm --filter @workspace/api-spec run codegen` after any change to the spec.

## assignment_balance_wip schema
Primary key stays `(project, structure)` — no import_id column.  Reason: the fabricationProjectCompletion route computes assignment balance INLINE from record_pool per (project, structure, mfcBatch) so the pre-computed table is vestigial; adding import_id to the PK causes a non-trivial production migration that Replit's auto-diff handles in the wrong statement order (ADD CONSTRAINT before ADD COLUMN).  Keep this table as latest-import-snapshot only.

## Grand total interpretation
After the copies fix the unfiltered API grand total (all TLT, latest 29-Jul import) is 6,593.950 MT (Release 2,148.912 + Cutting 2,524.695 + Fab-Mid 1,920.343). The export sums whatever rows it renders; with no filter all 161 rows contribute 6,593.950 MT.

## Pre-existing TS errors
`data.tsx` has pre-existing errors: `ErpRulesResponse`, `ErpRuleResult`, `inspectionMt` missing from generated types.  These are not caused by fab-completion changes.  Vite/esbuild transpiles past them; they do not block the build.
