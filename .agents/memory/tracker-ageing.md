---
name: Tracker ageing source
description: How ageing is computed in the Balance & Activity Tracker and the rules around blank/future production dates.
---

# Ageing source: Last Production Entry Date (col S)

Ageing = today − **Last Production Entry Date** (col S, the 19th source column), NOT assign date.

- **Rule:** future production dates clamp to today (ageing 0); blank/unparseable → `ageingDays = null`.
- Null-ageing rows are excluded from all numeric buckets and averages, but shown as their own "No ageing date" segment everywhere.
- Null-ageing rows are labelled activity-aware: **"Not started"** when activity == `C` (cutting), else **"No production date"** (progressed past cutting but date missing — data-quality flag). Helper: `artifacts/tracker/src/lib/ageing.ts`.

**Why:** the shop wanted ageing to reflect actual production stall time, not paperwork assign date; and to distinguish "not begun" from "missing data".

**How to apply:** ageing math stays server-side (`computeAgeing` in parse.ts). `lastProductionDate` is part of the row hash, so the first upload after this change shows a one-time re-identification churn (completed + new) vs older imports — not data loss. AI/parse-summary data-quality counts (notStarted/noProductionDate/futureProductionDate) must be weighted by `copies` to match the expanded-row parse summary.
