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
- DB schema (source of truth): `lib/db/src/schema/snapshots.ts`, `lib/db/src/schema/records.ts`
- Excel parsing + ageing/route computation: `artifacts/api-server/src/lib/parse.ts`
- Snapshot/record routes: `artifacts/api-server/src/routes/snapshots.ts`
- Frontend pages: `artifacts/tracker/src/pages/` (overview, activity, ageing, contractor, data)
- Frontend state (selected snapshot + cascading filters): `artifacts/tracker/src/lib/store.tsx`
- Theme + ageing colors: `artifacts/tracker/src/index.css`

## Architecture decisions

- One uploaded report = one **snapshot**; its de-duped marks = **records**. The app shows one snapshot at a time (defaults to newest).
- Re-uploading with the same `reportDate` OR `label` replaces the matching snapshot(s); match + delete + insert run in a single transaction.
- `ageingDays` is NOT stored — it is recomputed live (today − Assign Date) at read time, so ageing stays current without re-uploading.
- The parse summary (rowsRead, duplicateMarksCollapsed, etc.) is stored as a `jsonb` column on the snapshot because rowsRead/collapsed cannot be reconstructed from the de-duped records.
- All KPIs, buckets, and breakdowns are computed client-side from the selected snapshot's records with filters applied (AND logic). No separate aggregation endpoints.

## Parsing rules (parse.ts)

- Reads `Sheet1` (falls back to first sheet); header is on the 3rd row (`range: 2`).
- Forward-fills `Project Code`; normalizes `"794."`→`794`, `"920.0"`→`920`.
- Keeps only rows with a non-empty `Mark No.`.
- `mark_id` = `job\structure\markTail`; `markTail` strips the `"<job> <alias>-"` prefix (not a naive split on first hyphen).
- De-dupes to one row per `mark_id`: latest `Assign Date` wins; tie → largest `Balance Qty`.
- Ageing color scale (used everywhere): green ≤30, amber 31–60, red >60, neutral when no date.

## Product

Five views: Overview (KPIs + ageing breakdown + top aged / busiest contractors), Activity (process-ordered activity cards with expandable mark tables), Ageing (buckets + activity-wise ageing table + full pending table), Contractor (workload bars + contractor×ageing matrix), Data (upload, parse summary, snapshot list, CSV/JSON export). Cascading Job→Structure→Mark filters plus contractor/activity/search apply across all views.

## User preferences

- No emojis anywhere in the UI.

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen` before relying on hooks/schemas.
- After changing DB schema, run `pnpm --filter @workspace/db run push`.
- Tailwind v4: do not `@apply` a custom utility class; use raw CSS properties for things like `font-variant-numeric: tabular-nums`.
- React Query hooks need an explicit `queryKey` in `query` options (e.g. `getGetSnapshotRecordsQueryKey(id)`).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
