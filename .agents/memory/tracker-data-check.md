---
name: Data Check tab (DC0–DC12)
description: OR arithmetic hard rules + WIP bucket partition check; DC0 parser fix; DC12 negative-progress warning; route + UI pattern; DC6 has_type_data gate; canonical activity sets in domain.
---

## DC0
Parser fix: TOTAL_ROW_RE strips total-row structures from OR storage. DC0 counts residual stored total rows.

## DC1–DC5: OR arithmetic hard rules
Standard tolerance checks. DC1: BalFab = Release − Fab (2.5 kg). DC2: BalDesp = Insp − Desp (2.5 kg). DC3: BalGalv = Fab − Galv (10 kg). DC4: BalRelease = WO − Release (50 kg rounding). DC5: Release ≥ Fab (1 kg).

## DC6: WIP six-bucket partition

### has_type_data gate (required)
Before evaluating DC6, check whether the WIP import has non-null `job_card_type` in `import_rows`:

```typescript
const wipHasTypeData = latestWip
  ? (await db.select(...).from(importRowsTable)
      .where(and(eq(importRowsTable.importId, latestWip.id),
                 sql`${importRowsTable.jobCardType} IS NOT NULL`))
      .limit(1)).length > 0
  : false;
```

**Why:** Old-format imports (ids 5–32) have 100% NULL `job_card_type` in `import_rows`. Without the gate, COALESCE from pool makes every mark classifiable, reporting a false PASS. The gate makes DC6 refuse to evaluate and return `pass: false` with an explanatory label. Frontend renders amber Info card with "N/A" badge instead of FAIL/PASS.

**When false:** DC6 label reads "NOT EVALUATED. WIP import #N pre-dates per-row job_card_type storage." No WIP bucket totals are computed or shown.

### DC6 query: no COALESCE
The WIP bucket loop reads `importRowsTable.jobCardType` and `importRowsTable.jobCardStatus` directly — never COALESCE from pool. This ensures a NULL type-column row is counted as unclassified (FAIL) rather than silently passing via pool data.

## DC7–DC15: Warnings
DC7 (L > J, release > WO): 10 kg tolerance. DC8 (O > N, insp > galv). DC9 (Q > O, desp > insp). DC10 (N > M, galv > fab). DC15 (any L/M/N/O/Q < 0).
DC11 (N−O ≠ 0) was dropped — a normal condition.

## wipHasTypeData field on DataCheckResponse
Both backend (TypeScript interface) and frontend (data.tsx type) carry `wipHasTypeData: boolean`. The DC6 row passes this via `wipHasTypeData={rule.id === "DC6" ? data.wipHasTypeData : undefined}` to `DcHardRuleRow`.

## Canonical activity sets — single source in domain
`QC_ACTIVITY_SET` and `GALV_ACTIVITY_SET` are exported from `lib/domain/src/index.ts` and derived from `PROCESS_SEQUENCE`:
- `QC_ACTIVITY_SET = new Set(PROCESS_SEQUENCE.slice(1, GALV_START_INDEX))` → HG,RFI,NH,B,HAB,W,Q,TS
- `GALV_ACTIVITY_SET = new Set(PROCESS_SEQUENCE.slice(GALV_START_INDEX))` → G,GB,Y

**Four former local re-definitions removed:**
| File | Old name | New name |
|---|---|---|
| `dataCheck.ts` | `QC_ACTS`, `GALV_ACTS` | `QC_ACTIVITY_SET`, `GALV_ACTIVITY_SET` (imported from domain) |
| `erpRules.ts` | `QC_ACTS`, `GALV_ACTS` | `QC_ACTIVITY_SET`, `GALV_ACTIVITY_SET` (imported from domain) |
| `fabricationProjectCompletion.ts` | `FAB_MID_ACTS as const`, `FabMidAct` | `Array.from(QC_ACTIVITY_SET)`, `string` |
| `data.tsx` | `GEN_FAB_ACTS`, `GEN_GALV_ACTS` | derived: `new Set([PROCESS_SEQUENCE[0], ...QC_ACTIVITY_SET])`, `GALV_ACTIVITY_SET` |

**Note:** `GEN_FAB_ACTS` in data.tsx includes cutting (C) unlike QC_ACTIVITY_SET — it is `C + QC` for the Generated OR chain balance computation.

**After any change to domain exports:** run `cd lib/domain && npx tsc --build` then restart the API server.

## DC6 frontier (import 58 / 10-Aug baseline)
wipHasTypeData = true, pass = true, structuresEvaluated = 58,407 marks, wipTotalMt = 17,043.859 MT.
