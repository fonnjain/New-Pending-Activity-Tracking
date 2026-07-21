---
name: WIP case classification, is_initial_cutting, and Cutting balance correctness
description: The four mutually exclusive WIP cases (Col A x Col G), classifyWipCase() in domain, job_card_status schema column, and the date-filter null-assignDate bug history.
---

## The bug: assignDate null-check in date filter

Two places incorrectly excluded null-assignDate records when a date window was active:

1. `lib/domain/src/aggregate.ts` — `filterRecords` used `if (k === null || k < win.start || k >= win.end)`.  
   Fixed to: `if (k !== null && (k < win.start || k >= win.end))`.  
   Null-assignDate records now always pass the date window filter.

2. `artifacts/tracker/src/pages/job-dashboard.tsx` lines 221-222 — local `dateFrom`/`dateTo` checks had `r.assignDate == null ||` that excluded null-assignDate records.  
   Fixed to: `r.assignDate != null && String(r.assignDate) < dateFrom`.

**Why:** For Activity=C (Cutting), many Authorized marks have no Assign Date yet (pending assignment). The date filter was wrongly treating null assignDate as "outside the window" and excluding them.

## The merge code bug: pre-check skipped existing pool rows

`artifacts/api-server/src/routes/imports.ts` had `if (poolIdByHash.has(hash)) continue;` that prevented `onConflictDoUpdate` from updating `is_initial_cutting` on re-upload. Fixed by removing the pre-check so ALL rows from the current upload go through `INSERT ... ON CONFLICT DO UPDATE`.

**Why:** The `onConflictDoUpdate` comment said it "updates is_initial_cutting on re-upload" but the pre-check made it a no-op for existing rows. Now any re-upload correctly refreshes the flag.

## classifyWipCase() — the canonical classification function

Added to `lib/domain/src/index.ts`. Returns `WipCase` = `NOT_RELEASED | CUTTING | IN_PRODUCTION | FINISHED_GOODS | UNCLASSIFIED`.

Logic (two-path):
1. **When `jobCardStatus != null` (new-format files):** uses Col G directly — no proxies.
2. **Legacy fallback (`jobCardStatus = null`):** uses `isInitialCutting` + activity (structural facts verified: Initial always C, FG always blank activity).

`isActiveCutting()` in `ageing.ts` now delegates to `classifyWipCase(r) === "CUTTING"`. All existing call sites unchanged (they all go through `isActiveCutting()`).

`job_card_status TEXT` column added to `record_pool` schema. Populated by parse.ts from "Job Card Status" (Col G). Null for old-format rows. NOT part of the hash. Enables exact classification on re-upload without proxies.

## The is_initial_cutting DB state issue

A DB reset on 2026-07-21 cleared all `is_initial_cutting` flags to false. Because:
- The pre-check bug prevented re-upload from restoring them
- The original WIP file is no longer in `upload_staging`

A best-effort corrective SQL was run using `release_balance_wip JOIN`:
```sql
UPDATE record_pool rp SET is_initial_cutting = true
WHERE rp.activity = 'C' AND rp.assign_date IS NULL AND rp.contractor IS NULL
  AND rp.job IS NOT NULL AND rp.job != '(Unassigned)'
  AND EXISTS (SELECT 1 FROM release_balance_wip rb WHERE rb.project = rp.job AND rb.structure = rp.structure);
```

**This proxy over-counts by ~2,764 marks** (flags Authorized null-assign marks in the same project+structure as Initial marks). Result: cutting shows ~12,373 marks vs target 15,137.

**Exact target requires re-uploading the WIP file** — with the fixed merge code, `onConflictDoUpdate` will correctly set `is_initial_cutting = true` for real Initial marks.

## What distinguishes Initial from Authorized null-assign marks

- ONLY the "Job Card Status" column ("Initial" vs "Authorized") from the Excel file
- NOT distinguishable by: assign_date, contractor, last_production_date, mfc_batch, work_order_no, order_nature
- The job_card_no has two prefix groups (`0000` and `P000`) but neither cleanly maps to Initial vs Authorized
- The release_balance_wip JOIN proxy over-counts by ~2,764 marks

## Data shapes (import 30, Activity=C)

Total Activity=C marks: 26,590 copies
- With assign_date: 10,894 copies (1,611.919 MT) — definitively Authorized
- Null assign_date: 15,696 copies (3,523.996 MT) — split:
  - Target Initial: 11,453 copies (2,538.863 MT) — proxy flagged 14,217 instead
  - Target Authorized null-assign: 4,243 copies (985.133 MT) — proxy leaves 1,479 instead

Release Balance (from release_balance_wip table): 2,538.863 MT — computed separately from is_initial_cutting, not affected by the DB reset.
