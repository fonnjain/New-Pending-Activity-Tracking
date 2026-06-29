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

## Two independent dispatch figures: File Dispatch vs Computed Dispatch
- **File Dispatch** = `fileDespatchMt`, the despatch tonnage stated in the Order Review file (live latest file value).
- **Computed Dispatch** = `accruedMt` ONLY = WIP yard departures (marks that left the Yard bucket
  between consecutive WIP imports, accrued in `dispatch_ledger`). **The Order Review file/seed NEVER
  contributes to Computed Dispatch** (product decision: file and computed are two independent measures).
- `seedMt` (capture-once baseline from the FIRST Order Review file, stored on `order_dispatch`) is now
  RECORD-ONLY: it still seeds the row + sets `seedImportId`, but it is NOT summed into the
  displayed/reconciled figure. Anywhere that reconciles or displays computed dispatch must use
  `accruedMt` alone, never `seedMt + accruedMt`.
- **Cutoff caveat:** `seedImportId` still gates accrual (`recomputeDispatch` skips departures at/before
  the key's seed import), so Computed = "WIP departures since the order-review baseline," NOT full WIP
  history. Pre-baseline yard departures are excluded by design. If "WIP-only" must mean all-history,
  remove that gate and re-run `recomputeDispatch()`.
- **Why:** the file's despatch column is its own column; computed must be an INDEPENDENT WIP-derived
  measure so reconciliation (file vs computed, 1% tolerance, Data page "Order Reconciliation" tab) is
  meaningful. After this change reconciliation legitimately shows large file-vs-computed gaps until WIP
  catches up — that is expected, not a bug.
- `recomputeDispatch()` is wired best-effort (try/catch) after every WIP commit, exactly like
  milestones — it can never fail an import. The `ledger`/`dispatch_ledger` table is audit-only (still
  written, still holds a seed entry); nothing reads it except the import-delete cleanup.

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
- **Slot-declared expected type.** The Data page has TWO uploaders; each declares an `expectedType`
  (`wip` / `order-review`). The slot — not the file — defines intent. A file whose `detectFileType`
  result differs is rejected with a cross-type "use the other uploader" message. Enforced in THREE
  places: frontend slot gate (no preview/commit on mismatch), `/imports/validate` (early reject),
  and `/imports/commit` (400 — the guarantee that a wrong-slot file can never commit). `expectedType`
  is OPTIONAL on the validate/commit requests, so legacy single-slot callers stay valid.
## `sets` is an integer column — coerce decimals at parse
**Why:** an Order Review export carried a decimal in the sets cell (e.g. "1.122",
usually a misaligned/stray value); the `order_review_rows.sets` column is `integer`,
so the insert threw `invalid input syntax for type integer` and the whole commit
404'd as "Could not ingest the Order Review file". Fix: parse `sets` via a `toInt`
(round) helper, NOT `toNumber`, so every downstream path (seed aggregation, upsert,
diff) gets a whole number. Any new integer-typed order columns need the same care.

## Order Review rows are UPSERTED (idempotent daily snapshot), NOT appended
**Why:** the Order Review file is a daily snapshot of the same order book; appending a fresh row set
per upload duplicated every structure. The intake is now idempotent: ONE current row per
(project, structure) with a DB unique index; each upload upserts in place + writes a per-import
change log (inserted / updated field-level from→to / unchanged / flagged-absent).
- Match key is **case-insensitive on structure** (`project \u0001 structure.toUpperCase()`) but the
  STORED structure preserves case — the WIP join is case-sensitive, so never upper-case the stored value.
- A row's `importId` = the import it was **last seen** in. `notInLatest = row.importId !== latestImportId`
  flags rows absent from the newest file — they are KEPT, never deleted.
- `loadLatestOrderReview()` returns the latest import (for as-on/summary/changeLog) + ALL current rows.

**Concurrency lesson (the trap):** because the upsert mutates SHARED current rows, the old
append-era "ingest-then-race-claim, loser deletes its import" pattern is WRONG — deleting the loser
import leaves shared rows pointing at a dropped import (wrongly `notInLatest`). Fix: serialize the
whole order-review commit under the shared dispatch advisory lock `pg_advisory_xact_lock(728041)`
(same one WIP merge takes) inside one tx, and **re-check the idempotency guard
`committed_order_review_import_id` UNDER the lock** so a duplicate commit replays the winner without
ever ingesting. Any future shared-state UPSERT under a retry-guard must recheck the guard inside the lock.

**How to apply:** any new file type added to the staging flow must extend `detectFileType`, the
`StageResult.fileType` enum, and the `CommitResult` union — do not assume a single file shape.
Direct `POST /imports` stays WIP-only (`UploadResult`); the dual-file logic lives in the staged path.

## Order Review export has a TWO-ROW header (the column-misread gotcha)
**Why:** the file's header is a merged GROUP row ("Order Qty.", "WO Order Qty.", "Progress",
"Balance") over a SUB row ("Sets", "Weight", "Release (MT)", "Despatch (MT)"). A naive single-row
alias matcher detects the group row and substring-matches "set"/"weight" onto the unrelated col E
"Weight / Set (MT)" (per-set), so Sets AND Weight both read the wrong column and totals are tiny.
**How to apply:** resolve columns against COMPOSITE labels = forward-fill the merged group row across
its span, then join group+sub per column; match with include/exclude term-groups. Disambiguations
that MUST hold: Sets/Weight = "Order Qty." block (cols F/G, the total order weight) NOT "WO Order Qty."
nor per-set col E; Release/Despatch = "Progress" block (cols L/Q) NOT the "Balance" block (remaining).
Letter fallbacks C/D/F/G/K/L/Q. After a parser column fix, RE-INGEST the stored file (ingestOrderReview
is idempotent; dispatch seed is capture-once so seeded=0) — old committed rows keep the wrong values.
**Join reality:** WIP `structure` (=alias_corrected) is the best join field (715/2039 OR keys match;
raw alias 647; tower_type 0). "0 everywhere" is usually WIP coverage (one WIP file covered only 56 of
153 OR projects), NOT a join bug.

## Fab/Galv fallback for structures absent from WIP (the standing rule)
**Rule:** when a structure is present in the Order Review file but ABSENT from the WIP report, its
Fabrication & Galvanizing tonnage falls back to the file's Progress block (cols M=Fabrication,
N=Galvanising), instead of reading 0. Yard stays BLANK (the file has no Yard column). In-WIP
structures always keep their live WIP-computed buckets; the file figures are cumulative-done, not
live balances, so file-sourced rows are tagged in the UI.
**Why:** the WIP file only covers a fraction of order-book projects; without this, every order-only
structure read 0 Fab/Galv even though the order sheet records real progress.
**How to apply (the trap):** "absent from WIP" must be CATEGORY-INDEPENDENT. computedByKey is scoped
by the order-type (TLT/NTLT/ALL) mode toggle and in TLT mode ntltKeys is empty, so `!comp` is NOT a
valid absence test — a present structure hidden by the active mode would wrongly trigger the fallback.
Gate the fallback on a separate presence set built from ALL active WIP records (filtered only by
job/structure, never by category). The file's M/N are now persisted on `order_review_rows`
(fab_mt/galv_mt) and summed in collapse/upsert/diff, so the fallback is durable for all future
uploads. After any parser/column change, RE-INGEST the stored file (idempotent).
