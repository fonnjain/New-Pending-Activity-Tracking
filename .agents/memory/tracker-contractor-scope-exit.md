---
name: Contractor scope exit on blank contractor
description: A currently-blank contractor field on a mark means that contractor's work is done and the mark has left contractor scope entirely — apply this retroactively across the whole move history, not just current-state views.
---

The Contractor Performance ledger credits each historical move to whichever contractor was on record right before that move happened, not the mark's current contractor. That's correct for marks still in progress with a contractor, but once a mark's contractor field goes blank in the latest import, the user's rule is: that contractor's work on it is done, and the mark now belongs to VTPL internally — it should stop appearing anywhere in Contractor Performance (summary tables, stage breakdowns, detail log, per-contractor Excel sub-sheets), including its own past moves.

**Why:** Without this, a mark that's now blank/"Unassigned" still showed up under a real contractor's sub-sheet for the moves it made while it had one, which reads as if that mark is still that contractor's active workload — misleading once the mark has actually moved out of scope.

**How to apply:** Determine "currently unassigned" from the mark's state in the LATEST import only (bridging job-card reissues via the existing identity-bridge). If blank there, exclude ALL of that mark's move entries (past and present) from the Contractor Performance ledger before aggregating — do this at the identity level, before grouping/aggregation collapses per-mark identity, since post-aggregation entries no longer carry markId. A mark simply absent from the latest import (e.g. dispatched) is a different, unrelated case and must NOT be excluded by this rule.

Separately, the Contractor Wise page's own Workload table still legitimately shows an "Unassigned Marks" KPI/bucket — that one tracks marks awaiting VTPL action and was intentionally left untouched; only the Contractor Performance ledger (and its embedded copy on the Contractor Wise page) got the exclusion.
