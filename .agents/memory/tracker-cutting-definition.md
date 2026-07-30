---
name: Cutting definition — six-bucket split
description: Cutting now requires a contractor; Awaiting Assignment is the peer bucket for no-contractor JCNS+Authorized work.
---

## The rule

**Old (five buckets):**
- Cutting = JCNS + Authorized (regardless of contractor)
- Assignment Balance = subset of Cutting (JCNS + Authorized + blank contractor)

**New (six buckets, Jul 2026):**
- Cutting = JCNS + Authorized + **non-blank contractor**
- Awaiting Assignment = JCNS + Authorized + **blank contractor** (peer bucket, NOT a subset)

Both are disjoint and together partition all JCNS+Authorized work. Both MUST be included in totals — neither is excluded as a "subset".

**Why:** "Cutting" means work actively being cut (contractor on it). Released work with nobody assigned belongs in Awaiting Assignment. The split is total-neutral (Awaiting + new Cutting = old Cutting).

## Single implementation

`classifyWipCase()` in `lib/domain/src/index.ts` is the ONE place that implements this. It returns:
- `"NOT_RELEASED"` — JCNS + Initial
- `"AWAITING_ASSIGNMENT"` — JCNS + Authorized + blank/null contractor
- `"CUTTING"` — JCNS + Authorized + non-blank contractor
- `"IN_PRODUCTION"` — Job Card WIP
- `"FINISHED_GOODS"` — FG Pending For Dispatch

**contractor field**: Pass `contractor` in the record to get the new split. If `contractor` is `undefined` (key absent), falls back to old CUTTING behavior for backwards compatibility.

## Fabrication Report total formula

**New:** Release + Awaiting Assignment + Cutting + HG + RFI + NH + B + HAB + W + Q

**TS is excluded** from the total (shown as a separate column for visibility). Work at TS has finished fabrication and is awaiting test/sign-off.

## Q/TS split

API now returns `qBalanceMt` and `tsBalanceMt` separately instead of `qualityCheckBalanceMt` (Q+TS combined). Both are shown in the Fab Report; only Q is in the total.

## ERP T8

Updated from "five buckets" to "six buckets": Release + Awaiting Assignment + Cutting + QC + Galv + FG = total TLT with zero unclassified.

## Job Dashboard phases

`phases.cutting` in job-dashboard counts BOTH `CUTTING` and `AWAITING_ASSIGNMENT` wipCases — the dashboard column shows pre-production work regardless of contractor status. Zero Cutting for a project is now CORRECT (means no contractor assigned) not a bug.

## Plant Operation INHAND

INHAND load (`passesHoleLoad`) includes both `isActiveCutting(r) || isAwaitingAssignment(r)` — both represent upcoming work to be cut.

## Renaming

"Assignment Balance" renamed to "Awaiting Assignment" everywhere in UI labels (activity.tsx, reports.tsx top section, itemwise group headers).

## Call sites confirmed

All call sites use `classifyWipCase()` or the `isActiveCutting`/`isAwaitingAssignment` helpers from `ageing.ts` that delegate to it. No inline copies of the contractor check.

## Project 821

No regression test for project 821 exists in the codebase — nothing to retire. Under the new definition, project 821 has 0 Cutting (no marks have a contractor) and all its marks are in Awaiting Assignment. This is correct, not a bug.
