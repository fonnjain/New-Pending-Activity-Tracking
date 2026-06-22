# Data Structure, Inputs & Parameters

This document describes the data the Balance & Activity Tracker accepts (the
Excel report you upload), how that input is parsed, the data structures it is
stored as, the fields that are computed live, and the API inputs/parameters.

---

## 1. Input: the Excel report you upload

You upload one `.xlsx` balance/activity report per import. The parser reads it
with these fixed expectations:

- **Sheet:** `Sheet1` (if absent, the first sheet is used).
- **Header row:** **auto-detected.** The parser scans the first ~10 rows for the
  one containing `Project Code` and treats it as the header; data begins on the
  next row. If no such row is found it falls back to the **3rd row** (the
  historical layout) and records a problem note.
- **Columns read:** the 18 columns below, matched by their exact header text.

### Expected columns (in the auto-detected header row)

| Header text          | Meaning                                  | Type        | Required |
|----------------------|------------------------------------------|-------------|----------|
| `Project Code`       | Job / project number                     | text/number | See note¹ |
| `Order Nature`       | Order classification                     | text        | optional |
| `Contractor`         | Assigned contractor                      | text        | optional |
| `Job Card No.`       | Job card number                          | text        | optional |
| `Tower Type`         | Tower type                               | text        | optional |
| `Tower Sub Type`     | Tower sub type                           | text        | optional |
| `Alias`              | Structure alias (used to derive marks)   | text        | optional |
| `Mark No.`           | Mark number                              | text        | **yes**² |
| `Section`            | Section/profile                          | text        | optional |
| `Length`             | Length                                   | number      | optional |
| `Width`              | Width                                    | number      | optional |
| `Wt/Pcs`             | Weight per piece                         | number      | optional |
| `Balance Qty.`       | Pending quantity                         | number      | defaults 0 |
| `Balance Wt.`        | Pending weight                           | number      | defaults 0 |
| `Assign Date`        | Date the work was assigned               | date        | optional³ |
| `Activity`           | Current activity / process step          | text        | optional |
| `Operation`          | Full comma-separated process route       | text        | optional |
| `Ref. Job Card No.`  | Reference job card number                | text        | optional |

**Notes**

1. `Project Code` is **forward-filled**: if a row's Project Code is blank, the
   last non-blank value above it is reused. Values like `"920.0"` and `"794."`
   are normalized to `920` and `794`.
2. **Only rows with a non-empty `Mark No.` are kept.** Rows without a Mark No.
   are skipped entirely.
3. `Assign Date` accepts Excel date serials, real dates, or date-like text; all
   are normalized to `YYYY-MM-DD`. A blank or unparseable date becomes `null`
   (ageing then shows as "no date").

### Upload parameters

The upload (`POST /imports`, multipart form) accepts:

| Field        | Type            | Required | Description                                  |
|--------------|-----------------|----------|----------------------------------------------|
| `file`       | binary (.xlsx)  | **yes**  | The report file.                             |
| `label`      | text            | optional | A friendly name for this import.             |
| `reportDate` | text (date)     | optional | The "as of" date of the report.              |

---

## 2. Parsing & derivation rules

For every kept row the parser produces a normalized record:

- **`job`** = the (forward-filled, normalized) Project Code.
- **`alias`** = the Alias cell (or `null`).

#### Mark No. parsing (4 derived fields)

The raw `Mark No.` is parsed into four derived fields. The parser checks for a
**backslash first**, then handles the two hyphen layouts:

1. **Backslash form** (e.g. `794\T1\M101`): split on `\`. First segment →
   `projectSuffix`, middle → `aliasCorrected`, last → `mNo`.
2. **`<job> <alias>-<tail>` form** (e.g. `794 T1-M101`): the leading
   `"<job> <alias>-"` prefix is stripped; `aliasCorrected` = the alias token,
   `mNo` = the tail, `projectSuffix` = "".
3. **Plain / fallback form**: the whole value (after stripping any leading
   `"<job> "` token) becomes `mNo`; `aliasCorrected` falls back to the `Alias`
   cell; `projectSuffix` = "".

The four derived fields are:

- **`mNo`** — the bare mark tail (e.g. `M101`).
- **`projectSuffix`** — the project-code segment of a backslash mark, else "".
- **`aliasCorrected`** — the structure/alias as resolved from the mark (falls
  back to the `Alias` cell).
- **`markNumber`** = `job\aliasCorrected\mNo` — the canonical backslash mark
  identity.

These then drive the legacy fields:

- **`structure`** = `aliasCorrected`.
- **`markTail`** = `mNo`.
- **`markId`** = `markNumber`. This is the human-facing mark identity and the
  change-log identity (with `jobCardNo`).
- **`hash`** = a SHA-256 of the **original 18 source columns** joined in a fixed
  order (the derived mark fields are **not** part of the hash). Two rows with
  byte-identical source content share a hash. This is the key used to
  deduplicate **across** uploads.

### Deduplication: two layers, opposite intent

- **Within a single file: NO dedup.** Identical rows in the same sheet are all
  kept as separate pending units (their count is stored as `copies`).
- **Across uploads: dedup by `hash`.** A distinct full row is stored once in a
  permanent `record_pool`; later uploads that contain the same row just
  reference the existing pool row.

---

## 3. Stored data structures (database)

Three tables. The append-only design means each uploaded report is one
immutable **import**; imports never overwrite each other.

### `imports` — one row per uploaded report

| Column            | Type      | Description                                            |
|-------------------|-----------|--------------------------------------------------------|
| `id`              | serial PK | Import id.                                             |
| `label`           | text/null | Friendly name (from upload).                           |
| `source_filename` | text      | Original file name.                                    |
| `report_date`     | date/null | "As of" date (from upload).                            |
| `summary`         | jsonb     | Parse summary (see below).                             |
| `change_summary`  | jsonb/null| Field-level diff vs the previous import (see below).   |
| `ai_report`       | jsonb/null| Cached advisory AI report (optional, never authoritative). |
| `created_at`      | timestamp | Upload time.                                           |

**`summary` (ParseSummary)**: `rowsRead`, `rowsKept`, `distinctRows`,
`duplicateRowCopies`, `projectsFound`, `missingContractor`, `missingDate`.

**`change_summary` (ChangeSummary)**: `prevImportId`, `addedRows`,
`unchangedRows`, `movedActivity`, `qtyChanged`, `newMarks`, `completed`,
`netPendingQtyChange`, `netPendingWtChange`, `flags[]`.

### `record_pool` — permanent, append-only store of distinct rows

One row per distinct full-row `hash`. Rows are **never mutated or deleted**
(except by a full "Delete all data" reset). Holds all 18 source fields plus the
derived `structure`, `markTail`, `markId`, the four parsed mark fields (`m_no`,
`project_suffix`, `alias_corrected`, `mark_number`), and `hash`.

| Column | Type | | Column | Type |
|---|---|---|---|---|
| `id` | serial PK | | `alias` | text/null |
| `hash` | text unique | | `mark_no` | text |
| `job` | text | | `section` | text/null |
| `structure` | text | | `length` | number/null |
| `mark_tail` | text | | `width` | number/null |
| `mark_id` | text | | `wt_pcs` | number/null |
| `m_no` | text | | `balance_qty` | number |
| `project_suffix` | text | | `balance_wt` | number |
| `alias_corrected` | text | | `assign_date` | date/null |
| `mark_number` | text | | `activity` | text/null |
| `order_nature` | text/null | | `operation` | text/null |
| `contractor` | text/null | | `ref_job_card_no` | text/null |
| `job_card_no` | text/null | | | |
| `tower_type` | text/null | | | |
| `tower_sub_type` | text/null | | | |

The four parsed mark fields are `notNull` with default `""`.

### `import_rows` — which pool rows belong to which import

| Column      | Type    | Description                                                 |
|-------------|---------|-------------------------------------------------------------|
| `import_id` | integer | FK → `imports.id` (cascade delete).                         |
| `pool_id`   | integer | FK → `record_pool.id` (pool rows are permanent).            |
| `copies`    | integer | How many copies of this pool row this import contains.      |

Primary key is `(import_id, pool_id)`. The `copies` count is what preserves
in-sheet duplicate rows as separate pending units.

### `upload_staging` — temporary holding for the gatekeeper flow

A staged upload is the raw file held server-side **before** it is committed.
Nothing in `record_pool` / `import_rows` / `imports` is written until the user
accepts. A staged row is removed on commit or discard.

| Column            | Type        | Description                              |
|-------------------|-------------|------------------------------------------|
| `id`              | text (uuid) PK | Staging id returned by `POST /imports/stage`. |
| `source_filename` | text        | Original file name.                      |
| `label`           | text/null   | Friendly name (optional).                |
| `report_date`     | date/null   | "As of" date (optional).                 |
| `file_data`       | bytea       | The raw uploaded `.xlsx` bytes.          |
| `created_at`      | timestamp   | When it was staged.                      |

---

## 4. Computed-live fields (not stored)

These are recalculated on every read so they stay current without re-uploading:

- **`ageingDays`** = today − `assignDate` (whole days, UTC). `null` if no date.
- **Ageing color scale** (used everywhere): green ≤ 30, amber 31–60, red > 60,
  neutral when there is no date.
- **`routeSteps`** = the `Operation` string split on commas (trimmed).
- **`currentStepIndex`** = index of `activity` within `routeSteps` (or `null`).

When `GET /imports/{id}/records` runs, each pool row is expanded by its `copies`
count, so duplicates appear as separate records, each with these live fields.

---

## 5. API endpoints, inputs & parameters

Base path: `/api`.

| Method & path             | Input / parameters                                  | Returns                                  |
|---------------------------|-----------------------------------------------------|------------------------------------------|
| `GET /healthz`            | none                                                 | `{ status }`                             |
| `GET /imports`            | none                                                 | All imports, newest first.               |
| `POST /imports`           | multipart: `file` (req), `label`, `reportDate`       | The created import + its change set (direct, no gate). |
| `POST /imports/stage`     | multipart: `file` (req), `label`, `reportDate`       | `{ stagingId, sourceFilename, structural }` — holds the file; nothing committed. |
| `POST /imports/validate`  | json `{ stagingId }`                                 | Gatekeeper verdict (`ok`/`reject`) + descriptive-only sanitize suggestions (advisory). |
| `POST /imports/commit`    | json `{ stagingId, acceptedSuggestions? }`           | Applies accepted `(field,from)->to` cleanups, merges, and returns the created import + change set. |
| `DELETE /imports/stage/{id}` | path `id`                                         | `204`; discards a staged upload without committing. |
| `DELETE /imports`         | none                                                 | `{ importsDeleted, poolRowsDeleted }` — **full reset** of all imports and the pool. |
| `GET /imports/{id}`       | path `id`                                            | One import with summaries.               |
| `DELETE /imports/{id}`    | path `id`                                            | `204`; deletes the import only (pool stays). |
| `GET /imports/{id}/records` | path `id`                                          | Records, copy-expanded, with live ageing/route. |
| `GET /imports/{id}/changes` | path `id`                                          | Field-level change set vs previous import. |
| `GET /imports/compare`    | query `from` (req), `to` (req)                       | Change set between any two imports.       |
| `GET /ai/status`          | none                                                 | `{ available }` (advisory AI on/off).    |
| `POST /ai/sanitize`       | json `{ importId }`                                  | Suggested descriptive-field cleanups (advisory). |
| `POST /ai/review`         | json `{ importId, compareTo?, deep? }`              | Consistency audit (advisory, read-only). |
| `POST /ai/report`         | json `{ importId, compareTo?, filters? }`          | Turnaround analytical report (advisory).  |

**Record fields returned by `GET /imports/{id}/records`**: `id`, `importId`,
`hash`, `markId`, `job`, `structure`, `markTail`, `mNo`, `projectSuffix`,
`aliasCorrected`, `markNumber`, `markNo`, `alias`, `section`, `jobCardNo`,
`towerType`, `towerSubType`, `length`, `width`, `wtPcs`, `balanceQty`,
`balanceWt`, `activity`, `operation`, `assignDate`, `contractor`, `orderNature`,
`refJobCardNo`, plus the live `ageingDays`, `routeSteps`, `currentStepIndex`.

> The records response can be very large (tens of MB) and is gzip-compressed by
> the server. All KPIs, buckets, and breakdowns shown in the five views are
> computed in the browser from this records list with the active filters applied.

---

## 6. Where this is defined in the code

- **Excel parsing & derivation:** `artifacts/api-server/src/lib/parse.ts`
- **API contract (source of truth):** `lib/api-spec/openapi.yaml`
- **DB schema:** `lib/db/src/schema/imports.ts`, `recordPool.ts`, `importRows.ts`,
  `uploadStaging.ts`
- **Change/diff engine:** `artifacts/api-server/src/lib/diff.ts`
- **Import + staging/gatekeeper routes:** `artifacts/api-server/src/routes/imports.ts`
- **Gatekeeper / AI layer:** `artifacts/api-server/src/lib/ai.ts`
