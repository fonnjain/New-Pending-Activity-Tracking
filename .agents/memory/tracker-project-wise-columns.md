---
name: Project Wise column set — shared definition
description: UI table and Excel export both read src/lib/projectWiseColumns.ts; marks reconciliation rule; export-only columns declared via header notes
---

The Project Wise (job-dashboard) on-screen headers and its Excel export columns are both driven by `artifacts/tracker/src/lib/projectWiseColumns.ts` (leadingColumns / stageColumns / trailingColumns / projectWiseExportColumns / phaseQualifier). They drifted apart once (renames, missing mark counts) — never redefine these labels inline.

**Rules:**
- Every bucket with a two-line "wt / marks" UI header exports as a `<label> <qualifier> Wt (MT)` + `Marks` pair; phase qualifiers come from the mode-scoped headerPhases (subLabel else activities list). FG (WIP file) carries no qualifier by spec.
- Mark reconciliation: six bucket mark columns (Awaiting, Cutting, QC, Galvanising, FG = phases.dispatch.marks, Release Balance = client-side count of classifyWipCase NOT_RELEASED) must sum to Total Marks exactly. Count marks client-side from the same record set as Total Marks, never from the API. In NTLT mode NOT_RELEASED is NOT counted as Release Balance marks (already in NTLT "Not Started" stage — would double count).
- Export-only columns (First Assign, Structures, Balance Qty, ageing buckets) stay grouped last; ageing buckets are labelled "(assigned)" because unassigned marks have no age. Declared via `XlsxColumn.headerNote` (Excel header-cell comment, added in export.ts) — same treatment applied to Bucket List (Structures, Side) and Data Check (Rule, Category/Group, Column/Note) exports.
- Export's first column label = the on-screen primaryLabel ("Project" / "MFC" / "Project / MFC" / "Section" / "Group").

**Why:** spec (Aug 2026) required export/UI parity and self-describing sheets; a third of row marks were unaccounted before the two mark columns were added.
**How to apply:** any new Project Wise column goes into projectWiseColumns.ts with uiLabel + exportLabel + uiVisible; any new export-only column gets a headerNote.
