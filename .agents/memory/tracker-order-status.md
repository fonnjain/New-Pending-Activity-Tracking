---
name: Tracker Order Status & Dispatch tracking
description: How the second "Order Review" file is ingested and joined to WIP; dispatch seed-once + ledger accrual; staged-upload dual-file contract.
---

# Order Status & Dispatch tracking (additive overlay)

A SECOND Excel input ("Order Review") sits alongside the WIP balance/activity file. It is
ingested deterministically (no AI gatekeeper) and joined to WIP marks on **Project + Structure**.
Fabrication / Galvanizing / Yard tonnages are computed CLIENT-SIDE from the selected WIP import's
records via ACTIVITY_BUNDLES (so header filters are honoured); Dispatch is server-side.

**Why two file types share one staging flow:** both go through `/imports/stage` → `/imports/commit`.
`detectFileType(buffer)` returns `wip | order-review | unknown`. This forced the staged contract to
become file-type-aware (see below).

## Dispatch = seed-once + ledger accrual (NOT recomputed from the file each time)
- The Order Review file's despatch column seeds `order_dispatch` (pk project+structure) ONCE, the
  first time a key is seen. After that the file value is NOT trusted as the running total.
- Running dispatch accrues from **WIP yard departures**: comparing the last two WIP imports, marks
  that left the Yard bucket append to `dispatch_ledger`. Running total = seed baseline + ledger.
- `recomputeDispatch()` is wired best-effort (try/catch) after every WIP commit, exactly like
  milestones — it can never fail an import.
- File-vs-computed dispatch is cross-checked at **1% tolerance** and surfaced on the Data page
  "Order Reconciliation" tab; mismatches are flagged, never auto-corrected.

## Staged-upload contract is file-type-discriminated (the gotcha)
**Why:** order-review files have no WIP `structural` read and commit produces a different entity,
so the original WIP-only contract crashed on them. The fix:
- `StageResult`: required `fileType` enum; `structural` is **nullable** (null for order-review);
  nullable `orderReview` (OrderReviewStageInfo = asOnDate + summary). UI must render
  `StructuralSummary` ONLY when `structural` is present.
- `/imports/commit` returns a **kind-discriminated `CommitResult`** oneOf (discriminator
  `propertyName: kind`): `{kind:"wip",import,changeSet}` vs `{kind:"order-review",orderReviewImport,seeded}`.
  Both 200 (idempotent replay) and 201 (fresh) point at it. ALL backend commit returns must include
  `kind`. Frontend `onCommitted` discriminates on `kind`.
- Order-review files **skip the AI gatekeeper** (direct commit). Unknown files are rejected with 400
  at commit too (defense-in-depth), not only in the validate UI.
- Order-review commit has its own **atomic race-claim** mirroring WIP's `committed_import_id` pattern:
  `UPDATE ... WHERE committed_order_review_import_id IS NULL RETURNING`; the loser deletes its
  duplicate order_review_imports row + re-runs `recomputeDispatch()`, then replays the winner.

**How to apply:** any new file type added to the staging flow must extend `detectFileType`, the
`StageResult.fileType` enum, and the `CommitResult` union — do not assume a single file shape.
Direct `POST /imports` stays WIP-only (`UploadResult`); the dual-file logic lives in the staged path.
