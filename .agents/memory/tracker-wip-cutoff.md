---
name: Global WIP valid-from cutoff
description: The design decisions behind the app-wide "valid data starts here" cutoff and why milestones vs dispatch persist differently under it.
---

# Global WIP valid-from cutoff

A single nullable global date in the singleton settings row. When set, the WHOLE
app (client import selection AND every server-side history replay) considers ONLY
WIP imports whose day is on/after it; older imports are ignored as if never
uploaded. Null (default) MUST be byte-identical to before the feature existed.

## Durable rules

- **Byte-identical when null is the invariant.** The cutoff predicate returns
  "no filter" when null, so every `.where(...)` and `and(cond, ...)` call site is
  a true no-op. Any new cutoff gate must preserve this — never change per-record
  parse/ageing/dedup/qty math, only which imports a walk observes.
- **One day definition, enforced in two places (must agree).** An import's day =
  its report date if valid `YYYY-MM-DD`, else the **UTC calendar day** of
  createdAt. The JS helper and the SQL predicate must stay in lockstep, and any
  direct `?from/to` id endpoint (e.g. compare) must reject pre-cutoff ids the
  same way — the client selector already hides them, this makes the server
  authoritative.

- **Milestones vs dispatch persist differently under a cutoff — on purpose.**
  - *Milestones* are capture-once PERMANENT and are recomputed-on-read. Under a
    cutoff, recompute returns window-scoped items (gating stored anchors to
    in-window) but PERSISTS ONLY when cutoff is null, so a scoped view never
    overwrites the permanent earliest-date capture.
  - *Dispatch* is a materialized overlay that Order Status reads STRAIGHT from
    its table (no scoped-recompute-on-read path). So the scoped accrual MUST be
    persisted for the cutoff to affect Order Status. This is safe because accrued
    total + ledger are fully rebuilt from never-deleted WIP history every
    recompute and the only capture-once fields (the order-review seed) are
    preserved — clearing the cutoff restores the full total exactly.
  - **Why it matters:** do NOT "fix" dispatch to skip persistence under a cutoff
    to mirror milestones — that would leave Order Status showing the full
    unscoped total while a cutoff is active, breaking the feature.

- **Date field must be a string, not an OpenAPI `format: date`** — see
  `openapi-date-format-zod.md`, or the value silently nulls on save.
