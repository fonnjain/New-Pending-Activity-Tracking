---
name: Year-aware relative date presets
description: Month/quarter filter presets must be computed relative to today, not hardcoded to the current calendar year, and must exclude the in-progress period.
---

A date-range filter with quarter presets labeled just "Q1"/"Q2"/"Q3"/"Q4" (no year) and resolved via `new Date(currentYear, ...)` is ambiguous and wrong once the app is used across a year boundary or the user expects "the quarter before now" rather than "whatever quarter of THIS year has that number."

**Why:** A user flagged that "Q1" didn't say which year, and that the fixed Q1–Q4 mapping meant selecting "Q1" while in Q3 silently showed a *future* quarter's window (Jan–Mar of the current year) instead of a meaningful preceding period.

**How to apply:** For any relative month/quarter (or similar period) preset list:
- Encode presets with an explicit year in both the value (e.g. `month:YYYY-MM`, `quarter:YYYY-Q`) and the display label (e.g. "Q2 2026 (Apr–Jun)", "Jun 2026").
- Generate the list dynamically from `new Date()` at render time, walking backward N periods, and exclude the current in-progress period (the list should only contain fully-completed past periods unless the product explicitly wants the current one included).
- Keep the window-resolution logic (e.g. `dateRangeWindow`) in sync with the encoding — parse `YYYY-MM`/`YYYY-Q` out of the code rather than re-deriving from "now" at filter-apply time, so a selected past preset stays stable even as "now" moves forward.
