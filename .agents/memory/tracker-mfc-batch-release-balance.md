---
name: MFC batch Release Balance + FG fix
description: Fix for Release Balance Computed and FG (WIP file) showing 0 in batch-grouped views; three-part fix across DB schema, backfill, route, and dashboard.
---

## The Problem
Any view grouping WIP by MFC batch (project-then-mfc mode, MFC batch detail table in JobDetail) showed 0.000 for Release Balance Computed and FG columns. Root cause: `release_balance_wip` table had no `mfc_batch` column (all rows defaulted 'Z'), and FG used JSONB (keyed by raw project, no batch dimension).

## Fix A — DB Schema + Backfill
- Added `mfcBatch: text("mfc_batch").notNull().default("Z")` to `releaseBalanceWipTable`
- New unique index: `release_balance_wip_import_id_project_structure_batch_uq` (was project+structure only)
- `backfillReleaseBalanceFromPool()` now does DELETE-all + full re-insert, grouped by `(import_id, project, structure, COALESCE(mfc_batch,'Z'))` from record_pool — NOT stamping 'Z'
- Boot call in `index.ts` runs it automatically on every restart

## Fix B — FG per batch
- FG (Finished Goods) per batch is already in `p.phases.dispatch.weight` from pool records
- In project-then-mfc mode and in the MFC batch detail table, use `phases.dispatch.weight` directly
- Do NOT use `fgWipForJob()` (JSONB keyed by raw project — no batch dimension, always 0 for batch rows)

## Fix C — Null at source for OR-dimensional columns
- Work Order, Dispatch, Dispatch Balance, FG (Order Review) have no batch dimension
- In batch rows: emit `null` in export and `—` in UI cells (not zero)
- In footer of batch table: same blanking

## API Change
- Added `batchBreakdown` field to `/api/release-balance` response
- Per-(project, mfcBatch) sums, no OR join — used by batch view client
- Schema: `{ project, mfcBatch, releaseBalanceComputedMt }[]`
- Updated in: `openapi.yaml`, `lib/api-zod/.../api.ts`, `lib/api-zod/.../releaseBalanceResponse.ts`, `lib/api-client-react/.../api.schemas.ts`

## Dashboard Changes (job-dashboard.tsx)
- `relBalByProjectBatch`: new memo keyed `"project::mfcBatch"` from `relBalData.batchBreakdown`
- `getRelBalForRow(pJob)`: memoized helper — in project-then-mfc mode splits "911 / Batch A" → raw project + batch; otherwise falls back to `relBalComputedByJob`
- Main table row/footer: use `getRelBalForRow` for Release Balance, `phases.dispatch.weight` for FG in batch mode
- Export: `isBatchRow` flag nulls out WO/Disp/DispBal/FGorReview; uses `phases.dispatch.weight/1000` for FG
- `JobDetail` component: added `relBalByProjectBatch?: Map<string,number>` prop; `byMfc` entries now carry `releaseBalanceMt`; MFC batch table has new Release Balance column header, cells, and footer; dispatch cells show real FG weight; WO/Disp/DispBal cells show `—`

## Composite Package Rebuild Order
After editing generated type files in lib/api-zod or lib/api-client-react, or schema in lib/db:
1. `cd lib/db && pnpm tsc --noEmit false`
2. `cd lib/api-zod && pnpm tsc --noEmit false`
3. `cd lib/api-client-react && pnpm tsc --noEmit false`
Then `cd artifacts/tracker && pnpm tsc --noEmit` to verify.

## Verification
- DB: `release_balance_wip` has 36 (project, mfc_batch) rows for latest import, totalling 2057.398 MT
- Pool vs table: 36/36 OK, 0 mismatches, byte-identical at 2057.398 MT
- API: `batchBreakdown` returns 36 entries

**Why:** The batch dimension was added after the initial project+structure grain. The backfill must DELETE-all (not skip-if-exists) because the default 'Z' on migration means every historical row has wrong batch data.
