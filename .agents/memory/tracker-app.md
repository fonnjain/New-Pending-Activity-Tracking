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
- **Change identity = `markId|jobCardNo` (markId = the canonical `markNumber`); Activity (plus qty/wt) are tracked FIELDS.** A removed identity is flagged `completed`, never deleted.
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
- Reads all 18 columns. **Header row auto-detected** (scan first ~10 rows for "Project Code"; data on next row; fallback to 3rd row with a problem note). Normalize "794."->794 / "920.0"->920.
- **Project Code forward-fill is CONDITIONAL on Order Nature.** A blank Project Code only continues the group above for `Order Nature == "Structure"` rows (they inherit the last seen project). Project-less item types (RSJ POLE / EARTHING / GENERAL) and blank/unknown Order Nature must NOT borrow a project — they bucket under `job = "(Unassigned)"` (const `UNASSIGNED_JOB` in parse.ts). A leading Structure row before any project is seen also falls through to "(Unassigned)". Excluded from `projectsFound`. Their `jobForMark` is "" so `markId` stays the bare m_no (no embedded job).
  **Why:** in-source these rows have a genuinely blank col A; Excel filtering by the project above excludes them, the app must match. Borrowing the adjacent project mis-attributes counts/weights to e.g. job 921.
  **How to apply (non-obvious frontend coupling):** the engine STORES the label "(Unassigned)" rather than "" precisely because the existing dashboards filter out empty/falsy `job` (`.filter(Boolean)`); storing a non-empty label makes the rows a selectable, grouped bucket with ZERO dashboard edits (task was engine-only). `job` is in the row hash, so previously mis-attributed rows re-hash once and show as a one-time attribution correction in the diff (expected).
- **Mark No. -> 4 derived fields, decided by col H, CHECK BACKSLASH FIRST.** Spec acceptance examples are exact and non-obvious:
  - CASE 3 (col H has `\`, e.g. `775 IS-775\OB6M\3`): split on `\`; aliasCorrected = parts[1] (between backslashes, e.g. "OB6M"), mNo = last part, **projectSuffix = col G Alias** (e.g. "IS"), **markNumber = `<job>-<projectSuffix>\<aliasCorrected>\<mNo>`** = `775-IS\OB6M\3`. NOTE the hyphen and the suffix in the key — this is correct per spec, do NOT "simplify" to `job\alias\mNo`.
  - CASE 1 (no hyphen, no backslash, e.g. "01"): mNo = col H, projectSuffix/aliasCorrected="", markNumber=mNo (defensive `job\alias\mNo` only if job/alias present).
  - CASE 2 (hyphen, no backslash, e.g. `811 3S5-143`): strip `"<job> <alias>-"` prefix -> mNo; aliasCorrected = col G; markNumber = `job\aliasCorrected\mNo` = `811\3S5\143`.
  - Legacy aliases: structure=aliasCorrected, markTail=mNo, markId=markNumber. "structure" groups Case-3 under the BETWEEN-backslash alias (OB6M), not raw col G.
- `hash` is over the ORIGINAL 18 source columns ONLY (derived mark fields excluded) — so descriptive cleanups that touch derived fields can't change cross-upload identity.
- Keeps rows with a non-empty Mark No.; NO within-file dedup (see above).
- Ageing colors everywhere: green <=30, amber 31-60, red >60, neutral when no date.

## Staging + gatekeeper upload flow (B)
- Two upload paths share `mergeImport(parsed, meta, log)` in `routes/imports.ts`: direct `POST /imports` (no gate) and the staged path. **Nothing writes to record_pool/import_rows/imports until commit.**
- Staged: `POST /imports/stage` (holds raw file bytes in `upload_staging` bytea, returns a structural read) -> `POST /imports/validate` (Claude gatekeeper: verdict ok|reject + descriptive-only sanitize suggestions; `available:false` when no key) -> `POST /imports/commit` (applies accepted `(field,from)->to` cleanups onto the base 18 source fields BEFORE hashing, then merges) ; `DELETE /imports/stage/{id}` discards.
- Cleanups go through the SAME descriptive-field allow-list as the AI sanitize layer; identity/engine fields are never remappable. Gatekeeper is advisory — engine stays authoritative. UI: `staged-upload-panel.tsx` in the Data view.

## Units
- **All UI weight is shown in metric TONS, not kg.** Storage stays in kg (`balanceWt`); convert at render time only, via `formatTons(kg)` in `lib/utils.ts` (kg/1000, 1 decimal, locale separators). Labels read "(t)" / "Wt (t)".
  **Why:** real reports are large; tons read cleaner. Conversion is display-only so sorting/bar-width math still use raw kg.
  **How to apply:** any new weight display must route through `formatTons`; never store or aggregate in tons. CSV/JSON export intentionally keeps raw kg.

## Frontend gotchas
- Resource is named `import` across DB/API/frontend (store: `selectedImportId`). The Overview "Changes since last upload" panel lives in `components/changes-panel.tsx`.
- Tailwind v4: never `@apply` a custom utility class (e.g. tabular-nums) — use the raw CSS property.
- React Query hooks require an explicit `queryKey` in `query` options. The compare endpoint's generated query-param type is `CompareImportsQueryParams` (not `...Params`).
- Default import selection lives in TrackerProvider (store.tsx): auto-selects newest, recovers if selected is deleted.
- **Global filters live in the store, but the Job-wise dashboard bypasses `useFilteredRecords`.** It fetches raw records and applies its OWN local cascade (project/structure/mark). So any NEW global filter (e.g. the date-range filter) must be applied to it manually — it does not inherit store filters automatically. The date filter does this by re-deriving `records` from `rawRecords` via `isWithinDateRange(...)`. The global FilterBar is also hidden on `/jobs` and `/data`, so global-only filter UI won't appear there.
  **Why:** a date filter "on every page" silently missed the Job-wise page until applied at both layers.

## Filtering semantics
- **Job number != mark name — they collide.** A mark's name (`markTail`) can equal another job's number (e.g. jobs 884/900/911 each have a mark literally named "920"/"920H"). The prominent free-text search does substring matching across `markId/markTail/section/contractor`, so typing a job number into search legitimately pulls marks-named-that-number from OTHER jobs, inflating totals and looking like a "wrong sum" bug. There is NO search-scoping fix (the names really are "920"); the only correct way to isolate a job is the **Job dropdown** (`filters.job`, exact match). Keep the Job dropdown surfaced in the always-visible filter bar, not buried in the collapsible panel.
  **Why:** users reported "920 filter still shows job 900" and "errors in sum of weights/qty" — both were one root cause: searching by job number instead of using the Job filter. Sums themselves are correct (verified copy-weighted against the prod DB).

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
- **Name cleanups must preserve the alphanumeric token sequence — formatting-only (whitespace/punctuation-spacing/casing).** A cleanup is rejected+`req.log.warn`'d server-side when the normalized token sequence (lowercase, runs of non-alnum -> single space, trim) of `from` != `to`. `assignDate` is EXEMPT (date normalization legitimately changes tokens). Helper `isTruncatingCleanup`/`alnumTokens` in parse.ts is enforced at all 3 sanitize paths (`/imports/validate`, `/imports/commit`, `/ai/sanitize`); both Claude prompts also forbid it.
  **Why:** the model would otherwise drop disambiguating suffixes (e.g. "DASHMESH ENTERPRISES GP-2" -> "DASHMESH ENTERPRISES"), merging two distinct contractors and corrupting analytics. The server rule is authoritative; the prompt is advisory.
- **Accept-all sanitize round-trips through a cleaned .xlsx**, it never mutates the pool. The export must reproduce parse.ts's exact layout (Sheet1, two blank rows, header on row 3, the 18 columns in COL order) so re-upload recomputes everything; suggestions are matched to rows by full-row `hash` (exposed on the Record schema for this).
  **Why:** keeps the engine authoritative — the user re-uploads and the normal merge/diff runs; no special write path.
- Model ids live in ONE place (`lib/ai.ts`): standard = sonnet, deep = opus. Review runs a deep pass when verdict!=pass or deep requested, adding a `plan[]`.
- **AI Reports (`POST /ai/report`)** sends the model a pre-computed deterministic "analytics pack" ONLY — never raw rows. Every pack aggregate (totals/buckets/by-X/stale items/data-quality counts) must be multiplied by `copies`; forgetting it silently undercounts in-sheet duplicates.
  **Why:** a code review caught stale-item weight and not-in-route counts ignoring `copies`.
- **The whole-import report cache (`imports.ai_report` jsonb) is keyed by the DEFAULT baseline only.** Read/write the cache solely when unfiltered AND no `compareTo` — a custom `compareTo` changes the throughput baseline, so serving the default cache would return a report computed against a different baseline. Validate cached AND freshly built reports with `AiReportResponse.safeParse` before returning; on failure regenerate (cache) or return `available:false` (fresh).
  **Why:** stale/mis-baselined cache and off-contract bodies are silent correctness bugs.

## Codegen / schema gotchas
- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`. Do not change `info.title` (controls generated filenames).
- `drizzle-kit push` needs a TTY to confirm table renames; for non-interactive renames, drop the old tables via SQL first, then push.
