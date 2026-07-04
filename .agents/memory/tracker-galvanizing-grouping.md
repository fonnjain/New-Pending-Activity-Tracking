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
column next to Galvanizing (Order Status, Contractor; Project Wise uses
PROCESS_PHASES which was left unchanged) must keep its Galvanizing column at
**G, GB only** by computing `GALVANIZING − YARD`, never the raw GALVANIZING
bundle — otherwise Y is double-counted in both columns.

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
ACTIVITY_BUNDLE, surfaced as nullable `fg` on the /records Record schema. Purely
reserved for future use — nothing reads or writes it.
