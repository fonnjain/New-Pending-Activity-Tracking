---
name: Contractor Performance (activity-to-activity movement ledger)
description: Daily marks/weight moved between activities, credited to the FROM contractor; full-history replay like Accumulated WIP, not scoped to one import.
---

# Contractor Performance report

Tracks, per day, how many marks (and how much weight) moved from one activity
to the next, crediting the contractor of the FROM (source) activity — the one
who completed and released that stage, not the one who received it.

The report is derived from the full chronological history, not capture-once
milestones. Regressing and later crossing the same activity transition again
is intentionally counted again.

**No TLT-only restriction.** Unlike Accumulated WIP (TLT-only) or Fab Load,
this report intentionally includes every category/project — it's a general
contractor-performance view, not a TLT planning tool.

**Frontend scope:** full history, independent of the currently selected import,
so it honours only filters represented by each movement entry. Excel export
includes contractor detail, overall summary, and stage summary views.

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

## Persisted-read reliability rule

Expensive derived reports may serve persisted results only when a durable
completion marker proves they match the current source snapshot. Missing or
mismatched proof must trigger repair; the presence or absence of result rows is
not proof of freshness.

**Why:** Best-effort rebuilding can fail after a source change has committed.
Trusting old rows (or treating a valid empty result as uninitialized) either
serves stale business figures indefinitely or restores the original page delay.

**How to apply:** Source changes must either certify a completed rebuild or
leave freshness proof invalid so the next read repairs it. Caches over immutable
snapshot windows must be source-versioned and bounded.
