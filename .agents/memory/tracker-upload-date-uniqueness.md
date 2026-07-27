---
name: Upload date picker + per-date uniqueness
description: Date selector added to upload panels; one WIP and one OR allowed per date; deletion audit log.
---

## Rule
Each upload slot (WIP and Order Review) requires the user to pick a "report date" before selecting a file. Only one WIP import and one Order Review import are allowed per date (keyed on `asOnDate`). If a date already has an import, the user must delete it first.

## How it works

### Date picker (frontend)
- `StagedUploadPanel` has `selectedDate` state (defaults to today, YYYY-MM-DD format).
- `takenDates?: Set<string>` prop — if user picks a date in this set, file selection button is disabled + red warning shown.
- Date is sent as `reportDate` in the `POST /imports/stage` FormData.
- Shown as `dd-mm-yyyy` in the UI.

### Uniqueness enforcement (backend — `POST /imports/commit`)
- WIP: `wipAsOnDate = staged.reportDate ?? autoDetect ?? todayYmd()`. If `imports` already has a row with `asOnDate = wipAsOnDate` → 409.
- OR: `orderAsOnDate = staged.reportDate ?? autoDetect`. If `orderReviewImports` already has `asOnDate = orderAsOnDate` → 409.
- Uniqueness check runs AFTER the idempotency guard (so retries don't fail).
- `ingestOrderReview` now accepts `meta.asOnDate` override which takes priority over `parsed.asOnDate`.

### Deletion audit log
- DB table: `import_deletion_log` (id, import_id, file_type, source_filename, report_date, deleted_at, deleted_by).
- `deleted_by` = `req.user.displayName || req.user.email`.
- Logged in `DELETE /imports/:id` (before the delete) and in `DELETE /order-imports/:id` (after the transaction).
- New endpoint: `GET /imports/deletion-log` (auth required), newest first.
- Shown as a table at the bottom of the Data page.
- Query key for invalidation: `["/api/imports/deletion-log"]`.

## Key files
- `lib/db/src/schema/importDeletionLog.ts` — new table
- `artifacts/api-server/src/routes/imports.ts` — WIP delete log + commit uniqueness + deletion-log GET
- `artifacts/api-server/src/routes/orderStatus.ts` — OR delete log
- `artifacts/api-server/src/lib/dispatch.ts` — `ingestOrderReview` meta.asOnDate override
- `artifacts/tracker/src/components/staged-upload-panel.tsx` — date picker + takenDates gate
- `artifacts/tracker/src/pages/data.tsx` — takenDates wiring + deletion log display

**Why:** One WIP + one OR per date prevents accidental double-uploads for the same day; audit log gives accountability for deletions.
