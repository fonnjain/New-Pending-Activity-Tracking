---
name: Job Templates filter system
description: Replaces the excel-upload "Current Jobs" feature with UI-managed named project sets (TLT Job A, NTLT Job A, etc.) selectable from the global Jobs dropdown.
---

## The rule
Job Templates are named project sets stored in `job_templates` + `job_template_members` DB tables.
Each template gets a filter sentinel `"__TEMPLATE_{id}__"` stored in `filters.job`.

## Key helpers (all in `store.tsx`)
- `TEMPLATE_FILTER_PREFIX = "__TEMPLATE_"` 
- `isTemplateFilter(v)` — true if v starts with the prefix
- `templateFilterValue(id)` — encodes `"__TEMPLATE_{id}__"`
- `extractTemplateId(v)` — decodes the id
- `isNamedJobSetFilter(v)` — true for both old `CURRENT_JOBS_FILTER_VALUE` AND new templates
- `useJobTemplates()` — fetches all templates via React Query (queryKey: `["job-templates"]`)
- `useActiveJobSet()` — returns the correct `Set<string>` for whatever filter is active

## Pages to keep in sync
Every page that checks the job filter must use `isNamedJobSetFilter()` and `useActiveJobSet()`, NOT the old `CURRENT_JOBS_FILTER_VALUE` literal or `useCurrentJobsSet()`. Pages updated: layout.tsx, store.tsx, fg.ts, inventory.tsx, job-dashboard.tsx, reports.tsx, overview.tsx, data.tsx.

**Why:** The old single-upload "Current Jobs" feature was replaced; the sentinel value changed shape from a single static string to per-template dynamic strings.

**How to apply:** Any new page that needs to filter by the active job set: `const activeJobSet = useActiveJobSet()` and `if (isNamedJobSetFilter(filters.job)) { ... }`.

## UI location
`/production/job-templates` tab under the Data admin page. The `JobTemplatesContent` component in `data.tsx` handles create/delete/drag-assign.

## API routes (in `artifacts/api-server/src/routes/jobTemplates.ts`)
- `GET /api/job-templates` — list all templates with members
- `GET /api/job-templates/projects` — distinct project codes by category from latest import
- `POST /api/job-templates` — create (auto-names: "TLT Job A", "TLT Job B", ...)
- `PUT /api/job-templates/:id/members` — replace members
- `DELETE /api/job-templates/:id` — delete (cascades members)

## Global filter dropdown
`MultiJobPicker` in `layout.tsx` now shows templates dynamically (fetched via `useJobTemplates()`). Old static "Current Jobs" button removed.
