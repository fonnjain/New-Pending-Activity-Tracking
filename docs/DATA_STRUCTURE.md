# Data Structure, Inputs & Parameters

This document describes the data the Balance & Activity Tracker accepts (the
Excel report you upload), how that input is parsed, the data structures it is
stored as, the fields that are computed live, and the API inputs/parameters.

---

## 1. Input: the Excel report you upload

You upload one `.xlsx` balance/activity report per import. The parser reads it
with these fixed expectations:

- **Sheet:** `Sheet1` (if absent, the first sheet is used).
- **Header row:** the **3rd row** of the sheet (rows 1–2 are title/blank rows
  and are ignored).
- **Columns read:** the 18 columns below, matched by their exact header text.

### Expected columns (header row, 3rd row of the sheet)

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
- **`structure`** = the Alias value (empty string if no alias).
- **`markTail`** = `Mark No.` with the `"<job> <alias>-"` prefix stripped (with
  fallbacks for `"<alias>-"` or a leading `"<job> "` token). This is **not** a
  naive split on the first hyphen.
- **`markId`** = `job\structure\markTail` (backslash-separated). This is the
  human-facing mark identity.
- **`hash`** = a SHA-256 of all 18 normalized fields joined in a fixed order.
  Two rows with byte-identical normalized content share a hash. This is the key
  used to deduplicate **across** uploads.

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
derived `structure`, `markTail`, `markId`, and `hash`.

| Column | Type | | Column | Type |
|---|---|---|---|---|
| `id` | serial PK | | `mark_no` | text |
| `hash` | text unique | | `section` | text/null |
| `job` | text | | `length` | number/null |
| `structure` | text | | `width` | number/null |
| `mark_tail` | text | | `wt_pcs` | number/null |
| `mark_id` | text | | `balance_qty` | number |
| `order_nature` | text/null | | `balance_wt` | number |
| `contractor` | text/null | | `assign_date` | date/null |
| `job_card_no` | text/null | | `activity` | text/null |
| `tower_type` | text/null | | `operation` | text/null |
| `tower_sub_type` | text/null | | `ref_job_card_no` | text/null |
| `alias` | text/null | | | |

### `import_rows` — which pool rows belong to which import

| Column      | Type    | Description                                                 |
|-------------|---------|-------------------------------------------------------------|
| `import_id` | integer | FK → `imports.id` (cascade delete).                         |
| `pool_id`   | integer | FK → `record_pool.id` (pool rows are permanent).            |
| `copies`    | integer | How many copies of this pool row this import contains.      |

Primary key is `(import_id, pool_id)`. The `copies` count is what preserves
in-sheet duplicate rows as separate pending units.

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
| `POST /imports`           | multipart: `file` (req), `label`, `reportDate`       | The created import + its change set.      |
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
`hash`, `markId`, `job`, `structure`, `markTail`, `markNo`, `alias`, `section`,
`jobCardNo`, `towerType`, `towerSubType`, `length`, `width`, `wtPcs`,
`balanceQty`, `balanceWt`, `activity`, `operation`, `assignDate`, `contractor`,
`orderNature`, `refJobCardNo`, plus the live `ageingDays`, `routeSteps`,
`currentStepIndex`.

> The records response can be very large (tens of MB) and is gzip-compressed by
> the server. All KPIs, buckets, and breakdowns shown in the five views are
> computed in the browser from this records list with the active filters applied.

---

## 6. Where this is defined in the code

- **Excel parsing & derivation:** `artifacts/api-server/src/lib/parse.ts`
- **API contract (source of truth):** `lib/api-spec/openapi.yaml`
- **DB schema:** `lib/db/src/schema/imports.ts`, `recordPool.ts`, `importRows.ts`
- **Change/diff engine:** `artifacts/api-server/src/lib/diff.ts`
- **Import routes:** `artifacts/api-server/src/routes/imports.ts`
