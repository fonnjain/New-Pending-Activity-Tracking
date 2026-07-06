---
name: Inventory Excel export
description: How the Inventory page's Excel export is structured and how it stays filter-consistent
---

The Inventory page (Buckets A-E) exports one workbook via `exportToXlsxSheets`, one sheet per bucket, each sheet listing In-House then Out-Vendor structure rows plus a summary-rows block (per-side Release Balance / Under Production / Yard / Operation / Grand Total).

**Why:** The existing per-side `computeBucketSummary`/`aggregateProjectColumns` helpers in `lib/inventory.ts` already produce exactly the footer figures shown on-screen, so reusing them for the export keeps the file byte-identical to what the page displays instead of recomputing separately.

**How to apply:** Export must apply the same Job filter as the on-screen buckets (`applyJobFilter` for auto buckets B/C/D, and an equivalent manual-entry filter for A/E) — never export the full unfiltered `rawRows`/`manualA`/`manualE` when a filter is active.
