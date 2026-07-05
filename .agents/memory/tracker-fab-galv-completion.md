---
name: Live-balance completion vs moves-log stage
description: Fabrication/Galvanizing "complete" status (live zero balance) is a separate concept from the existing moves-log stage-completion counts on the Contractor Performance report — don't conflate them.
---

The Contractor Performance report (`reports.tsx`, shared by the Reports page and Contractor Wise page) has two different, additive notions of "fabrication/galvanizing done" that must not be merged into one column or one bundle definition:

1. **Moves-log stage completion** (pre-existing): counts a move that *leaves* activity `TS` (fabrication done for that mark) or *leaves* activity `Y` (galvanizing done), sourced from the historical activity-to-activity movement ledger.
2. **Live-balance completion status** (added later): a snapshot check against the *currently selected import* — Fabrication is "Complete" for a contractor when its balance weight is zero summed across activities `C..Q` (explicitly **excluding `TS`**, per the literal spec); Galvanizing is "Complete" when balance weight at `GB` specifically is zero (not the full `G,GB,Y` GALVANIZING bundle).

**Why:** the two "Fabrication" activity sets used elsewhere in this codebase (`FAB_SET` in `contractor.tsx`, which includes `TS`, used for a load-split table) do NOT match the set required for this completion check. Different consumers legitimately want different bundle boundaries around the same activity names — silently reusing an existing constant would produce a wrong answer that still looks plausible.

**How to apply:** when adding a new "is X done" check, always re-derive the activity set from the actual spec wording (inclusive/exclusive of boundary activities like `TS`/`GB`/`Y`) rather than reusing a same-named constant defined for a different table/purpose. Name the new set distinctly (e.g. `FAB_COMPLETION_SET`, `GALV_COMPLETION_ACTIVITY`) so future edits don't accidentally widen/narrow an unrelated consumer.
