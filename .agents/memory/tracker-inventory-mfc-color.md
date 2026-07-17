---
name: Inventory MFC backfill colour
description: Per-MFC-batch colour (green/white/yellow) on the Inventory page — UI indicator + Excel cell fill on export.
---

## Rule
Each MFC batch on the Inventory bucket list page can have a stored backfill colour (green / white / yellow).  
The colour is shown in the UI as a small coloured dot next to the MFC label and as 3 swatch-picker buttons (auth only).  
On Excel export the colour is applied as the Excel cell background fill for every data row in that MFC batch.

## How it works
- **Storage**: `inventory_mfc_color` table in `lib/db/src/schema/inventoryManual.ts` (PK = `mfcBatch`, `color` text).
- **API**: GET/PUT/DELETE at `/inventory-manual/mfc-colors`; PUT/DELETE require auth.
- **Frontend**: `MfcTopRow` receives `currentColor`, `canEdit`, `onSetColor`, `onClearColor` props; clicking the active swatch calls `onClearColor` (DELETE); clicking another calls `onSetColor` (PUT).
- **Export path**: `projectMfcRows(side, rows, cols, sortMfcFirst, mfcColorMap?)` stamps `_bgColor` (ARGB string) on each aggregated row from `MFC_COLOR_ARGB[colorName]`; `writeSheet` in `export.ts` reads `_bgColor` after `ws.addRow` and applies `cell.fill` — skipping row 1 (header) and summary rows.
- `autoBucketSheet` accepts optional `mfcColorMap` and passes it through to both `projectMfcRows` calls. `handleExport` passes `mfcColorMap` to all 3 `autoBucketSheet` calls and 6 inline `projectMfcRows` calls in the combined sheet.

## Colour mapping
| Name   | CSS     | ARGB (ExcelJS) |
|--------|---------|----------------|
| green  | #92D050 | FF92D050       |
| white  | #FFFFFF | FFFFFFFF       |
| yellow | #FFFF00 | FFFFFF00       |

**Why:** User wanted to colour-code MFC batches in the exported Excel (backfill = cell background). The `_bgColor` approach avoids adding a visible column to the sheet — it's an out-of-band instruction read only by `writeSheet`.
