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
- `TLT` = `PROCESS_SEQUENCE` (12: C,RFI,NH,B,HAB,HG,W,Q,TS,G,GB,Y)
- `NTLT_RSJ` = NTF,NTFSW,NTFW,TS,G,GB,Y (7)
- `NTLT_EARTHING` = TS,G,GB,Y (4)
- `NTLT_GENERAL` = TS,G,GB,Y (4)
- **`Y` is the terminal stage in EVERY sequence.** Final-stage tests use
  `sequence.length - 1`, never a module-level `Y_RANK`.

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
