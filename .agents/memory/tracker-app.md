---
name: Balance & Activity Tracker
description: Domain rules and non-obvious decisions for the xlsx-driven tracker app
---

# Balance & Activity Tracker

Mobile-first web app: each Excel upload = one append-only "import". Imports never replace each other; they accumulate into a permanent, hash-deduped "record pool", and each import gets a field-level change log vs the previous import.

## Durable decisions (append-merge model)
- **Append-only, never replace.** Every upload creates a new `imports` row. Old imports are immutable; dashboards show one selected import (default newest = current state).
  **Why:** the workshop needs an audit trail of what changed between reports, not a single overwritten state.
- **Two dedup layers, opposite intent.** WITHIN a file: NO dedup — in-sheet duplicate rows are preserved as separate pending units (tracked via `copies`/multiplicity and expanded in `/imports/{id}/records`). ACROSS uploads: dedup via a permanent `record_pool` keyed by full-row SHA-256 `hash`.
  **Why:** a mark listed twice in one sheet is two real pending units; the same unchanged row re-appearing in a later upload is not new work.
- **Idempotent re-import.** Re-uploading an identical file yields zero changes (0 added, all unchanged, 0 new/completed). Proven via curl.
- **Change identity = `job|structure|markTail|jobCardNo`; Activity (plus qty/wt) are tracked FIELDS.** A removed identity is flagged `completed`, never deleted.
  **Why:** identity must be stable across uploads so moves/qty changes/completions are detectable; jobCardNo distinguishes otherwise-identical marks (so identity count can exceed distinct markId count).
- **Pool rows are permanent and immutable.** Deleting an import cascades only `import_rows`; the pool is never pruned (truncate manually only for a clean slate).
- **Ageing computed live at read time, never stored.** `ageingDays = today - Assign Date`.
  **Why:** ageing must stay current without re-uploading.
- **Per-import `summary` (ParseSummary) and `changeSummary` (ChangeSummary) stored as jsonb.**
  **Why:** rowsRead/duplicate counts and change tallies cannot be reconstructed from the deduped pool; needed for the imports list + self-checks.
- **Deterministic self-checks (conservation: added+unchanged===rowsKept; idempotency; non-negative).** An OPTIONAL advisory AI layer sits beside this — see "Advisory AI layer" below — but the deterministic engine is always authoritative.

## Concurrency (POST /imports)
- The upload transaction takes `pg_advisory_xact_lock(728041)` first, so concurrent uploads serialize — each import's "previous import" baseline and pool inserts see a stable committed state.
- Pool insert uses `onConflictDoNothing({target: hash})` then re-selects unresolved hashes to fill `poolIdByHash`.
  **Why:** select-then-insert on the pool is otherwise racy and can fail a valid upload on the unique hash constraint.

## Parse rules (artifacts/api-server/src/lib/parse.ts)
- Reads all 18 columns. Header on 3rd row (`range: 2`), forward-fill Project Code, normalize "794."->794 / "920.0"->920.
- markTail strips the full `"<job> <alias>-"` prefix, NOT a naive split on first hyphen.
- Keeps rows with a non-empty Mark No.; NO within-file dedup (see above).
- Ageing colors everywhere: green <=30, amber 31-60, red >60, neutral when no date.

## Units
- **All UI weight is shown in metric TONS, not kg.** Storage stays in kg (`balanceWt`); convert at render time only, via `formatTons(kg)` in `lib/utils.ts` (kg/1000, 1 decimal, locale separators). Labels read "(t)" / "Wt (t)".
  **Why:** real reports are large; tons read cleaner. Conversion is display-only so sorting/bar-width math still use raw kg.
  **How to apply:** any new weight display must route through `formatTons`; never store or aggregate in tons. CSV/JSON export intentionally keeps raw kg.

## Frontend gotchas
- Resource is named `import` across DB/API/frontend (store: `selectedImportId`). The Overview "Changes since last upload" panel lives in `components/changes-panel.tsx`.
- Tailwind v4: never `@apply` a custom utility class (e.g. tabular-nums) — use the raw CSS property.
- React Query hooks require an explicit `queryKey` in `query` options. The compare endpoint's generated query-param type is `CompareImportsQueryParams` (not `...Params`).
- Default import selection lives in TrackerProvider (store.tsx): auto-selects newest, recovers if selected is deleted.

## Performance & the production "No data" trap
- **REAL root cause of the prod "No data" bug: the deployment proxy silently 500s oversized responses.** `/imports/{id}/records` returns the FULL expanded dataset — for a real report that is ~48k rows / **~28 MB+ of JSON**. The Express app generates it fine and logs `statusCode 200`, but the Replit **deployment proxy rejects the oversized upstream response and returns `500` with an empty body (`size=0`) to the browser**. The frontend then gets nothing, falls back to `[]`, and every page misleadingly shows "No data for the selected filters" even though prod has data. Small endpoints (`/imports`, ~1 KB) are unaffected, which is why the symptom looks selective. Dev (direct localhost, no proxy) never reproduces it.
  **Fix:** `app.use(compression())` in `artifacts/api-server/src/app.ts` — gzip shrinks the repetitive tabular JSON ~10x (to a few MB), under the proxy limit. **How to confirm:** prod `/imports` returns 200 but `/imports/{id}/records` returns 500 `size=0` via curl, while deployment request logs show the same request as `statusCode 200` — that 200-vs-500 split is the signature of a proxy size cap, NOT an app bug.
  Do NOT drop fields to shrink it: `hash` is used by export.ts and `routeSteps`/`currentStepIndex` by activity.tsx.
- All 6 pages call `useGetImportRecords` with the same key; the React Query client sets a non-zero `staleTime` + `refetchOnWindowFocus:false` + low `retry` (in `App.tsx`) so the heavy payload is fetched once per import instead of on every tab switch/focus. This is a perf improvement, not the fix for the "No data" bug above.
- Every view recomputes KPIs/buckets/groupings/sorts from the selected import's records on each render; this MUST stay wrapped in `useMemo` keyed on `[records]` (and `filters`/`search` where relevant), or typing in a search box re-runs full aggregation and the browser hangs on large real datasets.
- Large record tables must be bounded (Ageing "Full Pending Work" caps at `ROW_CAP` 200 with a "Showing top N of M" notice). Add pagination/virtualization rather than removing the cap.

## Advisory AI layer (optional, never authoritative)
- The AI layer is advisory text ONLY. It must never write `record_pool`/`import_rows`/computed fields and the whole app must work fully with NO key.
  **Why:** the deterministic engine is the single source of truth; AI is a sanity-checker/cleanup-suggester, not a data source.
  **How to apply:** every AI route returns `available:false` (not an error) when `ANTHROPIC_API_KEY` is unset, and checks availability BEFORE any DB work so the no-key path is verifiable without data. The key is read server-side only, only placed in the outbound Anthropic header, never logged or returned.
- **UI gates on a dedicated `GET /ai/status` probe**, not on a post-click response. Buttons disable + show "Set ANTHROPIC_API_KEY to enable AI assists" up front.
  **Why:** a code review caught that gating only after a click fails the "disabled with note" requirement.
- **Sanitize = descriptive-field cleanups only** via a hard server-side allow-list (contractor/section/assignDate/towerType/towerSubType/orderNature/refJobCardNo). Suggestions targeting any other field or an unknown hash are dropped server-side. NEVER include identity inputs (job/structure/markTail/markNo/alias/jobCardNo) or engine fields (qty/wt/activity/operation).
- **Accept-all sanitize round-trips through a cleaned .xlsx**, it never mutates the pool. The export must reproduce parse.ts's exact layout (Sheet1, two blank rows, header on row 3, the 18 columns in COL order) so re-upload recomputes everything; suggestions are matched to rows by full-row `hash` (exposed on the Record schema for this).
  **Why:** keeps the engine authoritative — the user re-uploads and the normal merge/diff runs; no special write path.
- Model ids live in ONE place (`lib/ai.ts`): standard = sonnet, deep = opus. Review runs a deep pass when verdict!=pass or deep requested, adding a `plan[]`.

## Codegen / schema gotchas
- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`. Do not change `info.title` (controls generated filenames).
- `drizzle-kit push` needs a TTY to confirm table renames; for non-interactive renames, drop the old tables via SQL first, then push.
