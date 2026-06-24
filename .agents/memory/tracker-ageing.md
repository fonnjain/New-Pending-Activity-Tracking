---
name: Tracker ageing source
description: How ageing is computed in the Balance & Activity Tracker and the rules around blank/future dates and the activity-C special case.
---

# Ageing source: per-activity date basis

Ageing = today − a **resolved** date (whole UTC days), recomputed live, never cached.

- **Activity "C" (Cutting) ages from Assign Date.** A C mark has not begun production, so it has NO Last Production Entry Date — age from Assign Date (how long it has waited to be cut since assignment). C rows therefore get a real ageing number and participate normally in buckets, averages, pre-warning/breach status, and velocity.
- **Every other activity ages from Last Production Entry Date** (col S, the 19th source column).
- **Resolution helper:** `resolveAgeingDate(activity, assignDate, lastProductionDate)` then `computeAgeing(activity, assignDate, lastProductionDate)` (both in `parse.ts`). All ageing call sites pass these three args.
- **Future chosen date → clamps to today (ageing 0); blank → null.**

**Critical non-rule:** do NOT extend the Assign-Date fallback to non-C rows with a blank production date (a small set at NTF/G/NTFSW/TS/BL). They stay `ageingDays = null`, labelled **"No production date"**, excluded from numeric averages/buckets, and flagged. A started mark with no production date is a genuine data gap to surface, not to paper over. Null-ageing C rows (only when Assign Date is also blank) are labelled **"Not started"**.

**Why:** the shop wanted ageing to reflect real waiting/stall time and to distinguish "not begun" from "missing data". C marks have 100% Assign-Date coverage but no production date, so before this they showed "Not started" with no number — Assign-Date ageing surfaces how long they have queued for cutting.

**How to apply:** ageing math stays server-side. The frontend derives `notStarted`/`noProductionDate` from `ageingDays === null` + `isCutting`, so it adapts automatically once the server populates C ageing. `lastProductionDate` is part of the row hash; Assign Date is also stored/displayed and is the date-range filter key. AI/parse-summary data-quality counts (notStarted/noProductionDate/futureProductionDate) use the resolved date and are weighted by `copies`.
