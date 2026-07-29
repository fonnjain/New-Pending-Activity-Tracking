---
name: copies multiplier — systemic
description: record_pool stores each distinct row once; import_rows.copies says how many identical rows appeared in the file. Every aggregate that joins import_rows → record_pool MUST multiply by ir.copies or it under-counts.
---

## Rule
Any query of the form `JOIN import_rows ir ON ir.import_id = ... JOIN record_pool rp ON rp.id = ir.pool_id` that aggregates `rp.balance_wt` or `rp.balance_qty` or counts marks MUST use:
- Weight: `SUM(rp.balance_wt * ir.copies)`
- Qty: `SUM(rp.balance_qty * ir.copies)`
- Mark count: `SUM(ir.copies)`

**Why:**
`record_pool` is hash-deduplicated — one row per unique mark state. `import_rows.copies` records how many identical rows appeared in the source file. Omitting the multiplier produces the DEDUPED total, not the EXPANDED total. The gap for the 29-Jul import was 21.274 MT in cutting, 6.548 MT in release, 6.375 MT in assignment — exact to the milligram once copies is applied.

## Already correct (as of 2026-07-29)
- `contractorMovement.ts` — selects `copies`, uses `(r.balanceWt ?? 0) * (r.copies ?? 1)`
- `dispatch.ts` — same pattern
- `report.ts` — `addToAgg(agg, copies, qty, wt, age)` multiplies throughout
- `diff.ts` — `a.wt += row.balanceWt * copies`
- `aggregate.ts` / `summarizeOverview` — operates on client-expanded records (each row appears copies times before reaching this function)

## Fixed 2026-07-29 (were MISSING the multiplier)
- `fabricationProjectCompletion.ts` — all 4 inline pool aggregations (cutting, fab-mid, release, assignment): `sum(rp.balance_wt * ir.copies)`
- `parseWipReleaseBalance.ts` — `backfillReleaseBalanceFromPool` and `backfillAssignmentBalanceFromPool`
- `productionMovement.ts` — contractor-movement and production-movement routes (added `copies` to SELECT, multiply in all accumulations)
- `inventory.ts` — MFC batch dominance weight accumulation
- `erpRules.ts` — `violatingWeightMt` (added `copies` to PoolRow + SELECT, multiply in reduce)

## File-based parsers (correct, no copies needed)
`parseWipReleaseBalance` / `parseWipAssignmentBalance` — read the raw WIP file row by row; each file row is already one mark (the expansion has already happened at the Excel level). These are correct as-is.

## Verified bucket totals (29-Jul import id=32, TLT)
- Release: 2,148.912 MT (was 2,142.364 before fix — gap 6.548 MT)
- Cutting: 2,524.695 MT (was 2,503.421 before fix — gap 21.274 MT)
- Assignment: 1,077.668 MT (was 1,071.293 before fix — gap 6.375 MT)
All match the source file to the milligram.
