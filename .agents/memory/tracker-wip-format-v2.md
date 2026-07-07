---
name: WIP file format v2 (Jul 2026)
description: Newer WIP exports have a different column layout; MFC batch column header was renamed.
---

From approximately July 2026, VTPL WIP exports changed column layout from 21 cols to 24 cols:
- New leading "Type" column (col A) — previously there was no type column
- "Job Card Date" (col F) and "Job Card Status" (col G) inserted after "Job Card No."
- "WO Batch No." (old col U) renamed to **"Batch No."** (new col X)

The parser reads by header name, not column position, so the positional shift is automatically handled. The only code change required was a two-name fallback for the MFC batch column:
- `row["WO Batch No."] ?? row["Batch No."]` — handles both old and new files
- `missingColumns` check also accepts "Batch No." as satisfying the "WO Batch No." expectation

**Why:** without this fallback, `rawBatch` resolves to null for every row in a new-format file, so `mfcBatch` is always "Z" (the blank fallback), making MFC batches B, C, D, etc. disappear entirely from the UI.

**How to apply:** if a future file format change renames or moves other columns, remember the parser reads by header name — adding a `?? row["NewName"]` fallback is the correct minimal fix for renamed headers. Positional shifts alone (new columns inserted) require no change.
