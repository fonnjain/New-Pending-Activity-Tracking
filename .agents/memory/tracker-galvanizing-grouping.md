---
name: Galvanizing grouping (G, GB, Y) vs separate Yard column
description: How the Galvanizing stage-group spans G,GB,Y while roll-up tables with a separate Yard column stay G,GB, and the hidden-bundle drill pattern.
---

# Galvanizing grouping: stage-group vs Yard-column tables

The GALVANIZING activity bundle spans **G, GB, Y** (it slices `PROCESS_SEQUENCE`
from the G index to the end). This drives the generic "Galvanizing" filter
shortcut and the Plant Operation "Galvanization" tab (which has NO separate Yard
column). The YARD bundle stays `[Y]`.

**Rule:** any roll-up table that shows a SEPARATE Yard / Ready-for-Dispatch (Y)
column next to Galvanizing (e.g. Contractor) must keep its Galvanizing column at
**G, GB only** by computing `GALVANIZING − YARD`, never the raw GALVANIZING
bundle — otherwise Y is double-counted in both columns.

**Order Status exception:** the Order Status page dropped its separate Yard
column (replaced by a "Finished Good" = Computed FG column), so its Galvanizing
column now uses the FULL `GALVANIZING` bundle (G,GB,Y). No double-count because
there is no longer a Y column beside it.

**Project Wise exception (PROCESS_PHASES):** the Project-Wise stage table uses
`PROCESS_PHASES`, NOT the activity bundles. Its Galvanising phase now spans
**G, GB, Y** (`PROCESS_SEQUENCE.slice(GALV_START_INDEX)`).
A phase may carry an optional `subLabel` (dispatch = "FG") that overrides the
joined-activity-codes heading; `processPhasesForMode` carries `subLabel` through
so it shows in every mode.

**Ready for Dispatch (FG) column — currently unwired (2026-07-05):** the
Project-Wise Ready-for-Dispatch/FG column was previously wired to
`useFgRows()` (Finished Good WIP Computed, see `tracker-computed-fg.md`) but
the user asked to stop using that data there; it now always renders a plain
"-" and the Excel export no longer includes it. `useFgRows()` itself and the
Computed FG tab are untouched — only this one column's wiring was reverted.
Before re-wiring this column to any FG/dispatch source, confirm with the user
first (this was an explicit, deliberate rollback, not a bug).

**Why:** product decision — where Y already has its own column/metric it stays
there and is not also folded into Galvanizing. Only single-bucket views (Plant
Op tab) and the generic filter get the wider G,GB,Y grouping.

**Drill-down gotcha:** the activity filter accepts only a single code or a
`bundle:<id>`; there is no multi-code form. A cell whose metric is G,GB cannot
drill via `bundle:GALVANIZING` (now G,GB,Y). Use the **hidden** bundle
`GALVANIZING_CORE` (= [G,GB], `hidden: true`) as the drill target. Hidden bundles
are still resolvable by `getActivityBundle`/`bundleActivitySet` but are excluded
from the activity dropdown (layout.tsx filters `!b.hidden`). Use this same
pattern for any future "drill matches a sub-set of a visible bundle" case.

**Unused FG record field:** `record_pool.fg` is a separate nullable text column,
blank everywhere, excluded from `hashRow` (19 source cols only), not in any
PROCESS_SEQUENCE or ACTIVITY_BUNDLE, surfaced as nullable `fg` on the /records
Record schema. It is NOT what drives the Project-Wise Ready for Dispatch column
(that reads `useFgRows()` — see above); this raw field remains unused/reserved.
