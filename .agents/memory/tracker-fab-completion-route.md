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

## assignment_balance_wip schema (Fix C)
Primary key is `(import_id, project, structure)` — NOT `(project, structure)`.  `import_id` is a NOT NULL FK to `imports.id` ON DELETE CASCADE.  `recomputeAssignmentBalance(buffer, importId)` scoped-deletes only that import's rows.  `backfillAssignmentBalanceFromPool()` skips imports that already have rows (idempotent).  Both boot-level (index.ts) and per-import call sites use `importId`.

## Grand total interpretation
The unfiltered API grand total (all TLT, latest import) is ~6,566 MT.  The user's on-screen totals are always smaller because a job-set filter is active.  The export sums whatever rows it renders — the filtered total and the API unfiltered total are both correct; they are not the same number.

## Pre-existing TS errors
`data.tsx` has pre-existing errors: `ErpRulesResponse`, `ErpRuleResult`, `inspectionMt` missing from generated types.  These are not caused by fab-completion changes.  Vite/esbuild transpiles past them; they do not block the build.
