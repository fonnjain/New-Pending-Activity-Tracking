---
name: Generated OR chain + OR consistency panel
description: Architecture of the new 5-stage Generated OR chain and the OR self-consistency panel added to the Data page.
---

## Generated OR chain (v2, Jul 2026)

Replaces the old 3-stage (L/M/N/S/T/U/V) implementation which used incorrect activity sets.

**Chain computation (per structure, WIP marks only):**
- `genBalRelease`  = sum(isInitialCutting marks) in MT
- `genProgRelease` = `woOrderQtyMt` (from OR file) − `genBalRelease`; falls back to sum(released) if no OR
- `genBalFab`      = sum(released marks with activity in {C,HG,RFI,NH,B,HAB,W,Q,TS})
- `genProgFab`     = `genProgRelease` − `genBalFab`
- `genBalGalv`     = sum(released marks with activity in {G,GB,Y})
- `genProgGalv`    = `genProgFab` − `genBalGalv`
- `fgWt`           = sum(released marks with blank activity = FG Pending)
- `genProgInsp`    = `genProgGalv` − `fgWt`
- `genProgDesp`    = `woOrderQtyMt` − `totalWt` (null if no OR)

**Confidence tiers:**
- Release, Fab: High (works across all projects)
- Galv: Medium
- Insp, Desp: Low (completed marks have left WIP)

**Key behavioral change:** The 5% release filter was REMOVED. All TLT structures with WIP marks are shown. The `isNew` badge (green "NEW <5%") on the project column is now purely cosmetic.

## OR Self-Consistency Panel (`OrderReviewConsistencyPanel`)

Added to `DataViewContent` on the Data tab. Reads from `useGetOrderStatus()`.

**Five identities checked (tolerance ±0.002 MT):**
1. ProgRelease + BalRelease = WO Order Qty (informational — over-release expected)
2. ProgFab + BalFab = ProgRelease
3. ProgGalv + BalGalv = ProgFab
4. ProgInsp implied: checks if `inspectionMt > fileGalvMt` (BalInsp not stored in DB)
5. ProgDesp + BalDesp = ProgInsp

Shows satisfied count, total with data, match rate, and top 3 worst offenders per identity. Also flags negative balance columns (balFabMt, balGalvMt, fileBalReleaseMt, fileBalDespatchMt).

## API change

`inspectionMt` (Progress Inspection MT from OR file col O) added to the `orderStatus` route response and both `OrderStatusRow` schema files.

**Why:** BalInsp is not stored in `order_review_rows` — only `inspection_mt` (ProgInsp) is. Identity 4 therefore can only check whether the implied BalInsp is negative, not whether the file value is self-consistent.

## Balance Work Order column (Aug 2026)

Gen OR col 19 ("Work Order (MT)" under BALANCE) is the OR file's **Balance Work Order (col R, `balWoMt`)** — remaining WO qty — NOT `woOrderQtyMt` (col J). No gen-side figure exists (Despatch removed from this view), so null renders blank, never zero, and totals sum only non-null values. `bal_wo_mt` is a nullable column added via startup `ALTER TABLE IF NOT EXISTS` (ensureOrderReviewColumns); rows ingested before the upgrade stay NULL until the OR file is re-uploaded.

## "New projects only" scope — baseline window, not just first import

The Gen OR view includes only projects whose FULL WIP history was captured. Baseline = every project seen in ANY import dated (report_date, else UTC upload day) on/before 04-Jul-2026 — not just MIN(import_id). The 27–30 Jun uploads were partial captures; projects first appearing then (848, 893, 932, 936, 947, 952) pre-existed in the ERP and reconstruct incompletely. All genuinely-new projects first appear 05-Jul or later. Implemented in the /imports/:id/new-projects endpoint with a MIN(import_id) fallback for fresh DBs.
