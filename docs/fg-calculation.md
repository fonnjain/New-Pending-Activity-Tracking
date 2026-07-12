# Finished Goods (FG) Calculation — Project Wise Page

## Two separate FG figures

The Project Wise page shows **two distinct FG figures**, each coming from a different data source.

| Column | Label in UI | Source file | What it measures |
|--------|-------------|-------------|-----------------|
| FG (MT) | "FG (MT)" | Order Review file | Galvanised tonnage not yet dispatched, per the Order Review book |
| Finished Goods WIP | "Finished Goods WIP (FG) — wt / marks" | WIP / Balance file | Weight of marks physically in the FG yard, still pending dispatch |

---

## Column 1: FG (MT) — Order Review based

### Formula (per structure row)

```
FG = Galvanising Progress MT  −  File Despatch MT
       (Order Review col ~galvMt)     (Order Review col ~fileDespatchMt)
```

- **Galvanising Progress MT** — "Progress > Galvanising (MT)" from the Order Review Excel file. Represents cumulative tonnage that has completed galvanising.
- **File Despatch MT** — "Progress > Despatch (MT)" from the Order Review Excel file. Represents cumulative tonnage already dispatched per the file.
- If a structure has no dispatch entry (blank/null), dispatch is treated as **0** (nothing dispatched yet).
- If a structure's galvanising figure is null, its contribution is **0** (excluded entirely).
- Per-structure values are summed to give the per-project total shown in the table.

### Code location

`artifacts/tracker/src/pages/job-dashboard.tsx` — `orderByJob` useMemo:
```
agg.computedFg += r.fileGalvMt != null
  ? r.fileGalvMt - (r.fileDespatchMt ?? 0)
  : 0
```

The API route (`artifacts/api-server/src/routes/orderStatus.ts`) maps:
- `fileGalvMt` ← DB column `galv_mt` (table `order_review_rows`)
- `fileDespatchMt` ← DB column `file_despatch_mt` (table `order_review_rows`)

---

## Column 2: Finished Goods WIP — WIP file based

### Formula

```
FG WIP (kg) = Sum of Balance Weight (Col Q)
              for all rows where Type (Col A) = "FG PENDING FOR DISPATCH"
              for that project
```

- Collected during WIP file parsing (`artifacts/api-server/src/lib/parse.ts`, function `parseSheet`).
- Stored as `summary.fgWipByJob` (jsonb) on the `imports` row — read at display time, no extra API call.
- Units are **kg** (raw weight from the WIP file). The UI formats as kg / t depending on size.
- Keyed by raw project code (e.g. `"862"`), with the TLT/NTLT prefix stripped for lookup.

### Code location

`parse.ts`:
```typescript
if (rowType === "FG PENDING FOR DISPATCH") {
  fgWipByJob[fgProject] = (fgWipByJob[fgProject] ?? 0) + balanceWt;
}
```

`job-dashboard.tsx`:
```typescript
const fgWipForJob = (job: string): number =>
  fgWipByJob[job.replace(/^(?:TLT|NTLT): /, "")] ?? 0;
```

---

## Worked example: Project 862

### Order Review data (latest import)

| Structure | Galv MT | Despatch MT | FG Contribution (MT) |
|-----------|---------|-------------|----------------------|
| B02 | 0.808 | 0.808 | 0.000 |
| B03 | 10.666 | — | 10.666 |
| B03M | 0.681 | — | 0.681 |
| B06M | 1.518 | — | 1.518 |
| B302 | 0.880 | 0.880 | 0.000 |
| B303 | 11.024 | — | 11.024 |
| B6010M | 21.732 | — | 21.732 |
| B602 | 3.494 | 3.494 | 0.000 |
| B603 | 47.393 | — | 47.393 |
| B606M | 4.182 | — | 4.182 |
| E602 | 3.326 | 3.326 | 0.000 |
| E603 | 34.683 | — | 34.683 |
| E603M | 1.575 | — | 1.575 |
| E606M | 9.641 | — | 9.641 |
| MC602 | 1.464 | 1.464 | 0.000 |
| MC603 | 0.349 | — | 0.349 |
| NBB9010M | 1.002 | — | 1.002 |
| NBB902 | 7.741 | 7.741 | 0.000 |
| NBB902. | — | — | 0.000 |
| NBB902A | 3.873 | 3.873 | 0.000 |
| NBB902B | 3.281 | 3.281 | 0.000 |
| NBB903 | 29.420 | — | 29.420 |
| NBB904 | 0.129 | — | 0.129 |
| NBB906M | 6.969 | — | 6.969 |
| **Total** | **205.831** | **24.867** | **180.964** |

**Interpretation:**
- 8 structures (B02, B302, B602, E602, MC602, NBB902, NBB902A, NBB902B) have dispatch entries — these are fully dispatched from the Order Review book's perspective.
- The remaining 16 structures have been galvanised but show no dispatch entry in the file → their full galvanised tonnage counts as FG sitting in yard.
- **FG (MT) displayed = 180.964 MT** (shown as "~181 t" in the table after rounding).

### WIP file FG WIP for Project 862

From the latest WIP import (`imports.summary.fgWipByJob`):

```
"862": 64,953.307 kg  =  64.953 MT
```

This is the sum of Balance Weight (Col Q) for all **mark rows** (rows with a non-blank Mark No.) in the WIP file where the Type column (Col A) reads "FG PENDING FOR DISPATCH" and the Project Code (Col B) is 862. It reflects individual marks physically in the FG yard per the latest Balance Report, irrespective of what the Order Review file says.

> **Note on aggregate rows:** The WIP file also contains summary/subtotal rows with Type = "FG PENDING FOR DISPATCH" but no Mark No. (e.g. structure totals, project totals). These are excluded — only rows with a valid Mark No. are counted, so the figure equals the sum of individual mark weights.

### Why the two figures differ

| Figure | Project 862 | What it means |
|--------|-------------|---------------|
| FG (MT) — Order Review | 180.964 MT | Galvanised − dispatched per the Order Review book |
| FG WIP — WIP file | 64.953 MT | Balance weight of FG-pending marks in the WIP Balance Report |

The two figures use completely different data sources and different methodologies. They are both "in yard, not yet dispatched" estimates but measured at different granularities and from different teams' records. A gap between them is normal and expected — it reflects timing differences between when the Order Review is updated vs when the WIP file is generated.

---

## Key rules

1. **Order Review FG** uses structure-level tonnage from the Order Review (second) file — never touches WIP records, activity codes, or mark counts.
2. **FG WIP** uses mark-level balance weight from the WIP (first) file, filtered by the `Type = "FG PENDING FOR DISPATCH"` flag — never touches the Order Review file.
3. Neither figure changes the parse hash, ageing, or any other WIP computation — both are purely additive display overlays.
4. In **NTLT mode**, the Order Review file is TLT-only, so the FG (MT) column shows "−" for NTLT rows (no matching project key).
