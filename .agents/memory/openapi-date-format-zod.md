---
name: OpenAPI date fields become zod coerce.date()
description: Why a YYYY-MM-DD string settings field must NOT use `format: date` in openapi.yaml here.
---

# OpenAPI `format: date` silently breaks string date fields

In this repo's Orval zod codegen, an openapi property with `format: date`
generates `zod.coerce.date()`, which parses the incoming `"YYYY-MM-DD"` string
into a JS `Date`. Any consumer that expects a **string** (e.g.
`migrateTurnaroundSettings`, which only accepts `validFromDate` when
`typeof === "string"` and it matches `/^\d{4}-\d{2}-\d{2}$/`, else forces
`null`) then silently drops the value to null. Net effect: PUT appears to
succeed but the field never persists.

**Rule:** for date-valued fields that flow through the domain as plain
`YYYY-MM-DD` strings, use `type: ["string","null"]` with
`pattern: '^\d{4}-\d{2}-\d{2}$'` in `lib/api-spec/openapi.yaml` — NOT
`format: date`. That yields `zod.string().regex(...)`, preserving the string.

**Why:** discovered when the global WIP `validFromDate` cutoff would not save;
codegen had turned it into `coerce.date()`. Switching to `pattern` fixed it.

**How to apply:** any time you add a date-string field to openapi that is
consumed as a string (not a Date), reach for `pattern`, then re-run
`pnpm --filter @workspace/api-spec run codegen` and grep the generated zod to
confirm it is `zod.string()`, not `zod.coerce.date()`.
