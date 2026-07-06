---
name: Current Jobs filter rollout gap
description: How a new global filter-mode sentinel (e.g. "Current Jobs") must be threaded through every page, not just the shared filter hook.
---

When a project adds a new global filter *mode* (as opposed to a new filter *value* within an existing mode) — e.g. a "Current Jobs" set-membership option added to the existing single-value Job dropdown — the shared resolver (`resolveActiveFilters` / `useFilteredRecords` in `store.tsx`) only covers pages that call it. Any page that reads `filters.job` directly (bypassing the shared hook) will silently treat the new sentinel value as a literal, unmatched job code and show empty/wrong data instead of erroring.

**Why:** this class of bug is invisible in typecheck and in a cursory manual test of the "main" pages, because it only manifests on pages with bespoke filtering logic (e.g. a page with its own aggregation needs that predates the shared hook).

**How to apply:** whenever adding a new sentinel/mode to a global filter, grep the whole frontend for every direct read of the filter field (not just the intended call sites) and confirm each one branches on the sentinel the same way the shared hook does, before considering the feature complete.
