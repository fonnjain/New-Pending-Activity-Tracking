---
name: TLT/NTLT/All category mode (filter + grouping switch)
description: How the tracker's Order Type mode switches both the filter dimension and grouping; All includes both categories via per-row, prefixed keys.
---

# TLT/NTLT/All category mode

In the tracker frontend, `Filters.category` is a **non-null mode** (`"ALL" | "TLT" | "NTLT"`, default `"TLT"`). "All" includes BOTH categories.

**Why:** TLT is project-grouped and NTLT is section-grouped — different dimensions. The earlier design omitted "All" to avoid meaningless merged rollups, but it is now supported by resolving each row's grouping by its OWN category and (where a single primary dimension is required, e.g. Project Wise) prefixing the primary key with `TLT:`/`NTLT:` so a TLT project and an NTLT section with the same name never collide into one group. Aggregate pages that go through `useFilteredRecords` need no special handling — All just drops the category gate.

**How to apply:**
- `useFilteredRecords` gate: `if (filters.category !== "ALL" && (r.category||"TLT") !== filters.category) return false;` — All means no category gate.
- In the global FilterBar, All HIDES the mode-specific primary dropdown (Job/Section) and the Structure filter; secondary option lists (`modeRecords`) include both categories.
- Single-primary-dimension pages (Project Wise `/jobs`) must NOT coerce All→TLT (that silently drops NTLT). Resolve `primaryOf`/`secondaryOf` per-row via the row's category, and in All mode prefix the primary key. Detail drill-down then infers its mode from `records.some(r => r.category === "NTLT")`.
- For TLT-only / NTLT-only modes behaviour is byte-for-byte unchanged: prefixing is gated strictly by `isAll`.
- The toggle drives BOTH the filter dimension AND the grouping: TLT → primary = Project (`job`), secondary = Structure; NTLT → primary = Section (`record.groupKey`), secondary = Sub-category (`ntltSubtype`). Marks are the leaf in both.
- Switching mode must RESET the cross-mode primary/secondary selections (`job/section/structure/mark/ntltSubtype`) to their "All" defaults so no stale selection survives and produces zeros. Secondary filters (Contractor/Activity/Date/search) persist but their option lists must be recomputed from mode-scoped rows.
- `useFilteredRecords` gates on `r.category === filters.category` and `r.groupKey === filters.section`. Rows with `category === null` (unknown Order Nature) and NTLT rows with a null `groupKey` are naturally excluded from both modes — that is intended (they are genuine data gaps, surfaced elsewhere).
- The global FilterBar is hidden on `/jobs` (and requires `selectedImportId`), so the Job-wise/Section-wise page carries its **own** inline Order Type toggle that writes the same shared `filters.category`, keeping the two in sync.
- `category` is NOT counted in `activeFilterCount` (it is always set, never a "filter").
- Use the shared `components/ui/segmented.tsx` for the toggle.
