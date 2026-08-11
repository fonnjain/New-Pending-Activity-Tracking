---
name: hasTypeData gate pattern
description: Shared helper in dispatch.ts; prevents serving pool-COALESCE fabricated figures from pre-type-column imports on four pages; 19 gated + 23 unaffected imports.
---

## The problem
Imports 5–32 were ingested before `job_card_type`/`job_card_status` were stored in `import_rows`. All rows have NULL there. Queries using `COALESCE(import_rows.job_card_type, record_pool.job_card_type)` fall through to the pool (current state), producing a fabricated snapshot of a date that never existed.

## Shared helper — one definition in dispatch.ts
```typescript
export async function hasTypeData(importId: number): Promise<boolean>
```
Probes `import_rows WHERE import_id = X AND job_card_type IS NOT NULL LIMIT 1`.
**Import it everywhere; never copy this logic inline.**

## Gated vs unaffected imports (as of Aug 2026)
- **19 gated** (no type data): ids 5, 6, 7, 8, 9, 10, 11, 13, 14, 20, 21, 22, 25, 26, 27, 28, 29, 30, 32
- **23 unaffected** (have type data): ids 35, 36, 39–59
- Duplicate ids 12, 15, 37, 38 were already deleted before this work.
- Total import count: **42**

## Gate pattern per route

### releaseBalance.ts
Gate fires after resolving `targetImportId` (default = latest). Returns:
```json
{ "available": false, "hasTypeData": false, "reason": "...", "importId": X, "rows": [], "batchBreakdown": [], "totals": {...} }
```
The pre-computed `release_balance_wip` table still has stale data for old imports, but the route prevents serving it.

### erpRules.ts
Gate fires **before** the `rawRows` query (saves the expensive DB round-trip for gated imports). Returns all 19 rules with `notApplicable: true` and `typeColumnMissing: true`. The old local `typedRowCount > 0` check (which was a false-positive after COALESCE) has been removed.

### fabricationProjectCompletion.ts
Gate fires after `loadLatestWipImport()`. Returns:
```json
{ "available": false, "reason": "...", "rows": [], "totals": ZERO_TOTALS, "unknownCauses": [] }
```

### productionMovement.ts
Gate fires per **pair** — not for the whole request. The approach:
1. Batch-probe all import IDs in one `selectDistinct` query.
2. For each (curr, prev) pair, if either is gated, push a gated day entry instead of computing movement.
3. Gated day: `{ gated: true, gatedReason: "Import #X (date) pre-dates...", cuttingOutputMt: 0, netBalance: {} }`
4. Days still come back in the normal `{ days: [...] }` shape — no shape change.

**Why per-pair, not whole-request:** the target import may be new-format while some predecessors are old. Refusing the whole response would hide valid recent movement pairs.

## Frontend handling
- `NetBalanceMovementPanel`: gated columns render with amber "N/A" sub-label, em-dash cells; explanation row when all columns gated.
- `ReleaseBalanceContent`: specific "Classification data not available" message when `(data as any).hasTypeData === false`.
- `FabCompletionReport`: shows `(data as any).reason` string when `!data.available`.

## What NOT to change
- `record_pool` — current-state store, not historical.
- `backfillReleaseBalanceFromPool` — still runs for all imports; stale data is gated at the route level.
- COALESCE in routes where `hasTypeData` is true — correct for handling individually-null rows within an otherwise good import.
