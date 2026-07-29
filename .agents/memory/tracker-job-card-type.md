---
name: job_card_type column + ERP Rules tab
description: job_card_type column derivation, backfill rules, ERP Rules tab behaviour for old vs new WIP formats.
---

## job_card_type column

- Nullable text column on `record_pool` (additive; not in the 21-col dedup hash).
- Populated live by `parse.ts` from Col A (the "Type" column in newer WIP exports).
- Three canonical values: `'Job Card Not Started'`, `'Job Card WIP'`, `'FG Pending For Dispatch'`.
- Old WIP files (pre-Col A) parse to NULL; `job_card_status` is also NULL for these.

## backfillJobCardType()

Registered as a boot backfill in `index.ts`. Only touches rows where `job_card_type IS NULL AND job_card_status IS NOT NULL`.
- Status = 'INITIAL' → `'Job Card Not Started'`
- Status = 'Authorized' + blank activity → `'FG Pending For Dispatch'`
- Status = 'Authorized' + activity in C/BL/NTF/NTFSW → `'Job Card Not Started'`
- Status = 'Authorized' + other non-blank activity → `'Job Card WIP'`

**Why:** `onConflictDoNothing` prevents re-upload from updating existing pool rows, so legacy rows need the backfill path. Rows where `job_card_status IS NULL` (entirely old-format WIP) are left as NULL; the domain `classifyWipCase()` falls back to the proxy columns for those.

## ERP Rules tab (`/erp-rules`)

- 17 rules total: 9 Universal (all rows) + 8 TLT-only (Order Nature = "Structure").
- API route: `GET /api/reports/erp-rules` in `routes/erpRules.ts`.
- Pulls all rows for the **latest import** into TypeScript, applies rules in a single pass.
- **typeColumnMissing guard**: if zero rows in the import have `job_card_type != NULL`, the response includes `typeColumnMissing: true` and all rules have `notApplicable: true`. The frontend shows an amber notice and N/A badges instead of false FAILs.
- Types added manually to `lib/api-client-react/src/generated/api.schemas.ts`; rebuilt with `npx tsc -p tsconfig.json` in `lib/api-client-react`.
- Route registered in `App.tsx` under `/erp-rules`; added to `LEGACY_TRACKER_PATHS` list.

## Critical: parse.ts normalises job_card_status to UPPERCASE

`parse.ts` does `jcStatus = cellToString(row["Job Card Status"]).trim().toUpperCase()`, so stored values are `'INITIAL'` and `'AUTHORIZED'` (all caps). Any SQL that compares against `'Authorized'` or `'Initial'` (title case) will match zero rows. Always use uppercase in DB-level SQL comparisons.

## onConflictDoUpdate must include job_card_type + job_card_status

The `imports.ts` pool insert uses `onConflictDoUpdate`. When a new-format WIP file re-encounters an existing pool row (same hash, old file had no Col A/G), `COALESCE(EXCLUDED.job_card_type, record_pool.job_card_type)` must be in the `set` clause or the existing NULL is never overwritten. Without this, ~50% of rows in a "first new-format upload" stay NULL, causing ERP rules to fail and Cutting to show 0.

## Prompt A (Global bucket definitions) — partially applied

- **Release** = JCNS + Initial (unchanged).
- **Assignment** = JCNS + Authorized + blank contractor (added `status='authorized'` check).
- **Cutting** = JCNS + Authorized (was: `activity='C' AND is_initial_cutting=false`).
- `classifyWipCase()` in `lib/domain/src/index.ts` updated to use `jobCardType`/`jobCardStatus` directly when present; falls back to legacy proxy.
- `fabricationProjectCompletion.ts` cutting SQL updated; other routes (project-wise, job-wise, data.tsx direct `isInitialCutting` uses) still use the old predicate — requires audit when a new-format WIP file is available for testing.
