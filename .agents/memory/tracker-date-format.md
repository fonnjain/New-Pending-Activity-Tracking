---
name: App-wide date display format
description: dd-mm-yyyy is the mandated display format for every user-facing date in the tracker app; use shared helpers, not ad-hoc formatting.
---

All user-facing dates in the Balance & Activity Tracker must render as **dd-mm-yyyy** (e.g. `05-07-2026`), never the raw ISO string or locale-default format.

**Why:** stated as a global user preference/requirement; raw ISO or `Date.toLocaleDateString()` output was inconsistent across pages and didn't match the shop-floor convention.

**How to apply:**
- Use the shared `formatDate` / `formatDateTime` helpers (`artifacts/tracker/src/lib/utils.ts`) for any date rendered in the UI — don't hand-roll `toLocaleDateString()` or template-string date formatting per page.
- `formatDateTime` is for timestamps that also need a time component (e.g. AI report `generatedAt`).
- The one intentional exception: raw ISO date strings used as **export column labels** (e.g. day-of-week columns in a per-day Excel/CSV export) — those are left raw since they're consumed by spreadsheet tooling, not read by a human in the UI chrome.
- When adding a `DateRangeFilter`-style picker (Popover + Calendar), the shadcn `Calendar` component's range `selected` prop is typed as `{ from: Date; to?: Date }` (from is **required**, not optional) — guard with `range.from ? { from: range.from, to: range.to } : undefined` rather than passing a `{from?, to?}` shape directly, or TS2322 will fire.
- `formatDate` is NOT auto-imported everywhere — check each file; if missing, add `import { formatDate } from "@/lib/utils";`.
- Files fixed for raw date renders (Aug 2026): `order-status.tsx`, `reports.tsx` (lastProductionDate cell + fmtMoveDateRpt column headers), `data.tsx` (DayBlock + ERP rules asOnDate), `staged-upload-panel.tsx` (as-on date stat), `inventory.tsx` (Order Review as-on label). `fmtMoveDateRpt` custom formatter in reports.tsx was replaced with `formatDate` — delete it if unused.
