---
name: Finished Good (FG) figures + order balances
description: The two client-side Finished Good tonnage figures (Overview + WIP) and Order Status release/dispatch balance reconciliation — additive, keyed by (project, structure).
---

# Finished Good figures + Order Balances

Additive/display-only overlay on the Order Review ("Order Status") file, keyed by
`(project, structure)`. Never touches WIP parsing, ageing, dedup/hash, dispatch,
or milestones.

## Finished Good — now two separate figures, both computed client-side
The original server-stored `computed_fg` table + `recomputeFg()`/`GET /fg`/
`POST /fg/recompute` backend feature was removed entirely (schema, routes,
openapi paths, generated hooks). It was flag/clamp-based (`classifyFg`, minor/
material negatives) and mixed the file's Galv column with the WIP balance in one
number, which didn't match what stakeholders actually wanted.

Replaced by two independent, always-defined-by-source figures, computed on the
frontend from data already fetched for other purposes — no new backend state:
- **Finished Good Overview Computed** = file Galvanising (col N, `fileGalvMt`)
  minus file Dispatch (col Q, `fileDespatchMt`). Purely file-sourced, from
  `useGetOrderStatus()`.
- **Finished Good WIP Computed** = live WIP Galvanizing (activities G/GB/Y via
  `bundleActivitySet("GALVANIZING")`, TLT-scoped only) minus file Dispatch.
  Sourced from the selected WIP import's records (`useGetImportRecords`).

Shared hook `artifacts/tracker/src/lib/fg.ts` (`useFgRows`) computes both and is
used identically by the Order Status page's inline table/KPIs and the Data
page's "Computed FG" tab, so the two surfaces can never disagree. Respects only
the global Job filter (not the full Order Status filter set).

**Null vs 0 for the WIP figure**: a structure with WIP presence (any TLT mark)
but zero tonnage specifically in the G/GB/Y bundle should read 0, not n/a; a
structure entirely absent from WIP should read null/n/a. Track presence with a
separate `Set` keyed the same as the sum `Map` — do not infer presence from
`map.has(key)` on the bundle-filtered sum alone, or "0 in bundle" collapses
into "absent from WIP".

## Order balance reconciliation (unchanged)
- Base column for balances is **Col J (WO Order Qty)**, NOT release/despatch.
  - Release Balance = `J − L`; Dispatch Balance = `J − Q`.
- Parser also stores `woOrderQtyMt(J)`, `fileBalReleaseMt(S)`,
  `fileBalDespatchMt(W)` — none are in the WIP hash.
- `crossCheckBalance(rows, tolerancePct=1, absFloorMt=0.05)`: flags when computed
  `J−L` disagrees with file col S, and `J−Q` disagrees with file col W, beyond
  **both** 1% tolerance AND 0.05MT absolute floor. Surfaced on the Data "Order
  Reconciliation" tab.
