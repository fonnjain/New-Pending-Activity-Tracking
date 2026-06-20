# Balance & Activity Tracker

A mobile-first web app for steel-fabrication workshops. Upload an Excel (.xlsx) balance/activity report and instantly see pending work, live ageing, contractor workload, and activity progress across five views.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/tracker run dev` — run the frontend (use the workflow, not this directly)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind + wouter (artifact `tracker`, served at `/`)
- API: Express 5 (artifact `api-server`, served at `/api`)
- DB: PostgreSQL + Drizzle ORM
- Excel parsing: SheetJS (`xlsx`); uploads via `multer` (memory storage)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` — run codegen after edits
- DB schema (source of truth): `lib/db/src/schema/imports.ts`, `lib/db/src/schema/recordPool.ts`, `lib/db/src/schema/importRows.ts`
- Excel parsing + ageing/route computation: `artifacts/api-server/src/lib/parse.ts`
- Merge/diff engine (change detection between imports): `artifacts/api-server/src/lib/diff.ts`
- Import/record routes (upload, records, changes, compare): `artifacts/api-server/src/routes/imports.ts`
- Frontend pages: `artifacts/tracker/src/pages/` (overview, activity, ageing, contractor, data)
- Overview "Changes since last upload" panel: `artifacts/tracker/src/components/changes-panel.tsx`
- Frontend state (selected import + cascading filters): `artifacts/tracker/src/lib/store.tsx`
- Theme + ageing colors: `artifacts/tracker/src/index.css`

## Architecture decisions

- **Append-only merge.** Each uploaded report = one immutable **import**; imports never replace each other (defaults to showing the newest = current state). Re-uploading is idempotent.
- **Two dedup layers, opposite intent.** WITHIN a file: NO dedup — in-sheet duplicate rows are preserved as separate pending units (tracked via `copies`, expanded in `/imports/{id}/records`). ACROSS uploads: dedup via a permanent `record_pool` keyed by full-row SHA-256 `hash`.
- **Per-import change log.** Each import stores a field-level diff vs the previous import: moved activity, qty/wt changed, new marks, completed. Change identity = `job|structure|markTail|jobCardNo`; a removed identity is flagged **completed**, never deleted. Pool rows are permanent; deleting an import cascades only `import_rows`.
- **Concurrency-safe uploads.** `POST /imports` takes `pg_advisory_xact_lock(728041)` so concurrent uploads serialize against a stable baseline; pool insert uses `onConflictDoNothing(hash)` + re-select.
- `ageingDays` is NOT stored — it is recomputed live (today − Assign Date) at read time, so ageing stays current without re-uploading.
- The parse summary (rowsRead, etc.) and change summary are stored as `jsonb` columns on the import because they cannot be reconstructed from the deduped pool.
- All KPIs, buckets, and breakdowns are computed client-side from the selected import's records with filters applied (AND logic). No separate aggregation endpoints.
- Deterministic self-checks (conservation: added+unchanged===rowsKept; idempotency; non-negative).
- **Optional advisory AI layer (never authoritative).** A bring-your-own-key Anthropic layer adds two read-only assists: sanitize (suggest descriptive-field cleanups) and review (audit computed results). It NEVER writes record_pool/import_rows/computed fields. The key is read server-side only from `ANTHROPIC_API_KEY` (never sent to the browser, never logged). With no key the app works fully: `GET /ai/status` reports `available:false`, AI endpoints return `available:false`, and the UI disables the buttons with the note "Set ANTHROPIC_API_KEY to enable AI assists". Sanitize "Accept all" downloads a cleaned .xlsx (exact parse.ts layout) to re-upload — the engine recomputes; nothing is mutated server-side. Model ids live in `artifacts/api-server/src/lib/ai.ts`; AI routes in `artifacts/api-server/src/routes/ai.ts`; UI in `artifacts/tracker/src/components/ai-review-panel.tsx` and `ai-sanitize-panel.tsx`.

## Parsing rules (parse.ts)

- Reads `Sheet1` (falls back to first sheet); header is on the 3rd row (`range: 2`); reads all 18 columns.
- Forward-fills `Project Code`; normalizes `"794."`→`794`, `"920.0"`→`920`.
- Keeps only rows with a non-empty `Mark No.`.
- `mark_id` = `job\structure\markTail`; `markTail` strips the `"<job> <alias>-"` prefix (not a naive split on first hyphen).
- NO within-file dedup: every kept row becomes a pending unit; a full-row SHA-256 `hash` dedups across uploads only.
- Ageing color scale (used everywhere): green ≤30, amber 31–60, red >60, neutral when no date.

## Product

Five views: Overview (KPIs + "Changes since last upload" panel + ageing breakdown + top aged / busiest contractors), Activity (process-ordered activity cards with expandable mark tables), Ageing (buckets + activity-wise ageing table + full pending table), Contractor (workload bars + contractor×ageing matrix), Data (upload, parse summary, import list with change counts, CSV/JSON export). The Changes panel shows chips + a tabbed table (Moved activity / Qty-Wt changed / New marks / Completed) and a compare-any-two-imports selector. Cascading Job→Structure→Mark filters plus contractor/activity/search apply across all views.

## User preferences

- No emojis anywhere in the UI.

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen` before relying on hooks/schemas.
- After changing DB schema, run `pnpm --filter @workspace/db run push`.
- Tailwind v4: do not `@apply` a custom utility class; use raw CSS properties for things like `font-variant-numeric: tabular-nums`.
- React Query hooks need an explicit `queryKey` in `query` options (e.g. `getGetSnapshotRecordsQueryKey(id)`).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
