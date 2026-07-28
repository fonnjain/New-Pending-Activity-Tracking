---
name: FG representations agree
description: The two ways FG weight is stored (record_pool join vs summary jsonb) are equivalent when unit-corrected.
---

## Two FG representations

1. **`record_pool` + `import_rows`**: Join on `import_rows.pool_id = record_pool.id` where `activity IS NULL OR activity = ''`. Import-scoped (use `ir.import_id`). Weight in **kg** (raw `balance_wt`). Divide by 1000 for MT.

2. **`imports.summary->'fgWipByStructure'`**: JSONB frozen at upload time. Structure: `{ project: { structure: weightKg } }`. Stores values in **kg** (NOT MT), despite the `fgWipByStructure` name suggesting MT.

## Verification (Jul 2026 data)

- 368/395 structures match exactly (< 0.001 MT) when both expressed in MT.
- Pool total = 1907.437 MT; jsonb total = 1907.437 MT — byte-identical.
- 8 structures only in pool, 18 only in jsonb: likely `(Unassigned)` project or structures added/removed since upload.

## Which to use

Prefer `record_pool + import_rows` for import-scoped queries (correct for any historical import). The jsonb is frozen at upload and cannot be retroactively corrected if re-upload logic changes; it is only useful for fast aggregate reads when import-scoping is not required.

**Why:** The jsonb stores `balance_wt` values verbatim (kg), not converted to MT. Treat it as kg when reading `fgWipByStructure`.
