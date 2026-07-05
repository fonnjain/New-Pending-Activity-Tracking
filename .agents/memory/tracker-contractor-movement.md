---
name: Contractor Performance (activity-to-activity movement ledger)
description: Daily marks/weight moved between activities, credited to the FROM contractor; full-history replay like Accumulated WIP, not scoped to one import.
---

# Contractor Performance report

Tracks, per day, how many marks (and how much weight) moved from one activity
to the next, crediting the contractor of the FROM (source) activity — the one
who completed and released that stage, not the one who received it.

**Engine shape:** mirrors `tracker-accumulated-wip.md`'s full id-ASC replay
pattern, not the milestone capture-once pattern — a per-identity `prev` map
walks every import in order, and any activity change between consecutive
imports for the same identity emits a ledger entry (date/project/contractor/
from/to/markCount/weightKg). TRUNCATE + reinsert on every recompute, wired
into the same 4 best-effort call sites as Accumulated WIP and Order Status
(upload, staged commit, delete, settings PUT).

**No TLT-only restriction.** Unlike Accumulated WIP (TLT-only) or Fab Load,
this report intentionally includes every category/project — it's a general
contractor-performance view, not a TLT planning tool.

**Frontend scope:** sourced from a dedicated `GET /contractor-movement`
endpoint (full history, independent of the currently selected import), so it
honours only the global Job filter — there's no single activity/contractor
per entry to filter by since every row IS a from/to pair. Excel export has one
sheet per contractor (Detail) plus Summary + Stage Summary sheets, all via the
shared `exportToXlsxSheets`/`XlsxColumn` helpers (sheet name dedup/sanitize is
already built into that helper — never re-derive it).

**Fabrication/Galvanizing bifurcation is a pure display-layer classification,
not a stored field.** `stageFor(fromActivity)`: leaving `TS` → "Fabrication",
leaving `Y` → "Galvanizing", everything else → no stage. Never add a stage
column to the DB/engine — it's derived at read time from the existing
`fromActivity` on each ledger entry so it can't drift from the underlying
move data. `ContractorPerformanceReport` is exported (not page-local) so it
can be reused verbatim on the Reports page AND the Contractor Wise page,
with local `contractorFilter`/`stageFilter` state driving click-to-filter on
every table inside the component (summary row, stage-totals cell, detail
rows all share the same two filters).
