---
name: Contractor Performance tabs + filter scope
description: Which global filters a ledger-derived report card can honor vs a records-derived one, and why the Contractor Performance card uses tabs.
---

# Contractor Performance card: tabs + filter parity boundary

The `ContractorPerformanceReport` component (shared by the Reports page and
embedded on the Contractor Wise page) mixes two different data sources with
different filterability:

- **Movement ledger** (`GET /contractor-movement`, `ContractorMovementEntry`)
  only carries `date, project, contractor, fromActivity, toActivity,
  markCount, weightKg`. It can only ever honor global filters that map onto
  those fields: Job, Contractor (name or category via the contractor-category
  overlay), Activity (plain or bundle, matched against either side of a
  move), Date range, and Search. MFC/Structure/Mark/Section/NTLT
  sub-type/Hole Operation have no equivalent column and must NOT be silently
  ignored — document the gap in a code comment so it reads as intentional.
- **Live-balance completion status** (Fab/Galv "remaining" columns) is
  derived from full `Record[]` for the selected import, which DOES have every
  field. Route it through the shared `useFilteredRecords()` hook instead of
  a manual `filters.job`-only loop, so it gets full global-filter parity for
  free and stays consistent with every other per-record view in the app.

**Why:** a report card that silently drops most global filters looks broken
to users who expect the header filter bar to work everywhere; the fix is to
apply every filter the data can actually answer and be explicit (comment +
description text) about the few that structurally can't apply to
ledger-shaped data.

**UI decision:** stacking Summary matrix / Fab-Galv stage table / Detail log
vertically in one long card was replaced with `Tabs`/`TabsList`/`TabsTrigger`/
`TabsContent` (`@/components/ui/tabs`), one tab per section. Drill-down state
(`contractorFilter`/`stageFilter` set by clicking a row) is surfaced as a
"Drill-down filter" chip row above the tabs (not inside a single section) so
switching tabs doesn't lose the context of what's currently drilled into.
