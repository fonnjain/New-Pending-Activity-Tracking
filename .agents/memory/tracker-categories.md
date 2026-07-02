---
name: Tracker TLT/NTLT category sequences
description: Per-category process sequences (TLT vs NTLT) in @workspace/domain and how they wire through parse/server/frontend.
---

# Per-category sequences (TLT vs NTLT)

The tracker historically had ONE 12-step process sequence (`PROCESS_SEQUENCE`).
Marks actually belong to different fabrication routes, so the engine is now
sequence-aware. This is **additive**: TLT == the old `PROCESS_SEQUENCE` verbatim,
and every sequence-aware fn defaults `sequence = PROCESS_SEQUENCE`, so all
existing TLT call sites are byte-for-byte unchanged.

## Sequences (`SEQUENCES` map in `@workspace/domain`)
- `TLT` = `PROCESS_SEQUENCE` (12: **C,HG,RFI,NH,B,HAB,W,Q,TS,G,GB,Y**). HG (Grinding)
  sits at index 1 (right after C, before RFI) — grinding/finishing on the cut piece
  before inspection. (It was historically at index 5, between HAB and W.)
- `NTLT_RSJ` = NTF,NTFSW,NTFW,TS,G,GB,Y (7)
- `NTLT_EARTHING` = TS,G,GB,Y (4)
- `NTLT_GENERAL` = TS,G,GB,Y (4)
- **`Y` is the terminal stage in EVERY sequence.** Final-stage tests use
  `sequence.length - 1`, never a module-level `Y_RANK`.

## Slice-anchored bundles must key off the ACTIVITY, not a magic index
`TLT_FAB_PENDING_QUALITY` = "fabrication minus cutting prep" = RFI..TS. It is sliced
`PROCESS_SEQUENCE.slice(indexOf("RFI"), indexOf("G"))` — **NOT `slice(1, ...)`**.
`slice(1)` used to equal RFI because RFI was at index 1, but HG now occupies index 1,
so a positional slice would silently pull HG into Fab-Pending.
**Why:** relocating an activity inside `PROCESS_SEQUENCE` changes every index, so any
bundle/phase that slices by a hard index (rather than `indexOf(code)`) breaks meaning
without a type error. `TLT_STANDARD_OPERATIONS` = literal `[C,HG,RFI,NH]` (membership
set, order-independent). Fabrication load hole columns key off `Activity==RFI/==C`, and
Welded/Bending In-Hand off `rank < W_RANK/B_RANK` — all re-derive; parity held because
0 marks ever sit AT activity HG (so Bending's now-included HG adds nothing).
**How to apply:** when moving any code in `PROCESS_SEQUENCE`, grep every `slice(<int>,`
and confirm each still means the intended activity; prefer `indexOf(code)` anchors.

## Why per-row sequence matters
NTLT-only steps (NTF/NTFSW/NTFW) are UNKNOWN to the TLT route, so TLT's
`activityRank` ranks them AFTER `Y`. Any "is this before Y?" test done with the
TLT sequence would wrongly treat an RSJ mark sitting at NTF as "past Y / done".
**Always resolve the row's own sequence** via `sequenceFor({category, ntltSubtype})`
before classifying. The milestone Ready-block bug class lives here
(`blocksReady()` in `milestones.ts`).

## Classification source
`classifyMark()` in parse.ts sets `category`/`ntltSubtype`/`groupType`/
`groupKey`/`active` from Order Nature (Structure→TLT; RSJ POLE→NTLT/RSJ;
EARTHING/GENERAL→NTLT/...; FOUNDATION BOLT→active=false). These five fields are
**NOT in `hashRow`** (still 19 source cols only) — classification never changes
identity/dedup/ageing.

## Degradation
NTLT activities missing from `settings` fall back to `DEFAULT_ACTIVITY_CONFIG`
(idealDays 3) until per-category config is added in a later phase.

## Process phases (coarse 4-stage roll-up)
`PROCESS_PHASES` + `processPhase(activity)` group the fine activities into the
four stages the workshop reports against: **Cutting** (C), **Quality Check**
(RFI..Q,TS), **Galvanising** (G,GB), **Ready for Dispatch** (Y). TS (last fab
step) lives in Quality Check, NOT Galvanising — the galv boundary is
`indexOf("G")` for BOTH `GALV_START_INDEX` (phases) and `BUNDLE_GALV_START_INDEX`
(bundles). Used by the
Job-wise "By Project/Section" table (marks + balance wt per phase) instead of the
old structures/qty columns.

**Why:** the shop reports progress by these named stages, not raw activity codes.

**How to apply:** TLT bands are SLICED from `PROCESS_SEQUENCE` (never hardcode the
literals — single source, can't drift). NTLT-only pre-`TS` fab codes
(NTF/NTFSW/NTFW, computed from `SEQUENCES`) roll into Quality Check so NTLT/ALL
views don't drop marks; `processPhase` returns null ONLY for genuinely unknown
codes. Display/roll-up only — never touches parsing/qty/ageing/dedup.
