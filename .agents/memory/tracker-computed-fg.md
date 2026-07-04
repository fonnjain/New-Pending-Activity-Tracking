---
name: Computed FG + order balances
description: Computed FG (Release - WIP balance - Dispatch) and Order Status release/dispatch balance reconciliation — additive, keyed by (project, structure).
---

# Computed FG + Order Balances

Additive/display-only overlay on the Order Review ("Order Status") file, keyed by
`(project, structure)`. Never touches WIP parsing, ageing, dedup/hash, dispatch,
or milestones.

## Computed FG
- Formula: `FG = Release(col L) − AllActivitiesBalanceWt(WIP) − Dispatch(col Q)`.
- `AllActivitiesBalanceWt` = sum of `balanceWt * copies / 1000` over the **newest
  in-window WIP import** (respects the global WIP valid-from cutoff; null cutoff =
  no-op). Join key is `dispatchKey(job, structure)`.
- Blank inputs count as 0.
- `classifyFg(rawMt)`: `>= 0` → value, flag null; `>= -1MT` (FG_MINOR_FLOOR) →
  clamp to 0 + flag `"minor"`; `< -1MT` → keep raw + flag `"material"`.
- Stored in `computed_fg` table (pk project+structure). `recomputeFg()` rebuilds
  it delete+reinsert (idempotent), driven by the current order book joined to WIP.
- Triggered best-effort (try/catch) after: WIP merge, WIP commit, WIP
  single-delete (`DELETE /imports/:id`), and each Order Review ingest.
  **Not** on delete-all `DELETE /imports` (mirrors dispatch convention there).
- Served by `GET /fg`; UI is the auth-gated "Computed FG" tab on the Data page
  (`/computed-fg`).

## Order balance reconciliation
- Base column for balances is **Col J (WO Order Qty)**, NOT release/despatch.
  - Release Balance = `J − L`; Dispatch Balance = `J − Q`.
- Parser also stores `woOrderQtyMt(J)`, `fileBalReleaseMt(S)`,
  `fileBalDespatchMt(W)` — none are in the WIP hash.
- `crossCheckBalance(rows, tolerancePct=1, absFloorMt=0.05)`: flags when computed
  `J−L` disagrees with file col S, and `J−Q` disagrees with file col W, beyond
  **both** 1% tolerance AND 0.05MT absolute floor. Surfaced on the Data "Order
  Reconciliation" tab.

## Gotcha
- `recomputeFg`/`recomputeDispatch` only fire on upload/delete/ingest. After
  adding the code to an existing repl, `computed_fg` stays empty until the next
  trigger — empty `/fg` rows on a fresh deploy is this, not a bug.
- Backfill without a re-upload: auth-gated `POST /fg/recompute` (hook
  `useRecomputeFg`) runs `recomputeFg()` + `loadComputedFg()` and returns
  `{rows, totalMt}`. Surfaced as the "Recompute FG" button on the Order Status
  page header (shown only when `useGetAuthStatus().authenticated`).
