---
name: Inventory bucket B/C/D mixed-side double counting
description: Why combined grand totals across Inventory in-house/out-vendor sides are NOT a simple sum of distinct rows.
---

The Inventory page's Buckets B/C/D classify each (project, structure) row into an in-house and/or out-vendor "side" based on the contractors that touched it (`classifyStructureSides` in `lib/inventory.ts`). A structure touched by contractors on both sides is intentionally duplicated onto BOTH side arrays ("mixed"), so it contributes to both the in-house total and the out-vendor total.

**Why:** this is spec-mandated display behavior (each side's table must show every structure it touched), not a bug — but it means a naive sum over distinct raw rows undercounts the true combined grand total by roughly half for any project with a lot of mixed-side structures.

**How to apply:** when validating or reproducing Bucket B/C/D totals outside the UI (e.g. scripting a comparison against a reference export), always replicate `classifyStructureSides` + `splitBySide` and sum `computeBucketSummary` per side, then add the two side totals — never sum the raw joined rows once. Also note: reference/export files may legitimately split a single underlying `order_review_rows` row into multiple display rows for other reasons (e.g. a manually-curated file); don't assume every total mismatch is a code bug — check the raw DB row count first before concluding there's an aggregation bug.
