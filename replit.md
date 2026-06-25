# Balance & Activity Tracker

A mobile-first web app for steel-fabrication workshops. Upload an Excel (.xlsx or legacy .xls) balance/activity report and instantly see pending work, live ageing, contractor workload, activity progress, turnaround warnings, and velocity across multiple views.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/tracker run dev` — run the frontend (prefer the workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas from the OpenAPI spec (run after any `openapi.yaml` edit)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev). **Also re-run against prod after deploying schema changes** — `settings` (per_project, stalled_days) and `upload_staging.committed_import_id` were added over time.
- Required env: `DATABASE_URL` (Postgres). Optional: `ANTHROPIC_API_KEY` (enables the advisory AI layer).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind v4 + wouter (artifact `tracker`, served at `/`)
- API: Express 5 (artifact `api-server`, served at `/api`)
- DB: PostgreSQL + Drizzle ORM
- Excel parsing: SheetJS (`xlsx`); uploads via `multer` (memory storage)
- Validation: Zod (`zod/v4`), `drizzle-zod`; API codegen: Orval (from OpenAPI spec)

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` — run codegen after edits
- DB schema (source of truth): `lib/db/src/schema/` (`imports.ts`, `recordPool.ts`, `importRows.ts`, `settings.ts`, `uploadStaging.ts`)
- Shared domain engine (source of truth for ordering + all advisory math): `lib/domain/src/index.ts` (`@workspace/domain`)
- Excel parsing + ageing/route computation: `artifacts/api-server/src/lib/parse.ts`
- Merge/diff engine: `artifacts/api-server/src/lib/diff.ts`
- Routes: `artifacts/api-server/src/routes/` (`imports.ts`, `ai.ts`, `settings.ts`); report builder `src/lib/report.ts`; AI helpers `src/lib/ai.ts`
- Frontend pages: `artifacts/tracker/src/pages/`; shared frontend logic: `artifacts/tracker/src/lib/` (`store.tsx` filters, `settings.tsx`, `ageing.ts`, `turnaround.ts`, `movement.ts`, `velocity.ts`)
- Theme + all color scales: `artifacts/tracker/src/index.css`

## Canonical activity order (single source of truth)

`PROCESS_SEQUENCE = ["C","RFI","NH","B","HAB","HG","W","Q","TS","G","GB","Y"]` in `@workspace/domain`, plus `activityRank`/`isKnownActivity`/`compareActivity`/`sortActivities` (case-insensitive; unknown codes sort after known ones, alphabetically, never dropped). Imported by BOTH frontend and api-server. Every dropdown, card, table, report/export, and AI signal list orders by this. **Never re-define a local order array or sort activities alphabetically** — this is display/ordering only and must never change parsing, Activity values, quantities, ageing, or dedup.

## Architecture decisions

- **Append-only merge.** Each uploaded report = one immutable **import**; imports never replace each other (default view = newest = current state). Re-uploading is idempotent.
- **Two dedup layers, opposite intent.** WITHIN a file: NO dedup — in-sheet duplicate rows are preserved as separate pending units (`copies`, expanded in `/imports/{id}/records`). ACROSS uploads: dedup via a permanent `record_pool` keyed by full-row SHA-256 `hash`.
- **Per-import change log.** Each import stores a field-level diff vs the previous: moved activity, qty/wt changed, new marks, completed. Change identity = `markId|jobCardNo`; a removed identity is flagged **completed**, never deleted. Pool rows are permanent; deleting an import cascades only `import_rows`.
- **Concurrency-safe uploads.** `POST /imports` takes `pg_advisory_xact_lock(728041)` so concurrent uploads serialize against a stable baseline; pool insert uses `onConflictDoNothing(hash)` + re-select.
- **Live ageing, resolved per activity.** `ageingDays` is NOT stored — recomputed at read time (`resolveAgeingDate`/`computeAgeing` in parse.ts, both take `(activity, assignDate, lastProductionDate)`). **Activity `C` (Cutting) ages from `assignDate`** (no production date yet — Assign Date measures wait-to-cut); **every other activity ages from `lastProductionDate`** (col S, the 19th source column). C rows get a real ageing number and participate normally in buckets, averages, status, and velocity. **Future chosen dates clamp to today (ageing 0); blank/unparseable → `ageingDays = null`** (excluded from numeric buckets/averages everywhere). **Do NOT extend the assign-date fallback to non-C rows** — non-C rows with a blank production date stay null/excluded/flagged (a genuine data gap to surface). Null-ageing labels are activity-aware: **"Not started"** when `C` (and Assign Date also blank) else **"No production date"**. Frontend helpers (`lib/ageing.ts`) derive these from `ageingDays === null` + `isCutting`, so they adapt automatically; ageing math stays server-side. `lastProductionDate` is part of the row hash; `assignDate` is the date-range filter key. (The C→Assign-Date rule is read-time only; it does not touch the hash/identity.)
- **jsonb summaries.** Parse summary (rowsRead etc.) and change summary are stored as `jsonb` on the import — they can't be reconstructed from the deduped pool.
- **Client-side aggregation.** All KPIs, buckets, and breakdowns are computed client-side from the selected import's records with filters applied (AND logic). No separate aggregation endpoints.
- **Deterministic self-checks** (conservation: added+unchanged===rowsKept; idempotency; non-negative).
- **Optional advisory AI layer (never authoritative).** A bring-your-own-key Anthropic layer adds two read-only assists: sanitize (suggest descriptive-field cleanups) and review (audit results). It NEVER writes record_pool/import_rows/computed fields. **Sanitize is formatting-only for name fields:** a cleanup is dropped server-side unless `from`/`to` share the same alphanumeric token sequence (so whitespace/punctuation/casing fixes pass but suffix truncation/merges are blocked — `isTruncatingCleanup` in parse.ts, enforced at `/imports/validate`, `/imports/commit`, `/ai/sanitize`); `assignDate`/`lastProductionDate` are exempt (date-format fixes only). The key is read server-side only from `ANTHROPIC_API_KEY` (never sent to browser/logged). With no key the app works fully (`available:false`, buttons disabled). "Accept all" downloads a cleaned .xlsx to re-upload — nothing is mutated server-side. Code: `lib/ai.ts`, `routes/ai.ts`, `components/ai-*-panel.tsx`.

## Advisory overlays (all additive, display-only, in `@workspace/domain`)

All three layers below are recomputed live from settings, exactly like activity ordering. **None ever change parsing, Activity values, qty, dedup, ageing math, or each other's thresholds.** All frontend consumers defensively `migrateTurnaroundSettings(settings)` before classifying so a transient inverted-band draft can't mislabel.

- **Turnaround warnings (cumulative targets + grace bands).** User configures **ideal days per activity**; these accumulate down `PROCESS_SEQUENCE` into a **cumulative target** per activity. `alertStatus` compares a mark's live ageing to its target: Green (overrun ≤ 0), then Yellow/Orange/Red by grace bands; **`na`** when the target is null (unknown activity) OR ageing is null. Grace bands are stored as auto/manual **cells** (`GraceCell{mode,percent?,value?}`): manual pins days; auto = `round(percent/100 * idealDays)`. Cells RESOLVE to numeric days (`resolveCell`→`ActivityGrace{idealDays,yellowGrace,orangeGrace,redGrace}`) before any classification — downstream never sees cells. `normalizeGrace` rounds, clamps ≥ 0, and enforces yellow ≤ orange ≤ red (auto-raise), so inverted percentages never invert actual bands. Red is terminal.
- **Per-project overrides (per-field, sparse).** `activities` = global "All Projects" default; `perProject[job][activity]` holds sparse per-field overrides (any subset of idealDays/yellow/orange/red/preWarn). `resolveActivityGrace`/`cumulativeTarget`/`alertStatus` take an optional `project` param (omit = global; back-compat). Project key = the record's `job`. A project with no overrides behaves exactly like global.
- **Pre-warning + lifecycle ladder (8 states).** `lifecycleStatus` layers over `alertStatus` for an 8-state lifecycle: `green / prewarn1 / prewarn2 / prewarn3 / breach1 / breach2 / breach3 / na`. Breach phase (overrun > 0) reuses the breach band (yellow→breach1, etc.). Within-target (overrun ≤ 0) classifies by **percent of cumulative target consumed** against per-activity `PreWarnConfig{pw1,pw2,pw3}` (defaults 70/85/95, %-only, project-inherited like grace cells). Returns `consumedPct` + `daysToTarget`.
- **Stalled detection (cross-import).** A mark is **stalled** when its signature (distinct activities + distinct lastProductionDates) is unchanged for ≥ `stalledDays` (global, default 10). `GET /imports/{id}/movement` walks prior imports and returns `daysSinceLastMovement` (null when no usable history). Frontend `lib/movement.ts` (`useStalledInfo`) joins by `markId|jobCardNo` and **never flags stalled when `hasHistory` is false**.
- **Velocity (deterministic, from snapshot history).** `velocityForMark(series, settings, project)` computes pace (days/stage), pace-based ETA, eta_gap, trend, and velocity_status (`moving`/`slow`/`stalled`/`insufficient`); `< 2` usable snapshots → `insufficient` (no ETA). `GET /imports/{id}/velocity` does ONE history walk → per-identity items + project/contractor/stage aggregates + `daysSinceLastMovement`. Kept OUT of `/records` (the 28 MB gotcha). No new DB columns — computed live, React-Query cached. Frontend `lib/velocity.ts` (`useVelocityInfo`) joins by `markId|jobCardNo`; **aggregate pages recompute rollups from filter-scoped items** so header filters are honoured.
- **Persistence + auth.** Singleton `settings` table: `activities` jsonb + `per_project` jsonb + `stalled_days` int. `GET /settings` is **public** (migrates the stored row on read). `PUT /settings` **requires auth**, normalizes via `migrateTurnaroundSettings`, and echoes back exactly what it persists so the client cache never drifts. `migrateTurnaroundSettings` accepts every legacy shape (flat numeric, numeric grace, cell-based) and seeds preWarn/stalledDays, so any stored row keeps behaving the same. Frontend provider `lib/settings.tsx` applies a live local draft, debounced PUT, and reconciles to the server's normalized response on a settled save.
- **Colors (display-only, independent of the fixed ageing scale).** Status/lifecycle palettes have their own `.status-*`/`.lc-*` classes in `index.css`, single-sourced via helpers in `lib/turnaround.ts` (`statusTextColor`/`statusBgColor`/`lifecycleBgColor`/etc.). Changing these NEVER affects thresholds/targets/ageing. Do NOT reuse the `ageing-*` classes (fixed days-based buckets: green ≤ 30, amber 31–60, red > 60) for status.

## Pages & nav

Nav order (`layout.tsx` + `App.tsx`): **Overview, Turnaround, Stuck Projects, Activity, Job-wise, Contractor, Ageing, Reports, Data, Warning Params**.

- **Overview** (`overview.tsx`) — snapshot hub: two compact linking cards (Turnaround snapshot, Velocity snapshot) + headline KPIs + ageing breakdown + top aged/busiest contractors, with the Changes panel LAST (at the bottom). Stalled and slow are counted on the same filter-scoped identity basis as the Stuck page.
- **Turnaround** (`turnaround.tsx`, `/turnaround`) — 8-state deep-dive: a tabbed Projects/Contractors/Stages breakdown FIRST (`TurnaroundBreakdown`, at the very top — mirrors the Stuck Projects tab layout but driven by lifecycle/overrun metrics, not velocity: a project leaderboard by breach score with mark drill, and contractor/stage overrun tables — every row (project, contractor, stage) is clickable to expand the underlying marks; no summary tiles), then the TurnaroundWarnings "Turnaround Lifecycle" card (On track/Pre-warning/Breached + the full 8-state strip + by-activity bars) + urgency worklist (by daysToTarget) + the AI turnaround report (`components/ai-turnaround-report.tsx`).
- **Stuck Projects** (`stuck-projects.tsx`, `/stuck`) — project leaderboard by stuck score (stalled+slow weight share) with mark drill (pace/ETA/eta_gap/trend/days-since-movement), contractor + stage views. Every row (project, contractor, stage) is clickable to expand the underlying marks.
- **Activity / Job-wise / Contractor / Ageing** — process-ordered activity cards; job grouping; workload bars + contractor×ageing matrix; ageing buckets + activity-wise table + full pending table.
- **Reports** (`reports.tsx`) — `ReportBuilder` with turnaround + velocity export/table columns (joined via `useVelocityInfo`/`useStalledInfo`).
- **Data** — upload, parse summary, import list with change counts, CSV/JSON export, staged-upload panel.
- **Warning Params** (`warning-parameters.tsx`, auth-gated via `<LoginGate>`) — all config: a project dropdown ("All Projects" = global, or a specific `job`), a Pre-warnings card (PW1/PW2/PW3 + global stalled-days), and a per-activity grace grid (ideal days, cumulative target, yellow/orange/red grace-cell editors). Project mode edits sparse inherited overrides ("inherit"/"Clear"/"Reset this project" links); All Projects mode edits global rows ("Reset to defaults").

The Changes panel shows chips + a tabbed table (Moved activity / Qty-Wt changed / New marks / Completed) and a compare-any-two-imports selector. Cascading Job→Structure→Mark filters plus contractor/activity/search apply across all views.

## Parsing rules (parse.ts)

- Reads `Sheet1` (falls back to first sheet); reads all 19 columns (col S "Last Production Entry Date" is the 19th).
- **Header row auto-detected:** scans the first ~10 rows for one containing `Project Code`; data starts on the next row. Falls back to the 3rd row (historical layout) with a problem note.
- **Conditional `Project Code` forward-fill.** A blank Project Code inherits the last seen project ONLY for rows whose `Order Nature` is `Structure` (case-insensitive). Project-less item types (`RSJ POLE`/`EARTHING`/`GENERAL`) and rows with a blank/unknown Order Nature get `job = "(Unassigned)"` — they must NOT borrow a project. `(Unassigned)` is excluded from `projectsFound`. For these rows the mark-derivation project is empty, so `markId`/`markNumber` stays the bare m_no. Normalizes `"794."`→`794`, `"920.0"`→`920`.
- Keeps only rows with a non-empty `Mark No.`.
- **Mark No. → derived fields (VTPL Rules A–D, in order; see `deriveMark`).** `project` is always col A; `mNo` is always kept whole (never split off variant letters/trailing tokens). Separator in `markNumber` is `" \ "` (space-backslash-space):
  - **Rule A — bare mark:** col H has no space/backslash AND col A & col G both empty. `mNo = H`; structure/proMno empty; `markNumber = mNo`.
  - **Rule B — IS/SC/S rows ONLY** (col G exactly `IS`/`SC`/`S`): the only rows with a `proMno` and a **4-part** markNumber `project \ proMno \ structure \ mNo`. Strip the `"<A> <G>-"` prefix; strip a leading `VT` only directly before inner project digits (`VT837`→`837`; `VT` inside `3IVTS`/`2CVT` preserved); absorb an inner numeric project token into `proMno` else `proMno = "<G>"`; `structure` = first token, `mNo` = the rest.
  - **Rule D — backslash form, non-IS/SC:** `structure` = before the LAST `\`, `mNo` = after it. **3-part** markNumber.
  - **Rule C — standard space form `<A> <G>-<mNo>`, non-IS/SC:** strip the `"<A> <G>-"` prefix; `structure` = col G, `mNo` = remainder kept whole (do NOT split on the first dash). **3-part** markNumber.
- Legacy aliases: `structure`=aliasCorrected, `markTail`=mNo, `markId`=markNumber. `proMno` is stored+API (empty for non-IS/SC). Change-log identity = `markId|jobCardNo`.
- `hash` is SHA-256 over the **original 19 source columns ONLY** (incl. col S; derived fields excluded), so cleanups that touch derived fields don't change identity.
- NO within-file dedup: every kept row is a pending unit; `hash` dedups across uploads only.
- **Re-identification churn is expected** after format/identity changes (new `markNumber` separators, Rule B 4-part marks, col S joining the hash, project-attribution fixes): the first upload shows widespread "completed + new mark" in the diff — a one-time re-identification, not data loss (pool rows keyed by source-row hash).

## Upload: direct vs staged gatekeeper flow

- **Direct:** `POST /imports` parses, merges, and commits in one step (no gate). Still available.
- **Staged (gatekeeper):** `POST /imports/stage` holds the raw file in `upload_staging` (bytea) and returns a structural read; `POST /imports/validate` runs the Claude gatekeeper (verdict `ok`/`reject` + descriptive-only sanitize suggestions, `available:false` with no key); `POST /imports/commit` applies accepted `(field,from)→to` cleanups, re-hashes, then merges. `DELETE /imports/stage/{id}` discards. **Nothing is written to record_pool/import_rows/imports until commit.**
- **Commit is idempotent.** A successful commit marks the staged row with `committed_import_id` (not deleted). A duplicate/retried commit returns the same import (HTTP 200, ChangeSet reconstructed from `changeSummary`). True concurrency is safe: both serialize in `mergeImport`'s advisory lock; only one wins the atomic claim (`UPDATE ... WHERE committed_import_id IS NULL`), the loser deletes its orphan import and returns the winner. Committed staged rows are cleaned by a 24h TTL (`expireStagedUploads`).
- Both paths share `mergeImport()` in `routes/imports.ts`. Accepted cleanups are remapped onto the 19 source fields BEFORE hashing; mark identity is untouched. UI: `staged-upload-panel.tsx` (Data view).

## User preferences

- No emojis anywhere in the UI.

## Gotchas

- **Large responses must be compressed.** `/imports/{id}/records` returns the full expanded dataset (~28 MB+ JSON). The deployment proxy silently returns `500` (empty body) for oversized upstream responses even though the app logs `200` — surfaces as a misleading "No data for the selected filters" in prod. `app.use(compression())` (in `app.ts`) gzips it ~10x. Keep compression enabled.
- After editing `openapi.yaml`, run codegen before relying on hooks/schemas. After changing DB schema, run `db push` (dev AND prod).
- Tailwind v4: do not `@apply` a custom utility class; use raw CSS (e.g. `font-variant-numeric: tabular-nums`).
- React Query hooks need an explicit `queryKey` in `query` options (e.g. `getGetSnapshotRecordsQueryKey(id)`).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
