---
name: Tracker thickness lookup + markId path-param hazard
description: How thickness is resolved live (not hashed) and why DELETE endpoints keyed by markId/groupKey must use query params, not path segments.
---

# Thickness resolution (additive, live, never hashed)

Thickness (mm) is computed at read-time in `serializeRecord` via
`resolveThickness(row, {rsjByKey, manualByMarkId})` in `@workspace/domain`.
It is NOT stored on `record_pool` and NOT part of `hashRow` — identity/dedup are
untouched. Resolution order: manual pin wins → TLT/EARTHING derive from section
(angle last dim / "PLATE n MM") → RSJ uses the lookup table → GENERAL/unknown =
unset. Two config tables back it: `rsj_thickness` (groupKey unique) and
`manual_thickness` (markId pk, survives re-imports).

# markId / groupKey are unsafe as URL path segments

Canonical mark identities contain **backslashes and spaces** (e.g.
`946 \ 069-2NBE1 \ 06`), and RSJ group keys contain spaces. A DELETE endpoint
that keys on these via a path segment (`/manual-thickness/{markId}`) is fragile:
the generated client interpolated the raw value without `encodeURIComponent`, and
even with encoding `%5C`/`%2F` get normalized/dropped by the proxy → silent
no-op 204 with the row still present.

**Why:** the "manual clear" button looked like it worked (204) but never deleted.

**How to apply:** for any endpoint keyed on a mark identity or group key, pass the
key as a **query parameter**, not a path segment. Orval's `urlEncodeParameters`
output flag did NOT fix path interpolation in v8.9.1; query params (URLSearchParams)
encode correctly. Put auth (`requireAuth`) before the missing-param 400 check, so
unauthenticated calls return 401 regardless.
