# Balance & Activity Tracker

A mobile-first web app for steel-fabrication workshops. Upload an Excel (.xlsx or legacy .xls) balance/activity report and instantly see pending work, live ageing, contractor workload, and activity progress across five views.

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
- **Optional advisory AI layer (never authoritative).** A bring-your-own-key Anthropic layer adds two read-only assists: sanitize (suggest descriptive-field cleanups) and review (audit computed results). It NEVER writes record_pool/import_rows/computed fields. **Sanitize is formatting-only for name fields:** a cleanup is dropped server-side (and `req.log.warn`'d) unless `from`/`to` share the same alphanumeric token sequence (lowercase, runs of non-alnum collapsed to one space, trim) — so whitespace/punctuation-spacing/casing fixes pass but suffix truncation/merges (e.g. "DASHMESH ENTERPRISES GP-2" -> "DASHMESH ENTERPRISES") are blocked. Enforced via `isTruncatingCleanup` (parse.ts) at all three paths (`/imports/validate`, `/imports/commit`, `/ai/sanitize`); `assignDate` is exempt (date normalization changes tokens). Both Claude prompts also forbid removing suffixes/units/branches/parentheticals/hyphenated tags. The key is read server-side only from `ANTHROPIC_API_KEY` (never sent to the browser, never logged). With no key the app works fully: `GET /ai/status` reports `available:false`, AI endpoints return `available:false`, and the UI disables the buttons with the note "Set ANTHROPIC_API_KEY to enable AI assists". Sanitize "Accept all" downloads a cleaned .xlsx (exact parse.ts layout) to re-upload — the engine recomputes; nothing is mutated server-side. Model ids live in `artifacts/api-server/src/lib/ai.ts`; AI routes in `artifacts/api-server/src/routes/ai.ts`; UI in `artifacts/tracker/src/components/ai-review-panel.tsx` and `ai-sanitize-panel.tsx`.

## Parsing rules (parse.ts)

- Reads `Sheet1` (falls back to first sheet); reads all 18 columns.
- **Header row auto-detected:** scans the first ~10 rows for the one containing `Project Code`; data starts on the next row. Falls back to the 3rd row (historical layout) with a problem note if not found.
- **Conditional `Project Code` forward-fill.** A blank Project Code is only a "continuation of the structure group above" for rows whose `Order Nature` is `Structure` (case-insensitive) — those inherit the last seen project. Project-less item types (`RSJ POLE` / `EARTHING` / `GENERAL`) and rows with a blank/unknown Order Nature have a genuinely empty project and must NOT borrow one from an adjacent row; they are stored under `job = "(Unassigned)"` (a constant in parse.ts) so the existing UI groups/filters them as their own selectable group without dashboard changes. A leading Structure row seen before any project code also falls through to `(Unassigned)` rather than a silent empty job. `(Unassigned)` is excluded from `projectsFound`. For these rows the value fed to mark derivation is empty, so their `markId`/`markNumber` stays the bare m_no (e.g. `"1"`) and never embeds a borrowed job. Since `job` participates in the row hash, rows previously mis-attributed will re-hash once and show as an attribution correction in the next diff (expected). Normalizes `"794."`→`794`, `"920.0"`→`920`.
- Keeps only rows with a non-empty `Mark No.`.
- **Mark No. → 4 derived fields (check backslash FIRST):** (1) `794\T1\M101` → split on `\`: projectSuffix/aliasCorrected/mNo; (2) `794 T1-M101` → strip `"<job> <alias>-"` prefix: aliasCorrected=alias, mNo=tail; (3) plain/fallback → whole value (minus leading `"<job> "`) is mNo, aliasCorrected falls back to `Alias`. `markNumber` = `job\aliasCorrected\mNo`.
- Legacy fields are aliases: `structure`=aliasCorrected, `markTail`=mNo, `markId`=markNumber. Change-log identity = `markId|jobCardNo`.
- `hash` is SHA-256 over the **original 18 source columns ONLY** (derived mark fields excluded), so cleanups that touch derived fields don't change identity.
- NO within-file dedup: every kept row becomes a pending unit; the `hash` dedups across uploads only.
- Ageing color scale (used everywhere): green ≤30, amber 31–60, red >60, neutral when no date.

## Upload: direct vs staged gatekeeper flow

- **Direct:** `POST /imports` parses, merges, and commits in one step (no gate). Still available.
- **Staged (gatekeeper):** `POST /imports/stage` holds the raw file in `upload_staging` (bytea) and returns a structural read; `POST /imports/validate` runs the Claude gatekeeper (verdict `ok`/`reject` + descriptive-only sanitize suggestions, `available:false` when no key); `POST /imports/commit` applies accepted `(field,from)→to` cleanups over the staged rows, re-hashes, then merges. `DELETE /imports/stage/{id}` discards. **Nothing is written to `record_pool`/`import_rows`/`imports` until commit.**
- Both paths share `mergeImport()` in `routes/imports.ts`. Accepted cleanups are remapped onto the base 18 source fields BEFORE hashing; mark identity is untouched. The gatekeeper is advisory only — it never mutates computed fields; the engine stays authoritative. UI is `staged-upload-panel.tsx` (wired into the Data view).

## Product

Five views: Overview (KPIs + "Changes since last upload" panel + ageing breakdown + top aged / busiest contractors), Activity (process-ordered activity cards with expandable mark tables), Ageing (buckets + activity-wise ageing table + full pending table), Contractor (workload bars + contractor×ageing matrix), Data (upload, parse summary, import list with change counts, CSV/JSON export). The Changes panel shows chips + a tabbed table (Moved activity / Qty-Wt changed / New marks / Completed) and a compare-any-two-imports selector. Cascading Job→Structure→Mark filters plus contractor/activity/search apply across all views.

## User preferences

- No emojis anywhere in the UI.

## Gotchas

- **Large responses must be compressed.** The `/imports/{id}/records` endpoint returns the full expanded dataset (~28 MB+ JSON for a real report). The deployment proxy silently returns `500` (empty body) to the browser for oversized upstream responses even though the app logs `statusCode 200` — this surfaces as a misleading "No data for the selected filters" in the published app while dev works fine. `app.use(compression())` (in `artifacts/api-server/src/app.ts`) gzips it ~10x to stay under the limit. Keep compression enabled.
- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen` before relying on hooks/schemas.
- After changing DB schema, run `pnpm --filter @workspace/db run push`.
- Tailwind v4: do not `@apply` a custom utility class; use raw CSS properties for things like `font-variant-numeric: tabular-nums`.
- React Query hooks need an explicit `queryKey` in `query` options (e.g. `getGetSnapshotRecordsQueryKey(id)`).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
