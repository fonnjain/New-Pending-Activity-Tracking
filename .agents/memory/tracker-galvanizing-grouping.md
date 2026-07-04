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
column next to Galvanizing (Order Status, Contractor) must keep its Galvanizing
column at **G, GB only** by computing `GALVANIZING − YARD`, never the raw
GALVANIZING bundle — otherwise Y is double-counted in both columns.

**Project Wise exception (PROCESS_PHASES):** the Project-Wise stage table uses
`PROCESS_PHASES`, NOT the activity bundles. Its Galvanising phase now spans
**G, GB, Y** (`PROCESS_SEQUENCE.slice(GALV_START_INDEX)`), and its Ready for
Dispatch column no longer maps to an activity — it reports the Finished Goods
(FG) record field. No double-count risk because dispatch holds no activity code
(processPhase never routes there); the page fills dispatch from `r.fg` directly.
A phase may carry an optional `subLabel` (dispatch = "FG") that overrides the
joined-activity-codes heading; `processPhasesForMode` carries `subLabel` through
so it shows in every mode.

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

**FG placeholder:** `record_pool.fg` is a nullable text column, blank everywhere,
excluded from `hashRow` (19 source cols only), not in any PROCESS_SEQUENCE or
ACTIVITY_BUNDLE, surfaced as nullable `fg` on the /records Record schema. Now
consumed display-only by the Project-Wise Ready for Dispatch column (counts marks
with non-blank `fg`); still blank in all data, so that column reads "-" until FG
data is captured.
