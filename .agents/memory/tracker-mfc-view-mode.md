---
name: Global MFC view mode
description: Three-mode global toggle controlling how MFC Batch relates to Project across all grouping tables.
---

## The rule
`MfcViewMode` lives in `TrackerContext` (`store.tsx`) alongside filters. It is a **view preference**, not a data filter — never put it in `Filters`. Pages that need it call `const { mfcViewMode, setMfcViewMode } = useTracker()`.

## Modes
- `"project-with-mfc"` (default): Project primary, MFC Batch is a sub-level within it.
- `"view-by-mfc"`: MFC Batch primary within BOM/SubType; Projects nested below each batch.
- `"project-then-mfc"`: Flat combined key `{project}-{mfcBatch}` (single merged column, one fewer dim col).

## Where it applies
1. **Inventory page** (`inventory.tsx`): `AutoBucketPanel` + `PreBucketBPanel` accept `mfcViewMode: MfcViewMode` prop (replaced old `groupByMfc: boolean`). The toggle is a 3-option Segmented near the top of the bucket grid.
2. **Fab Report** (`FabCompletionReport` in `reports.tsx`): Toggle appears in the card header. Uses `buildBomGroupsByMfc()` for `view-by-mfc` mode (BOM→SubType→MFC→Project); `buildBomGroups()` for the other two modes.

## Fab report rendering
- The table IIFE branches on `mfcViewMode` (three `if` blocks, one per mode).
- Shared `numCells()` helper accepts `FabSums | FabricationProjectCompletionRow` — raw rows lack `totalFabBalanceMt` so it falls back to `fabTotal(s)`.
- Column count: `dimCols = isFlat ? 3 : 4`; `totalCols = dimCols + 2 + (specOpsExpanded ? 5 : 3) + 1`.
- MFC-batch subtotals in `view-by-mfc` are shown only when a batch has >1 project.

**Why:** The user wanted a single global toggle so switching mode on the Inventory page simultaneously affects the Fab Report, avoiding two separate controls that could get out of sync.
