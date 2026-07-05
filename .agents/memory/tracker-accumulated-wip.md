---
name: Accumulated WIP throughput (Fabrication / Galvanizing)
description: Lifetime "each time balance drops at the stage" cumulative counters, distinct from point-in-time balances like dispatch/milestones.
---

# Accumulated WIP throughput

Two cumulative, ever-growing figures (Data page "Accumulated" tab), NOT
point-in-time balances:

- **Fabrication WIP Accumulated** — tonnage added every time a mark's Balance
  Wt, while its identity was last recorded AT `TS`, drops between two
  consecutive WIP imports it appears in — whether it's a partial reduction
  while still sitting at `TS` (some pieces move on) or the identity leaves
  `TS` entirely (moves to a later activity, or disappears from the report),
  which zeroes its remaining `TS` balance. TLT category only.
- **Galvanizing WIP Accumulated** — same shape, keyed off `Y` instead of
  `TS`. No category restriction.

**Definition changed from "transition-only" to "any balance drop at the
stage".** The original design only credited a hard `TS`→`G` transition (or,
for galvanizing, full disappearance from `Y`) between exactly two consecutive
imports. The current design credits ANY decrease in Balance Wt while the
identity's last state was at the stage — including partial completions that
leave the mark still sitting at the same stage with a smaller balance. This
was an explicit user-driven redefinition, not a bug fix; don't revert to the
transition-only version without re-confirming with the user.

**Why "each time" matters:** unlike milestones (capture-once) or dispatch
(seed + accrue against an order book), this feature has no seed/cap concept —
a mark that regresses (reopens) and later has its balance drop again at the
same stage is counted again. This was an explicit user requirement, not an
oversight.

**Engine shape:** mirrors the dispatch engine's "rebuild everything from a
full id-ASC replay" pattern (see `tracker-order-status.md`) rather than
milestones' capture-once-and-preserve pattern — there is nothing to preserve
here, so a full TRUNCATE + reinsert of both the totals table and an
audit-ledger table on every recompute is correct and simplest. No cutoff
support (deliberately, matching dispatch's WIP-history precedent) — these are
lifetime counters from the very first upload.

**Zero fabrication total was legitimate under the old (transition-only)
rule** — verified directly against this project's real upload history at the
time. Under the current (balance-drop) rule, fabrication totals are non-zero
because partial in-place reductions at `TS` are now captured. If a total
looks suspiciously flat again in the future, re-verify against
`import_rows`/`record_pool` before assuming the join/detection logic broke —
don't assume it's automatically a bug either way.

**Route registration gotcha:** the Data page's tab switch (`ADMIN_TABS` in
`data.tsx`) is separate from wouter's route table in `App.tsx` — adding a new
admin sub-tab requires an entry in BOTH, or the tab renders a 404 (the
`Switch`/`Route` in `App.tsx` never matches, so `NotFound` wins) even though
the tab button itself highlights correctly.
