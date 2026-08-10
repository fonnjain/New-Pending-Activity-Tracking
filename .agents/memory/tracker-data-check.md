---
name: Data Check tab (DC0–DC11)
description: DC0 parser fix, /reports/data-check API endpoint, and Data Check tab under Data page.
---

# Data Check tab

## Parser fix (DC0)
- `parse-order-review.ts` line ~525: check `TOTAL_ROW.test(firstText) || TOTAL_ROW.test(rawStructureCell)`.
- The old check only tested `firstText` (first non-empty cell). If the structure cell (Col C) contains "GRAND TOTAL" but another cell comes first, the row was ingested as a structure.

## API route
- `GET /api/reports/data-check` — `artifacts/api-server/src/routes/dataCheck.ts`
- Registered in `routes/index.ts`
- Returns `DataCheckResponse` with hard rules (DC1–DC6), warnings (DC7–DC11), WIP bucket breakdown, and dc0StoredTotalRows.
- OR data from `loadLatestOrderReview()` (latest OR import); WIP from latest import via importRowsTable+recordPoolTable.
- No previous-import comparison — UPSERT schema means prev import rows are gone after re-upload; all `null` for prevViolationCount.

## Column mappings (OR)
- DC1: T = L − M (balFabMt = releaseMt − fabMt), tol 2.5 kg
- DC2: W = O − Q (fileBalDespatchMt = inspectionMt − fileDespatchMt), tol 2.5 kg
- DC3: U = M − N (balGalvMt = fabMt − galvMt), tol 10 kg
- DC4: S = J − L (fileBalReleaseMt = woOrderQtyMt − releaseMt), tol 50 kg
- DC5: L ≥ M (releaseMt ≥ fabMt), tol 1 kg
- DC6: WIP six-bucket partition (same logic as T8 in erpRules) — evaluates ALL marks, not just TLT
- DC7: L > J (released beyond WO)
- DC8: O > N (inspection > galvanising)
- DC9: Q > O (despatch > inspection)
- DC10: N > M (galvanising > fabrication)
- DC11: |N − O| > 0 (derived balance inspection; Col V not stored — "nothing reads Col V")

## Frontend
- Tab registered at `/data-check` in ALL_TABS, TabbedPage, and App.tsx routes/legacy-paths.
- `DataCheckContent` component in `data.tsx` (after MFC batch content, before ERP Rules section).
- Hard rules are expandable: DC1–DC5 show full violations table; DC6 expands to WIP bucket table.
- Warnings are non-expandable single rows (count/totalMt/worstProject/worstStructure/worstMt).
- Export: `exportToXlsxSheets` with 4 sheets: Hard Rules, Warnings, DC6 WIP Buckets, All Violations.

**Why:** Per spec from user — data integrity checks on OR file arithmetic and WIP bucket partition.
