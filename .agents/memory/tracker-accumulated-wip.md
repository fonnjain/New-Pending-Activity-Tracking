---
name: Accumulated WIP throughput (Fabrication / Galvanizing)
description: Lifetime "each time it crosses" cumulative counters, distinct from point-in-time balances like dispatch/milestones.
---

# Accumulated WIP throughput

Two cumulative, ever-growing figures (Data page "Accumulated" tab), NOT
point-in-time balances:

- **Fabrication WIP Accumulated** — tonnage added each time a mark's identity
  is observed at `TS` in one WIP import and at `G` in the next WIP import it
  appears in, TLT category only.
- **Galvanizing WIP Accumulated** — tonnage added each time a mark's identity
  is observed at `Y` in one WIP import and is absent from the next.

**Why "each time" matters:** unlike milestones (capture-once) or dispatch
(seed + accrue against an order book), this feature has no seed/cap concept —
a mark that regresses (reopens) and later re-crosses the same boundary is
counted again. This was an explicit user requirement, not an oversight.

**Engine shape:** mirrors the dispatch engine's "rebuild everything from a
full id-ASC replay" pattern (see `tracker-order-status.md`) rather than
milestones' capture-once-and-preserve pattern — there is nothing to preserve
here, so a full TRUNCATE + reinsert of both the totals table and an
audit-ledger table on every recompute is correct and simplest. No cutoff
support (deliberately, matching dispatch's WIP-history precedent) — these are
lifetime counters from the very first upload.

**Zero fabrication total can be legitimate.** Verified directly against this
project's real upload history: no mark identity ever appeared at `TS` in one
WIP import and `G` in the very next import it appeared in, so
`fabricationMt: 0` across every project is a correct reflection of the data,
not a bug — the marks apparently skip past the TS→G boundary between the
sampled upload dates. Don't assume 0 means the join/detection logic is broken;
verify against `import_rows`/`record_pool` directly before "fixing" it.

**Route registration gotcha:** the Data page's tab switch (`ADMIN_TABS` in
`data.tsx`) is separate from wouter's route table in `App.tsx` — adding a new
admin sub-tab requires an entry in BOTH, or the tab renders a 404 (the
`Switch`/`Route` in `App.tsx` never matches, so `NotFound` wins) even though
the tab button itself highlights correctly.
