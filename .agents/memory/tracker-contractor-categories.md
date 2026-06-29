---
name: Contractor sub-categories overlay
description: Non-obvious decisions for the additive contractor classification layer
---

# Contractor sub-categories (CNC / Sub-contractor / Out-vendor + FAB/GALVA)

> Category label "In-house" (enum `IN_HOUSE`) was renamed to "CNC" (enum `CNC`) across domain/openapi/db/UI. Treat any lingering "In-house"/`IN_HOUSE` reference as stale.

A descriptive overlay that classifies each contractor; joined to records at READ time only.

- **Display-only, additive — same invariant as the ordering/turnaround layers.** Contractor source strings are NEVER mutated; classification is a separate config table joined live. It must never touch parsing, dedup hash, ageing, qty/Activity, or the merge model.
  **Why:** contractor names are part of identity/analytics; renaming them would corrupt dedup and history.
- **The join key is a normalized contractor name** (trim + collapse-whitespace + uppercase), produced by ONE shared helper in `@workspace/domain`. Seed, upsert, delete, and the frontend record→mapping join must ALL normalize through that same helper or rows silently fail to match.
  **How to apply:** any new code path that keys on a contractor name must normalize identically; never key on the raw display string.
- **Out-vendor tags (FAB/GALVA) are only meaningful for OUT_VENDOR.** Clearing is enforced in THREE places (frontend filter cascade, setup-page save, server upsert) — switching category away from OUT_VENDOR drops the tags. Keep all three in lockstep.
- **Editing is auth-gated CRUD modeled on the thickness page:** upsert on every change, delete = reset-to-unclassified; mutations invalidate the list query that `useContractorCategoryMap` consumes, so badges/filters refresh.
- Out-vendor seed list is DB-seeded once via `onConflictDoNothing` at boot (idempotent); user edits afterward win.
