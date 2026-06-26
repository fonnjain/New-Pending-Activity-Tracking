---
name: Classification / derived-column backfill on the record pool
description: Why adding a new derived column to record_pool needs an explicit backfill, not just a re-upload.
---

# Adding derived/classification columns to record_pool needs an explicit backfill

When you add a NEW derived column to `record_pool` (e.g. the TLT/NTLT `category`,
`ntlt_subtype`, `group_type`, `group_key`, `active` classification fields) it is
computed at parse time for newly-merged rows only. Existing pool rows are NOT
recomputed on re-upload, because the pool insert is `onConflictDoNothing(hash)` and
the merge then skips rows already present (`if (poolIdByHash.has(hash)) continue`).

**Why:** the pool is keyed by the immutable full-row SHA-256 hash; re-uploading the
same file is intentionally idempotent and never updates an existing row. So a column
added after rows were imported stays NULL on all legacy rows forever — in prod that
was ~94k rows, which silently broke the new category view-toggle (a hard
`category === filter` test excluded every legacy row → all-zero KPIs).

**How to apply:**
1. Any view-level filter on a later-added derived column MUST tolerate NULL (legacy)
   rows — e.g. coalesce `category ?? "TLT"` at every filter/group site so legacy data
   keeps its pre-feature visibility instead of vanishing.
2. To actually populate the new column on legacy rows, run an explicit backfill that
   recomputes the value from the STORED raw source columns (these derived fields are a
   pure function of the raw 19 columns + job, none of which are in the hash, so the
   backfill never touches identity/dedup/ageing). Pattern in
   `artifacts/api-server/src/lib/backfill.ts`: fire-and-forget on boot, batched,
   self-draining (only selects rows still NULL whose source qualifies), so it runs
   once and is a no-op on later boots. This auto-heals prod on the next deploy.
