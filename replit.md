# Balance & Activity Tracker

Mobile-first web app for steel-fabrication workshops. Upload an Excel (.xlsx/.xls) balance/activity report and see pending work, live ageing, contractor workload, activity progress, turnaround warnings, milestones, and velocity across multiple views.

## Run & operate

- `pnpm --filter @workspace/api-server run dev` — API server (prefer the workflow)
- `pnpm --filter @workspace/tracker run dev` — frontend (prefer the workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas (run after any `openapi.yaml` edit)
- `pnpm --filter @workspace/db run push` — push DB schema (dev). **Re-run against prod after deploying schema changes.**
- `pnpm --filter @workspace/scripts run fab-load-guard` — Fabrication Load invariant guard (needs `DATABASE_URL`). Recomputes the 10 Fab-Load figures for the latest import using the shared `@workspace/domain` sequence helpers, asserts locked expected tonnages/mark-counts, and fails loudly if any mark sits at activity `HG` (the one case a sequence reorder could silently shift In-Hand Bending/Welding). Re-lock the expected values in the script after any new balance-report upload; a mismatch between uploads means code changed the totals.
- Required env: `DATABASE_URL`. Optional: `ANTHROPIC_API_KEY` (enables the advisory AI layer).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind v4 + wouter (artifact `tracker`, served at `/`)
- API: Express 5 (artifact `api-server`, served at `/api`)
- DB: PostgreSQL + Drizzle ORM
- Excel: SheetJS (`xlsx`); uploads via `multer` (memory). Validation: Zod (`zod/v4`), `drizzle-zod`; codegen: Orval

## Where things live (sources of truth)

- API contract: `lib/api-spec/openapi.yaml` (codegen after edits)
- DB schema: `lib/db/src/schema/` (`imports`, `recordPool`, `importRows`, `settings`, `uploadStaging`, `projectMilestones`, `rsjThickness`, `manualThickness`)
- Domain engine (ordering + all advisory math): `lib/domain/src/index.ts` (`@workspace/domain`)
- Excel parse + ageing/route compute: `artifacts/api-server/src/lib/parse.ts`; merge/diff: `diff.ts`; milestones: `milestones.ts`; report: `report.ts`; AI: `ai.ts`
- Routes: `artifacts/api-server/src/routes/` (`imports.ts`, `ai.ts`, `settings.ts`)
- Frontend pages: `artifacts/tracker/src/pages/`; shared logic: `src/lib/` (`store.tsx`, `settings.tsx`, `ageing.ts`, `turnaround.ts`, `movement.ts`, `velocity.ts`)
- Theme + all color scales: `artifacts/tracker/src/index.css`

## Core invariants (never break)

- **Strictly additive.** No feature below ever changes parsing, Activity values, qty, dedup/hash identity, or ageing math. TLT behaviour is byte-for-byte unchanged.
- **Hash = the 19 source columns only** (incl. col S). Derived/classification/thickness fields are excluded, so read-time cleanups never change identity. NO within-file dedup; `hash` dedups across uploads only.
- **Live ageing, never stored.** Recomputed at read time. **Activity `C` ages from `assignDate`; every other activity ages from `lastProductionDate`** (col S). Future dates clamp to today (ageing 0); blank/unparseable → `null` (excluded from buckets/averages). **Do NOT extend the assign-date fallback to non-C rows.** Null labels are activity-aware: "Not started" (C + blank assign) else "No production date".
- **Append-only merge.** Each upload = one immutable import; default view = newest. Re-upload is idempotent.
- Tailwind v4: never `@apply` a custom utility class — use raw CSS.

## Canonical activity order + per-category sequences

`PROCESS_SEQUENCE = ["C","RFI","NH","B","HAB","HG","W","Q","TS","G","GB","Y"]` (the **TLT** route, default everywhere), in `@workspace/domain` with `activityRank`/`isKnownActivity`/`compareActivity`/`sortActivities` (case-insensitive; unknown codes sort after known, never dropped). Imported by frontend AND api-server. Every dropdown/card/table/report/AI list orders by this. **Never re-define a local order array or sort activities alphabetically** — display/ordering only.

NTLT marks follow shorter sequences sharing `Y` as terminal (`SEQUENCES` map): `NTLT_RSJ` `["NTF","NTFSW","NTFW","TS","G","GB","Y"]`, `NTLT_EARTHING`/`NTLT_GENERAL` `["TS","G","GB","Y"]`. Helpers: `sequenceFor(record)`, `rankIn`, `isKnownIn`, `finalStage`, `stageIndex`, `blocksReady`. Sequence-aware engine fns (`cumulativeTarget`, `alertStatus`, `lifecycleStatus`, `velocityForMark`) take an **optional** `sequence` defaulting to TLT, so every existing TLT call site is unchanged; per-row callers pass `sequence: sequenceFor(record)`. The milestone Ready-block uses `blocksReady()` so NTLT-only steps (e.g. `NTF`) correctly block.

## Architecture decisions

- **Two dedup layers, opposite intent.** WITHIN a file: NO dedup (in-sheet dup rows = separate pending units, `copies`, expanded in `/records`). ACROSS uploads: dedup via permanent `record_pool` keyed by full-row SHA-256 `hash`.
- **Per-import change log.** Field-level diff vs previous (moved activity / qty-wt changed / new marks / completed). Identity = `markId|jobCardNo`; a removed identity is **completed**, never deleted. Pool rows permanent; deleting an import cascades only `import_rows`.
- **Concurrency-safe uploads.** `POST /imports` takes `pg_advisory_xact_lock(728041)`; pool insert is `onConflictDoNothing(hash)` + re-select.
- **jsonb summaries** (parse summary + change summary) stored on the import — can't be rebuilt from the deduped pool.
- **Client-side aggregation.** All KPIs/buckets/breakdowns computed client-side from the selected import's records with filters applied (AND logic). No aggregation endpoints.
- **Deterministic self-checks** (conservation `added+unchanged===rowsKept`, idempotency, non-negative).
- **Optional advisory AI (never authoritative).** BYO-key Anthropic layer: sanitize (suggest descriptive cleanups) + review (audit). NEVER writes pool/rows/computed fields. Sanitize is formatting-only for name fields — a cleanup is dropped unless `from`/`to` share the same alphanumeric token sequence (`isTruncatingCleanup`, enforced at validate/commit/sanitize); date fields exempt. Key read server-side only from `ANTHROPIC_API_KEY` (never sent to browser/logged). No key → app fully works (`available:false`, buttons disabled). "Accept all" downloads a cleaned .xlsx to re-upload; nothing mutated server-side.

## Advisory overlays (additive, display-only, in `@workspace/domain`)

Recomputed live from settings. **None change parsing/Activity/qty/dedup/ageing or each other's thresholds.** Consumers defensively `migrateTurnaroundSettings(settings)` before classifying.

- **Turnaround warnings.** User sets ideal days/activity → accumulate into a **cumulative target**. `alertStatus` compares live ageing to target: Green (overrun ≤ 0) then Yellow/Orange/Red by grace bands; `na` when target null or ageing null. Grace stored as auto/manual cells (`GraceCell`) that resolve to numeric days (`resolveCell`) before classification. `normalizeGrace` enforces yellow ≤ orange ≤ red. Red terminal.
- **Per-project overrides (sparse, per-field).** `activities` = global default; `perProject[job][activity]` = sparse overrides. `resolveActivityGrace`/`cumulativeTarget`/`alertStatus` take an optional `project` (omit = global). No overrides = behaves like global.
- **Pre-warning + lifecycle ladder (8 states):** `green/prewarn1-3/breach1-3/na`. Breach (overrun > 0) maps yellow→breach1 etc. Within-target classifies by % of cumulative target consumed vs `PreWarnConfig` (defaults 70/85/95). Returns `consumedPct` + `daysToTarget`.
- **Stalled (cross-import).** Mark stalled when its signature (distinct activities + lastProductionDates) is unchanged ≥ `stalledDays` (default 10). `GET /imports/{id}/movement`; frontend `lib/movement.ts` joins by identity and **never flags stalled when `hasHistory` is false**.
- **Velocity (deterministic, from snapshot history).** `velocityForMark` → pace, ETA, eta_gap, trend, status (`moving/slow/stalled/insufficient`; `<2` snapshots → insufficient). `GET /imports/{id}/velocity` does ONE history walk → per-identity items + aggregates. Kept OUT of `/records` (the 28 MB gotcha). Frontend `lib/velocity.ts`; **aggregate pages recompute rollups from filter-scoped items** so header filters are honoured.
- **Persistence + auth.** Singleton `settings` row (`activities` + `per_project` jsonb + `stalled_days`). `GET /settings` public (migrates on read). `PUT /settings` requires auth, normalizes via `migrateTurnaroundSettings`, echoes back exactly what it persists. `migrateTurnaroundSettings` accepts every legacy shape.
- **Colors.** Status/lifecycle palettes use their own `.status-*`/`.lc-*` classes (helpers in `lib/turnaround.ts`). Do NOT reuse `ageing-*` classes (fixed buckets: green ≤ 30, amber 31–60, red > 60) for status.

## Project turnaround milestones (permanent capture, additive)

Per-project (`job`, excl. `(Unassigned)`) capture of two milestones measured from the project's earliest Assign Date: **M1 "Ready for Dispatch"** = first import where no mark is in a step before `Y`; **M2 "Dispatched"** = first import where the project is absent. Engine `milestones.ts` (`recomputeMilestones`); table `project_milestones` (pk `project`); `GET /milestones`.

- **Deterministic + capture-once.** Replays ALL imports id-ASC on each read AND best-effort after upload; earliest qualifying import always wins, so it's idempotent and a later partial file can't move a captured date. Stored milestone dates always win on merge. **Materialization iterates the UNION of replayed + stored rows** — this is what makes "permanent" permanent (do not narrow to replayed states).
- **Derived:** `readyTurnaroundDays`/`dispatchedTurnaroundDays` (days from `projectStart`, clamped ≥ 0); `dispatchLagDays`; `plannedReadyDays = cumulativeTarget("Y", settings, project)`; `varianceReadyDays = ready − planned`.
- **Edge cases:** straight-to-absent stamps Ready at dispatch date (lag 0); `limitedHistory` (captured with no prior in-progress sighting); `reopened` (mark returns to earlier activity post-capture). Recompute after upload is try/catch-wrapped so it can never fail an import.

## Pages & nav

Order (`layout.tsx` + `App.tsx`): **Overview, Turnaround, Stuck Projects, Completed, Activity, Job-wise, Contractor, Ageing, Reports, Data, Warning Params** (+ Thickness, auth-gated).

- **Overview** — snapshot hub: Turnaround + Velocity linking cards, headline KPIs, ageing breakdown, top aged/busiest contractors, Changes panel last.
- **Turnaround** (`/turnaround`) — `TurnaroundBreakdown` tabs (Projects/Contractors/Stages by breach score, rows expand to marks) first, then the Lifecycle card (8-state strip + by-activity bars) + urgency worklist + AI turnaround report.
- **Stuck Projects** (`/stuck`) — leaderboard by stuck score (stalled+slow) with mark drill; contractor + stage views; rows expand to marks.
- **Completed** (`/completed`) — permanent milestones table (status chips) + rollup tiles + CSV export. Honours only the global Job filter.
- **Activity / Job-wise / Contractor / Ageing** — process-ordered activity cards; group views; workload bars + contractor×ageing matrix; ageing buckets + tables.
- **Reports** — report-type selector (Job Wise vs AI), then `ReportBuilder` (turnaround + velocity columns) or `AiTurnaroundReport`.
- **Data** — upload, parse summary, import list with change counts, CSV/JSON export, staged-upload panel.
- **Warning Params** (auth-gated) — project dropdown (All Projects = global), Pre-warnings card (PW1-3 + stalled-days), per-activity grace grid (ideal days, cumulative target, grace-cell editors).
- **Thickness** (auth-gated) — RSJ lookup + manual-thickness CRUD; thickness is live-resolved (manual pin > section derive > RSJ lookup > unset), never hashed.

TLT/NTLT Order Type toggle switches both the primary filter dimension and grouping (TLT = Project/Structure; NTLT = Section `groupKey`/Sub-category `ntltSubtype`); switching modes resets cross-mode selections. Cascading filters + contractor/activity/search apply across views.

## Parsing rules (parse.ts)

- Reads `Sheet1` (else first sheet); all 19 columns (col S = "Last Production Entry Date", 19th).
- **Header auto-detected:** scans first ~10 rows for `Project Code`; data starts next row. Falls back to row 3 (historical) with a problem note.
- **Conditional Project Code forward-fill.** Blank Project Code inherits the last project ONLY when `Order Nature` is `Structure`. `RSJ POLE`/`EARTHING`/`GENERAL` and blank/unknown Order Nature → `job = "(Unassigned)"` (must NOT borrow a project; excluded from `projectsFound`; mark-derivation project empty). Normalizes `"794."`→`794`.
- **Category classification (additive, NOT hashed).** `classifyMark()` tags `category` (TLT/NTLT/null), `ntltSubtype`, `groupType`, `groupKey`, `active`: `Structure`→TLT (groupKey = job); `RSJ POLE`→NTLT/RSJ (groupKey = cleaned RSJ prefix); `EARTHING`/`GENERAL`→NTLT (groupKey = normalized Section); `FOUNDATION BOLT`→`active=false`; unknown→nulls. Drives per-category sequence; excluded from `hashRow`.
- Keeps only rows with a non-empty Mark No.
- **Mark No. → derived fields (VTPL Rules 0, A–D, in order; `deriveMark`).** `project` = col A; `mNo` kept whole; `markNumber` separator = `" \ "`.
  - **Rule 0** — strip a single stray leading `-` on the alias (col G, and col H after the `"<A> "` prefix); read-time only, doesn't touch raw values or hash.
  - **Rule A** — bare mark (col H, no space/backslash, A & G empty): `mNo = H`, `markNumber = mNo`.
  - **Rule B** — IS/SC/S rows only (col G exactly `IS`/`SC`/`S`): the only rows with `proMno`, **4-part** `project \ proMno \ structure \ mNo`. Strip `"<A> <G>-"`; strip a leading `VT` only before inner project digits; absorb inner numeric project token into `proMno` else `proMno = "<G>"`.
  - **Rule D** — backslash form, non-IS/SC: `structure` = before last `\`, `mNo` = after. **3-part**.
  - **Rule C** — space form `<A> <G>-<mNo>`, non-IS/SC: strip `"<A> <G>-"`; `structure` = col G, `mNo` = remainder kept whole. **3-part**.
- Aliases: `structure`=aliasCorrected, `markTail`=mNo, `markId`=markNumber. Change-log identity = `markId|jobCardNo`.
- **Re-identification churn is expected** after format/identity changes: first upload shows widespread "completed + new mark" — a one-time re-identification, not data loss.

## Upload: direct vs staged gatekeeper

- **Direct:** `POST /imports` parses + merges + commits in one step.
- **Staged:** `POST /imports/stage` (raw file in `upload_staging` bytea, returns structural read) → `POST /imports/validate` (Claude gatekeeper, descriptive-only sanitize suggestions) → `POST /imports/commit` (applies accepted cleanups, re-hashes, merges). `DELETE /imports/stage/{id}` discards. **Nothing written to pool/rows/imports until commit.**
- **Commit is idempotent.** Marks the staged row with `committed_import_id`; retried commit returns the same import. Concurrent commits serialize in `mergeImport`'s lock; only one wins the atomic claim. Committed staged rows cleaned by 24h TTL.
- Both paths share `mergeImport()`; accepted cleanups remap onto the 19 source fields BEFORE hashing; identity untouched. UI: `staged-upload-panel.tsx`.

## Gotchas

- **Large responses must be compressed.** `/imports/{id}/records` is ~28 MB+ JSON; the deploy proxy silently returns `500` (empty) for oversized responses (looks like "No data for the selected filters" in prod). `app.use(compression())` gzips ~10x — keep it on.
- After editing `openapi.yaml` run codegen; after DB schema changes run `db push` (dev AND prod).
- React Query hooks need an explicit `queryKey` (e.g. `getGetSnapshotRecordsQueryKey(id)`).

## User preferences

- No emojis anywhere in the UI.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
