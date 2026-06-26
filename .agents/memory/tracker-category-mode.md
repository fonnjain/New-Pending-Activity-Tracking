---
name: TLT/NTLT category mode (filter + grouping switch)
description: Why the tracker's Order Type is a non-null mode that switches both the filter dimension and the grouping, with no "All".
---

# TLT/NTLT category mode

In the tracker frontend, `Filters.category` is a **non-null mode** (`"TLT" | "NTLT"`, default `"TLT"`). There is deliberately **no "All"** option.

**Why:** "All" would silently mix project-grouped (TLT) and section-grouped (NTLT) rollups, which are different dimensions and produce meaningless combined totals. Forcing an explicit mode keeps every rollup coherent. Earlier, NTLT rows were still filtered by Project and matched nothing (all-zero views) — the toggle now switches the *primary filter dimension* too, not just a count.

**How to apply:**
- The toggle drives BOTH the filter dimension AND the grouping: TLT → primary = Project (`job`), secondary = Structure; NTLT → primary = Section (`record.groupKey`), secondary = Sub-category (`ntltSubtype`). Marks are the leaf in both.
- Switching mode must RESET the cross-mode primary/secondary selections (`job/section/structure/mark/ntltSubtype`) to their "All" defaults so no stale selection survives and produces zeros. Secondary filters (Contractor/Activity/Date/search) persist but their option lists must be recomputed from mode-scoped rows.
- `useFilteredRecords` gates on `r.category === filters.category` and `r.groupKey === filters.section`. Rows with `category === null` (unknown Order Nature) and NTLT rows with a null `groupKey` are naturally excluded from both modes — that is intended (they are genuine data gaps, surfaced elsewhere).
- The global FilterBar is hidden on `/jobs` (and requires `selectedImportId`), so the Job-wise/Section-wise page carries its **own** inline Order Type toggle that writes the same shared `filters.category`, keeping the two in sync.
- `category` is NOT counted in `activeFilterCount` (it is always set, never a "filter").
- Use the shared `components/ui/segmented.tsx` for the toggle.
