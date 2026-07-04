---
name: Tracker MFC batch grouping (col U) + 21-column hash
description: WIP file gained cols T/U; MFC batch is an additive TLT grouping level and the hash grew from 19 to 21 source columns.
---

# MFC batch grouping + 21-column hash

The WIP balance file grew from 19 to 21 columns: **col T "Work Order No."** (stored only, unused) and **col U "WO Batch No." = the MFC batch letter**. `mfcBatch` = trim/upper of col U with **blank → "Z"** so unbatched sorts last (real batches are A..Y, so `localeCompare` puts "Z" last for free).

## Hash grew 19 → 21 columns — hash the RAW batch, not the display value
The hash now includes col T + col U on top of the original 19.
- **Hash the RAW col U** (pre-"Z" substitution, pre-trim/upper). A genuine work-order/batch change IS a real change and SHOULD re-identify a mark; but the blank→"Z" substitution and case/trim normalization are display-only and must stay OUT of the hash, or blank↔"Z" and case differences would spuriously fork identity. Blank stays blank in the hash.
- **Why it matters:** this is the general rule for this app — anything that is a display/normalization transform must never enter `hashRow`; only raw source values do.
- **Expected one-time churn:** the first upload after any hash-column change re-identifies every row once (widespread "completed + new mark"). This is NOT data loss — same class as prior format/identity changes. Warn the user in release comms.
- Legacy pool rows keep the two new columns NULL (`onConflictDoNothing` never updates); the serializer coalesces `mfcBatch ?? "Z"`, so no boot backfill is needed.

## MFC is an additive TLT-only grouping level
For TLT the hierarchy is **Project → MFC → Structure → Mark**, per-project. NTLT is unaffected (stays Section / Sub-category grouped), so all MFC UI is gated behind `!isNtlt`. This is display-only: it never touches parsing, ageing, dedup identity (beyond the intended hash growth), warnings, or load calcs.

**Cascade gotcha:** whenever MFC sits between two existing filter levels, every place that derives downstream option lists (marks/contractors/activities) must ALSO narrow by the selected MFC, not just by job/structure — otherwise the option lists offer values outside the chosen batch and allow empty-result selections.
