---
name: Source Column Watch panel
description: Descriptive-only Data Check panel snapshotting watched ERP pass-through columns (bomStatus, isWeldedStructure) per import.
---

# Source Column Watch (Data Check tab)

**Rule:** watched-column distributions are snapshotted at parse time into `imports.summary.sourceColumnWatch`, never computed by joining record_pool.

**Why:** pool rows are shared across imports and their bomStatus/isWeldedStructure values get COALESCE-re-stamped by later files — a live join cannot reconstruct what an earlier file contained, and the previous-import comparison (the panel's whole point) would always diff to nothing.

**How to apply:**
- Watched list = `WATCHED_SOURCE_COLUMNS` in api-server `lib/parse.ts`; append an entry to watch a third column — panel + export render it with no other change.
- Summary key missing ⇒ import predates snapshot ⇒ UI says "not present in this file". `present: false` ⇒ file inspected, column absent. Presence is read from the detected header row (not a data row) so header-only files report correctly.
- It is NOT a DC rule: no pass/fail, never touches the banner/hardRuleFailures. Do not create DC18.
- Values stay raw trimmed strings (Excel booleans arrive as lowercase "true"/"false" text) — never coerce.
- dataCheck route fetches the predecessor summary independently of the hasTypeData gate so the panel works when movement checks are N/A.
- Baseline 16-Aug-2026: BOM Status "Authorized" on all 59,276; Is Welded Structure false 58,922 / 17,643.130 MT, true 354 / 62.352 MT.
