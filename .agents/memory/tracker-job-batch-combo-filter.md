---
name: Job/Batch combo filter key space
description: Template members and selectedJobs are stored as combo keys ("821 - Z"); every component-level set.has() check must match both plain job code AND combo key.
---

## Rule
`useActiveJobSet()` returns combo keys like `"821 - Z"` when templates are active (members are stored as combo strings). Any in-component filter that checks `activeJobSet.has(r.job)` will miss all records because the plain code `"821"` is not in the set.

**Why:** Template members were migrated to "job - batch" combo keys (same key space as the Job/Batch combo picker) so templates and individual combos share one key space.

**How to apply:** Every in-component `activeJobSet.has(r.job)` check must also check the combo key:
```js
const comboKey = r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : null;
if (!activeJobSet.has(r.job ?? "") && !(comboKey && activeJobSet.has(comboKey))) return false;
```

The domain's `filterRecords` (used by `useFilteredRecords`) already handles this correctly via its `jobIn` combo-key check — only component-level filters need the fix.

**Affected files (already fixed):**
- `layout.tsx` — `matchesJobFilter` named-set branch
- `job-dashboard.tsx` — `preFiltered` named-set branch
- `reports.tsx` — ledger row project filter (uses spread + `startsWith` since rows have no mfcBatch)
- `data.tsx` — both `activeJobSet` useMemos: extract plain codes via `c.split(' - ')[0]`

## Three-filter design (Aug 2026)
Global filter bar has three independent TLT job filters, ANDed:
- **Jobs** (`filters.job`) — plain job code SearchableSelect
- **All Batches** (`filters.mfcBatch`) — batch letter SearchableSelect
- **Job/Batch combos** (`filters.selectedJobs`) — multi-checkbox "job - batch" picker (same key space as Job Templates)

`selectedJobs` is decoupled from `MULTI_JOBS_FILTER_VALUE` — it acts independently regardless of `filters.job`.
`setSelectedJobs` no longer changes `filters.job`.
`resolveActiveFilters` sets `jobIn` from `selectedJobs.length > 0` (not gated on `isMultiJobs`).
