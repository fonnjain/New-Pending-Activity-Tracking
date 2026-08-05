---
name: NTLT stage model
description: Five-stage NTLT chain (Not Started→TS→Galvanising→Y→FG) shared definition in domain; applied to Project Wise, Plant Operation, and export.
---

## The rule

classifyNtltStage() in lib/domain/src/index.ts is the single source of truth.
Five stages: notStarted | ts | galvanising | y | fg

    Not Started  = classifyWipCase returns NOT_RELEASED / CUTTING / AWAITING_ASSIGNMENT
    TS           = IN_PRODUCTION + activity = TS
    Galvanising  = IN_PRODUCTION + activity in {G, GB}
    Y            = IN_PRODUCTION + activity = Y
    FG           = FINISHED_GOODS

**Why:** The Type guard (Col A) is NOT optional. G and TS appear under both JCNS and WIP.
Without the guard ~717 MT lands in the wrong stage. classifyNtltStage is built on
classifyWipCase so the guard is always applied.

## Verified figures (01-Aug import from dev DB, exact match)

| Stage | MT |
|---|---|
| Not Started | 3,895.494 |
| TS | 79.580 |
| Galvanising | 1,132.454 |
| Y | 719.754 |
| FG | 627.319 |
| TOTAL | 6,454.601 |
| Unclassified | 0 |

## Where applied

1. **Domain**: classifyNtltStage() + NTLT_STAGES + NtltStage type — single shared definition
2. **Job Dashboard (Project Wise)**: when isNtlt, renders NTLT_STAGES columns instead of PROCESS_PHASES; ntltStages computed alongside phases in byProject aggregation; Excel export also conditional
3. **Plant Operation**: !isTlt returns <NtltStageOverview records={records}/> — 5 stage tiles + section breakdown table
4. **ERP rules**: placeholder remains; classifyNtltStage is now available for when rules are authored

## Key implementation notes

- Y was previously folded into Galvanising (G+GB+Y). Separating it correctly is the main change.
- NTLT has no Awaiting Assignment split and no fabrication chain beyond TS. 5 stages, not 6.
- Domain rebuild required after any domain change: cd lib/domain && npx tsc --project tsconfig.json (emits .d.ts to dist/)
- Reconciliation warning in job-dashboard is skipped for NTLT (isNtlt guard at top of useMemo).
