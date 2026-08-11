---
name: hasTypeData field on Import
description: How old-ingest vs new-ingest WIP imports are distinguished; guard pattern for bucket-dependent views.
---

## Rule

`GET /imports` now returns `hasTypeData: boolean` on every Import row.

- **false** = import was ingested before `job_card_type`/`job_card_status` were written to `import_rows`. Computed by `EXISTS (SELECT 1 FROM import_rows WHERE import_id = i.id AND job_card_type IS NOT NULL)`.
- **true** = per-row classification data is present; bucket figures are real.

Affected imports as of 2026-08-11: ids 5–11, 13–14, 20–22, 25–30, 32 (19 imports) are false. Ids 35–59 are all true.

## Why

Old-format imports (before the current ingest code) stored NULL for job_card_type in import_rows. Bucket figures (Initial, TS, Galvanising, etc.) for these imports come from `COALESCE(import_rows.jobCardType, pool.jobCardType)` — the pool value was retroactively set by later new-format imports sharing the same hash. These figures look real but are fabricated from the pool, not from the original file's type column.

## Where the field is exposed

- **OpenAPI spec**: `lib/api-spec/openapi.yaml` — added to Import schema, marked required.
- **Generated types**: Updated in `lib/api-zod/src/generated/types/import.ts`, `lib/api-client-react/src/generated/api.schemas.ts`, and both dist `.d.ts` files.
- **API endpoint**: `artifacts/api-server/src/routes/imports.ts` GET /imports — uses a `selectDistinct` query after the main import fetch.

## Frontend guards

1. **Import picker card** (`data.tsx` ~line 517): amber badge "No classification data" when `!s.hasTypeData`.
2. **Parse summary card** (`data.tsx` ~line 381): warning banner rendered above the card when `selectedImport && !selectedImport.hasTypeData`.

## How to apply

- Any page/component that shows WIP bucket figures using the LATEST import should check `imports[0]?.hasTypeData` (imports are ordered by `desc(createdAt)`).
- Any page scoped to a user-selected import should check `selectedImport?.hasTypeData`.
- ERP Rules endpoint already has its own `typeColumnMissing` guard server-side; no additional frontend guard needed there.
