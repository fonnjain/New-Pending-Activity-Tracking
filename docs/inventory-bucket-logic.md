# Inventory Bucket Board — Logic Reference

Five buckets (A–E) represent the lifecycle of a project's material from order receipt through dispatch. A and E are **manually maintained** by the user; B, C, and D are **auto-computed** from the latest Order Review file.

---

## Data sources

| Bucket | Source |
|--------|--------|
| A | Manual — user types project code + WO Order Qty (MT) |
| B, C, D | Latest Order Review import (`order_review_rows WHERE import_id = newest`) |
| E | Manual — user picks from known projects; app auto-reads their Order Review figures |

Contractor side (In-House / Out-Vendor) for B/C/D is looked up from the newest WIP import's `record_pool`, joined by `(job, structure)` key.

---

## The five buckets

### A — Project to Start

**Label:** "Project to Start"  
**Source:** Manual, free-text entry  
**Meaning:** Brand-new projects not yet in WIP or Order Review.

- User enters project code + WO Order Qty (MT) + side.
- No Order Review data is available, so WO Order Qty is typed manually.
- Summary footer shows a single line: **Under Production Weight** = sum of all A entries' WO Order Qty.
- Persisted in `inventory_manual_a`. Never cleared by a re-upload.

---

### B — Raw Material Incomplete

**Label:** "Raw Material Incomplete"  
**Membership rule:** `fileBalReleaseMt > 0`  
**Meaning:** Release Balance (Order Review Col S) is positive — raw material has not fully arrived.

- Rows with `fileBalReleaseMt IS NULL` are **excluded** and counted separately (shown on the page as a warning count).
- Release Balance is shown **unclamped** (raw value, always > 0 here).
- Columns: **Rel. Bal.** (raw) · **Fab+Galva** (combined) · **Yard**

---

### C — RM Complete, Material Under Production

**Label:** "RM Complete – Material Under Production"  
**Membership rule:** `fileBalReleaseMt <= 0`  
**Meaning:** All raw material has been received (Release Balance zero or negative).

- Rows with `fileBalReleaseMt IS NULL` are **excluded** (same exclusion pool as B).
- Release Balance is shown **clamped** to `max(0, value)` — always 0 in display but never used to re-classify membership.
- Columns: **Rel. Bal.** (clamped, always 0) · **Fab** · **Galva** · **Yard**

> B and C are **mutually exclusive** — they partition on the sign of `fileBalReleaseMt`. A structure is in exactly one of them (or neither if null).

---

### D — Dispatch Clearance Received, Production Not Complete

**Label:** "Dispatch Clearance Recd But Production Not Complete"  
**Membership rule:** `inspectionMt > 0`  
**Meaning:** Dispatch clearance weight is positive — customer has cleared it for dispatch, but fabrication is still running.

- Rows with `inspectionMt IS NULL` are **excluded** and counted separately.
- D is **independent** of B and C. A structure can be in both B+D or C+D simultaneously — no deduplication.
- Columns: **Rel. Bal.** (clamped) · **Fab** · **Galva** · **Yard**

---

### E — Material Ready But Not Dispatched

**Label:** "Material Ready But Not Dispatched"  
**Source:** Manual — user picks from the known-projects dropdown  
**Meaning:** Material is complete and waiting for dispatch but the project has not yet disappeared from WIP.

- User picks a project code (from the latest Order Review's known list) + side.
- The app reads **all** structures for that project from the latest Order Review and aggregates: Release Balance (clamped), Fab+Galva, Yard.
- Persisted in `inventory_manual_e`. Never cleared by a re-upload.

---

## In-House / Out-Vendor side classification

Every B/C/D structure is placed on the **In-House** side, the **Out-Vendor** side, or **both** (if mixed). Buckets A and E are assigned by the user at entry time.

**Resolution order for each contractor on a structure (B/C/D):**

1. **Hardcoded overrides** (applied before any DB lookup):
   - In-House: `UNIT-I`, `UNIT-II`, `DUMMY CONTRACTOR`, `NO CONTRACTOR`
   - Out-Vendor: `DASHMESH ENTERPRISES GP-2`, `OUT FAB`, `S .R . BROTHERS & CO.`
2. **`contractor_categories` table lookup** (normalised name key, case/space-insensitive):
   - `CNC` or `SUB_CONTRACTOR` → In-House
   - `OUT_VENDOR` → Out-Vendor
3. **Default:** In-House (unmatched / unclassified)

A structure is **mixed** when its contractors (from the latest WIP import) resolve to both sides. Mixed structures appear on **both** sides, each row badged `(mixed)` — never picked by precedence.

> **Why the per-side totals do not add up to one combined total:** a mixed structure contributes its weight to both sides. The combined "grand total" is the sum of both side totals, which counts mixed structures twice. This is by design.

---

## Summary footer (per side, all buckets)

Every bucket's side panel shows a 5-line spec-mandated footer:

| Line | Formula |
|------|---------|
| Total Release Balance | `sum(releaseBalance)` — raw for B; clamped `max(0,x)` for C/D/E |
| Under Production | `sum(Fab + Galva)` — null cell contributes 0 |
| Total Yard | `sum(Yard / Progress Galvanising)` |
| Operation Weight | Under Production + Total Yard |
| Grand Total Weight | Total Release Balance + Operation Weight |

---

## Column definitions by bucket

| Bucket | Release Balance | Fab | Galva | Fab+Galva | Yard |
|--------|----------------|-----|-------|-----------|------|
| B | raw (unclamped) | — | — | combined | yes |
| C | clamped (=0) | separate | separate | — | yes |
| D | clamped | separate | separate | — | yes |
| E | clamped (aggregated) | — | — | combined | yes |

---

## Null handling

- `fileBalReleaseMt IS NULL` → excluded from B and C; counted as `excludedNullReleaseCount` on the page.
- `inspectionMt IS NULL` → excluded from D; counted as `excludedNullInspectionCount`.
- A null cell in any numeric column renders as `–` in the UI.
- When summing across structures: null contributes 0 (a column only renders `–` if every contributing row is null).

---

## Filters

- The **global Job filter** (All Projects / single project / Current Jobs) applies to B, C, D, and E.
- Within a bucket, a **project checkbox list** provides a secondary refinement on top of the Job filter.
- Bucket A is not filtered by Job (it is fully manual and has no WIP/OR data to filter against).

---

## Persistence

| Table | Managed by | Cleared on re-upload? |
|-------|------------|----------------------|
| `inventory_manual_a` | User via UI (auth-gated) | No |
| `inventory_manual_e` | User via UI (auth-gated) | No |
| `order_review_rows` | Order Review upload | Upserted (idempotent) |

Buckets B/C/D are derived entirely at read time from the latest Order Review data — no intermediate table is ever written for them.
