---
name: WIP critical-column gate + descriptive format check
description: missingCriticalWipColumns blocks all WIP ingest surfaces via wipCriticalGate; checkWipFormat stays descriptive; extra columns harmless
---

Since Aug-2026 there are TWO distinct checks in api-server:

1. **Hard gate — `missingCriticalWipColumns` (parse.ts) via `wipCriticalGate` (routes/imports.ts).** A WIP file missing any of the 10 critical columns (Type, Job Card Status, Order Nature, Balance Wt., Mark No., Alias, Project Code, Activity, Contractor, Batch No.) gets a 400 naming every missing column, at ALL three surfaces: direct `POST /imports`, `POST /imports/stage` (before the staging row is written), and `POST /imports/commit` (before the unknown/type checks). No override. Legacy "WO Batch No." satisfies "Batch No.". Matching is EXACT trimmed case-sensitive — deliberately as strict as the parser, which indexes rows by exact header string.
   - The gate fires on the **structural near-WIP signature** (an exact "Project Code" header cell found by readStructural), NOT the detected type: a WIP with Mark No. stripped misdetects as "order-review" (its header still contains weight/despatch/release/bom tokens), and one missing Activity detects "unknown". Genuine Order Review exports never have an exact "Project Code" column header (only "Project Code : NNN" banners), so they pass through untouched.

2. **Descriptive check — `checkWipFormat`** is now a THREE-TIER classification, not a flat expected list: critical (10, must exist — refusal handled by the gate), known-optional (`KNOWN_WIP_COLUMN_LIST`: 14 originals + all watched columns), unknown (everything else — the ONLY tier that warns / shows Proceed anyway). Known columns absent = informational `optionalAbsent`, never a warning. `missingExpected` now equals `criticalMissing`; no "expected N columns" phrasing anywhere. Watched implies known by construction: `OPTIONAL_WIP_COLUMNS` derives from `WATCHED_SOURCE_COLUMNS`, so watching a new ERP column automatically stops the staging warning too. Adding the next accepted ERP column = one line in KNOWN (or watch it).

**New pass-through columns:** `bom_status` and `is_welded_structure` on record_pool — raw trimmed text (booleans come out as lowercase "true"/"false" via String()), captured at parse time, NOT in the 21-field hash, no logic built on them. The merge upsert COALESCE-stamps shared pool rows when a hash reappears in a file carrying the columns (same pattern as job_card_type); rows never re-seen since stay null.

**How to apply:** any new WIP ingest surface must call `wipCriticalGate` before writing anything; when adding new ERP columns, keep them out of `hashRow` and out of the critical list unless the spec says otherwise.
