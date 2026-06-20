# Balance & Activity Tracker — Architecture

A mobile-first web app for steel-fabrication workshops. A user uploads an Excel
(`.xlsx`) balance/activity report; the app stores it as an immutable **import**,
merges it into a permanent de-duplicated record pool, computes what changed since
the previous upload, and renders pending work, live ageing, contractor workload,
and activity progress across six views.

---

## 1. System overview

```
                ┌──────────────────────────────────────────────┐
                │              Browser (mobile-first)           │
                │   React + Vite SPA  (artifact: tracker, "/")  │
                │   wouter routing · TanStack Query · Tailwind  │
                └───────────────┬──────────────────────────────┘
                                │  HTTP (generated React Query hooks)
                                │  base path-routed by shared proxy
                ┌───────────────▼──────────────────────────────┐
                │   Express 5 API (artifact: api-server, "/api")│
                │   multer upload · Zod validation · pino logs  │
                │   parse.ts (Excel) · diff.ts (merge/change)   │
                └───────────────┬──────────────────────────────┘
                                │  Drizzle ORM
                ┌───────────────▼──────────────────────────────┐
                │             PostgreSQL                         │
                │   imports · record_pool · import_rows          │
                └───────────────────────────────────────────────┘
```

- **Contract-first**: `lib/api-spec/openapi.yaml` is the single source of truth.
  Orval generates typed React Query hooks and Zod schemas from it.
- **Append-only**: every upload creates a new immutable import. Imports never
  replace one another. Dashboards show one selected import (default: newest).
- **All aggregation is client-side**: the API serves raw records for the selected
  import; KPIs, buckets, groupings, and sorts are computed in the browser.

---

## 2. Monorepo layout (pnpm workspaces)

```
artifacts/                      # deployable apps
  api-server/                   # Express API  (served at /api)
    src/
      app.ts, index.ts          # server bootstrap
      lib/parse.ts              # Excel parsing + hashing + ageing/route compute
      lib/diff.ts               # merge + change-detection engine
      lib/logger.ts             # pino logger
      routes/imports.ts         # upload/list/get/delete/records/changes/compare
      routes/health.ts, index.ts
  tracker/                      # React+Vite frontend (served at /)
    src/
      App.tsx                   # routes (wouter) + providers
      components/layout.tsx     # nav + cascading filter bar
      components/changes-panel.tsx
      pages/                    # overview, job-dashboard, activity, ageing, contractor, data
      lib/store.tsx             # selected import + filters (React context)
      lib/export.ts, lib/utils.ts
  mockup-sandbox/               # design/preview workspace (not part of product)

lib/                            # shared libraries
  api-spec/                     # openapi.yaml + Orval config (source of truth)
  api-client-react/             # generated React Query hooks + fetch wrapper
  api-zod/                      # generated Zod schemas
  db/                           # Drizzle schema + client
    src/schema/{imports,recordPool,importRows,index}.ts
```

- `lib/*` are composite TypeScript packages (emit declarations via `tsc --build`).
- `artifacts/*` are leaf packages (typechecked with `tsc --noEmit`); they never
  import each other — shared code lives in `lib/*`.

---

## 3. Tech stack

| Layer            | Technology                                                        |
| ---------------- | ----------------------------------------------------------------- |
| Language/runtime | TypeScript 5.9, Node.js 24                                         |
| Frontend         | React + Vite, Tailwind v4, wouter (routing), TanStack Query       |
| API              | Express 5, multer (memory storage), pino (logging)                |
| Validation       | Zod (`zod/v4`), `drizzle-zod`                                      |
| Database         | PostgreSQL + Drizzle ORM                                           |
| Excel parsing    | SheetJS (`xlsx`)                                                   |
| API codegen      | Orval (generates hooks + Zod from OpenAPI)                         |
| Hashing          | Node `crypto` SHA-256 (full-row hash for cross-upload dedup)       |

---

## 4. Data model

Three tables form an append-only ledger with a shared, de-duplicated row pool.

### 4.1 `imports` — the immutable ledger
One row per upload. Never replaced.

| Column           | Type            | Notes                                              |
| ---------------- | --------------- | -------------------------------------------------- |
| `id`             | serial PK       |                                                    |
| `label`          | text (nullable) | user-supplied name for the upload                  |
| `source_filename`| text            | original `.xlsx` filename                          |
| `report_date`    | date (nullable) | report date if supplied                            |
| `summary`        | jsonb           | `ParseSummary` (see below)                          |
| `change_summary` | jsonb (nullable)| `ChangeSummary` vs the previous import             |
| `created_at`     | timestamptz     | defaults to now                                    |

`summary` and `change_summary` are stored as JSON because their counts
(rowsRead, duplicates, change tallies) cannot be reconstructed from the
de-duplicated pool.

### 4.2 `record_pool` — permanent de-duplicated rows
A permanent, append-only store of **distinct** source rows. Rows are never
mutated or deleted; de-duplication across uploads happens via the unique `hash`.

- `id` serial PK, `hash` text **unique** (SHA-256 of the normalized full row).
- All 18 source columns: `job`, `structure`, `markTail`, `markId`, `orderNature`,
  `contractor`, `jobCardNo`, `towerType`, `towerSubType`, `alias`, `markNo`,
  `section`, `length`, `width`, `wtPcs`, `balanceQty`, `balanceWt`, `assignDate`,
  `activity`, `operation`, `refJobCardNo`.
- Note: `ageingDays` is **not** stored — it is recomputed live at read time.

### 4.3 `import_rows` — membership with multiplicity
Maps which pool rows belong to which import, and how many in-sheet copies.

| Column      | Type    | Notes                                                  |
| ----------- | ------- | ------------------------------------------------------ |
| `import_id` | int FK  | → `imports.id`, `ON DELETE CASCADE`                    |
| `pool_id`   | int FK  | → `record_pool.id` (pool rows are kept on delete)      |
| `copies`    | int     | in-sheet duplicate count for this row in this import   |
| PK          |         | composite `(import_id, pool_id)`                        |

This is the heart of the **two-layer de-dup** design:
- **Within a file**: identical rows are NOT collapsed away — they are counted in
  `copies`, so in-sheet duplicates remain distinct pending units.
- **Across uploads**: identical rows resolve to the same `pool_id` via `hash`,
  so an unchanged row reappearing in a later report is not treated as new work.

Deleting an import cascades only its `import_rows`; the pool persists.

---

## 5. Excel parsing (`api-server/src/lib/parse.ts`)

1. Reads `Sheet1` (falls back to the first sheet); header is on the 3rd row
   (`range: 2`); reads all 18 columns.
2. Forward-fills `Project Code`; normalizes `"794."` → `794`, `"920.0"` → `920`.
3. Keeps only rows with a non-empty `Mark No.`.
4. `markId` = `job\structure\markTail`; `markTail` strips the full
   `"<job> <alias>-"` prefix (not a naive split on the first hyphen).
5. **No within-file de-dup.** Every kept row becomes a pending unit; a SHA-256
   hash of the normalized full row is the only key used to de-dup across uploads.
6. Produces a `ParseSummary`: `rowsRead`, `rowsKept`, `distinctRows`,
   `duplicateRowCopies`, `projectsFound`, `missingContractor`, `missingDate`.

**Ageing** is derived at read time, never stored: `ageingDays = today − AssignDate`.
Color scale used everywhere: green ≤30, amber 31–60, red >60, neutral if no date.

---

## 6. Upload & merge flow (`POST /imports`)

```
parse .xlsx → multiset of {hash → {row, copies}}
         │
         ▼  (single DB transaction)
  pg_advisory_xact_lock(728041)          # serialize concurrent uploads
         │
  read previous import (max id)          # stable baseline
  insert new imports row
  ensure pool rows exist:
     select existing hashes
     insert missing  (onConflictDoNothing(hash))   # race-safe
     re-select any unresolved hashes               # fill pool ids
  insert import_rows (importId, poolId, copies)
  build change set vs previous import (diff.ts)
  run deterministic self-checks
  persist change_summary on the import
         │
         ▼
  return { import, changeSet }
```

**Concurrency hardening**: a Postgres advisory transaction lock serializes
overlapping uploads so each import compares against a stable committed baseline,
and the pool insert uses `onConflictDoNothing` + re-select so a concurrent insert
of the same hash can never fail a valid upload.

**Idempotency**: re-uploading an identical file yields zero changes
(0 added, all unchanged, 0 new/completed). Verified end to end.

---

## 7. Change-detection engine (`api-server/src/lib/diff.ts`)

Compares the previous import's membership against the new import's and emits a
`ChangeSet`. There are two levels of comparison:

1. **Row multiset counts** (by `hash`): `addedRows`, `unchangedRows`,
   `removedRows` — using `min`/`max` of copy counts so multiplicities are exact.
2. **Identity-level diff**: rows are aggregated by the stable identity key
   `job | structure | markTail | jobCardNo`. For each identity the engine tracks
   summed qty/wt, the set of activities, and the furthest route step.

For each identity present in the new import:
- **New mark** — identity absent from the previous import.
- **Moved activity** — the activity label set changed.
- **Qty/Wt changed** — rounded qty or wt differs.

Identities present before but absent now are flagged **completed**
(removed items are flagged, never deleted).

The engine also emits net pending qty/wt deltas and human-readable **flags**
(deterministic only — no AI), e.g. marks that moved backward in their route,
marks whose balance qty increased, or a large share of carried-over marks
reassigned to a different contractor.

`ChangeItem` carries `from`/`to` for activity, qty, and wt so the UI can render
before→after. AI-based advisory is explicitly out of scope.

### Self-checks (deterministic)
- **Conservation**: `addedRows + unchangedRows === rowsKept` of the new import.
- **Idempotency**: identical re-upload produces an all-zero change set.
- **Non-negative**: counts never go negative.

---

## 8. API surface (`/api`, contract in `openapi.yaml`)

| Method & path               | Operation        | Purpose                                                        |
| --------------------------- | ---------------- | ------------------------------------------------------------- |
| `GET /healthz`              | `healthCheck`    | Liveness probe                                                 |
| `GET /imports`              | `listImports`    | List imports (newest first) with summaries + change counts    |
| `POST /imports`             | `uploadImport`   | Upload `.xlsx`; append import, merge, return `{import, changeSet}` |
| `GET /imports/{id}`         | `getImport`      | Single import metadata                                         |
| `DELETE /imports/{id}`      | `deleteImport`   | Delete an import (cascades `import_rows`; pool kept)           |
| `GET /imports/{id}/records` | `getImportRecords` | Records for an import, **expanded by `copies`** (live ageing) |
| `GET /imports/{id}/changes` | `getImportChanges` | Change set vs the previous import                            |
| `GET /imports/compare?from&to` | `compareImports` | Change set between any two imports                          |

Key schemas: `Import`, `ParseSummary`, `ChangeSummary`, `Record`, `ChangeSet`,
`ChangeItem`, `ChangeCounts`. The compare endpoint's generated query-param type
is `CompareImportsQueryParams`.

Requests and responses are validated with Zod schemas generated from the same
OpenAPI spec; the frontend consumes generated TanStack Query hooks.

---

## 9. Frontend architecture (`artifacts/tracker`, served at `/`)

### Routing (wouter)
`/` Overview · `/jobs` Job-wise · `/contractor` Contractor · `/activity`
Activity · `/ageing` Ageing · `/data` Data. The router base is derived from
`import.meta.env.BASE_URL` so the app works under its proxied path prefix.

### State (`lib/store.tsx`, React context)
- `selectedImportId` — defaults to the newest import; auto-recovers if the
  selected import is deleted.
- `filters` — cascading `Job → Structure → Mark`, plus `contractor`, `activity`,
  and free-text `search`. Selecting a Job resets Structure+Mark; Structure resets
  Mark. `useFilteredRecords` applies all active filters with AND logic.

### Data fetching
Generated TanStack Query hooks (`useListImports`, records/changes hooks, etc.)
call the API through a shared fetch wrapper. The selected import's records are
fetched once and all views derive from them.

### Views
- **Overview** — KPIs + the "Changes since last upload" panel + ageing breakdown
  + top aged / busiest contractors.
- **Job-wise** — per-job dashboard.
- **Activity** — process-ordered activity cards with expandable mark tables.
- **Ageing** — ageing buckets + activity-wise ageing table + full pending table
  (row-capped for performance).
- **Contractor** — workload bars + contractor × ageing matrix.
- **Data** — upload, parse summary, import list with change counts, CSV/JSON
  export.

### "Changes since last upload" panel (`components/changes-panel.tsx`)
Summary chips (New marks, Completed, Moved activity, Qty/Wt changed, Added rows,
Net pending qty/wt) over a tabbed table — **Moved activity / Qty-Wt changed /
New marks / Completed** — plus a **compare-any-two-imports** selector backed by
`GET /imports/compare`.

### Performance rules
All KPI/bucket/grouping/sort computations are wrapped in `useMemo` keyed on the
records (and filters/search). Large tables are bounded with a row cap and a
"showing top N of M" notice. Weights are displayed in metric tons via
`formatTons` (storage stays in kg; conversion is display-only).

---

## 10. Cross-cutting conventions

- **Contract-first**: edit `openapi.yaml`, then run
  `pnpm --filter @workspace/api-spec run codegen`. Do not change `info.title`
  (it controls generated filenames).
- **DB changes**: edit `lib/db/src/schema/*`, then
  `pnpm --filter @workspace/db run push` (dev). Drizzle renames need a TTY; for
  non-interactive renames, drop old tables via SQL first.
- **Logging**: never `console.log` in server code — use `req.log` in handlers and
  the singleton `logger` elsewhere.
- **Routing/proxy**: a shared reverse proxy routes by path (`/` → tracker,
  `/api` → api-server). Services handle their own full base path; ad-hoc calls go
  through `localhost:80`, never service ports directly.
- **No emojis** anywhere in the UI.

---

## 11. Build, run & verify

| Command                                                  | Purpose                                  |
| ------------------------------------------------------- | ---------------------------------------- |
| `pnpm --filter @workspace/api-server run dev`           | run the API server (via workflow)        |
| `pnpm --filter @workspace/tracker run dev`              | run the frontend (via workflow)          |
| `pnpm run typecheck`                                    | full typecheck across all packages       |
| `pnpm run build`                                        | typecheck + build all packages           |
| `pnpm --filter @workspace/api-spec run codegen`         | regenerate hooks + Zod from OpenAPI      |
| `pnpm --filter @workspace/db run push`                  | push DB schema changes (dev only)        |

Required env: `DATABASE_URL` (Postgres connection string).
