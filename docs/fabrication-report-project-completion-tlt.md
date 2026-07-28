# Fabrication Report – Project Completion (TLT)

**Route:** `GET /api/reports/fabrication-project-completion-tlt`  
**Frontend page:** Reports → Fabrication Report – Project Completion - TLT  
**Scope:** TLT (Transmission Line Tower) marks only, latest WIP import only

---

## 1. Purpose

This report answers: *"For each project and structure type, how much weight (MT) remains at each fabrication stage right now?"*

It shows the pending balance at every step in the TLT fabrication sequence — from the moment a mark enters the system as unreleased material, through every machining operation, to final quality check — grouped by project, BOM Label, and Sub-Type.

---

## 2. Data Sources

The report draws from **five database tables**, all read-only from the perspective of this endpoint:

| Table | What it holds | Populated by |
|---|---|---|
| `imports` | One row per WIP file upload; gives the latest import ID | WIP file ingest |
| `record_pool` | Every distinct mark row ever seen (append-only, hash-deduplicated) | WIP file ingest |
| `import_rows` | Junction: which pool rows belong to a given import (`import_id → pool_id`) | WIP file ingest |
| `release_balance_wip` | Pre-computed Release Balance per `(import_id, project, structure)` in MT | Computed post-ingest |
| `assignment_balance_wip` | Pre-computed Assignment Balance per `(project, structure)` in MT | Computed post-ingest |
| `order_review_rows` | Live order-book snapshot: one row per `(project, structure)`, includes `bom_type` | Order Review file ingest (UPSERT) |

---

## 3. Database Schema

### 3.1 `imports` — WIP upload log

```
id            serial PRIMARY KEY
source_filename  text NOT NULL
report_date   date                     -- date stamped on the WIP file banner
as_on_date    date                     -- used to pair WIP with Order Review
summary       jsonb                    -- parse stats (rowsRead, rowsKept, …)
created_at    timestamptz NOT NULL
```

**Used by this report:** only `id`, ordered `DESC LIMIT 1` to find the latest import.

---

### 3.2 `record_pool` — permanent mark store

```
id                serial PRIMARY KEY
hash              text UNIQUE NOT NULL   -- full-row hash; dedup key
job               text NOT NULL          -- project / job code  (WIP Col B)
structure         text NOT NULL          -- structure alias      (WIP Col I / derived)
mark_tail         text NOT NULL
mark_id           text NOT NULL
order_nature      text                   -- Col C: "Structure" | "RSJ POLE" | …
contractor        text                   -- Col D
tower_type        text                   -- Col H
tower_sub_type    text                   -- Col I: "STUB" | "SST" | …
mark_no           text NOT NULL          -- Col J
section           text
balance_qty       double precision NOT NULL
balance_wt        double precision NOT NULL  -- pending weight in KG  (WIP Col Q)
assign_date       date                   -- Col R
last_production_date date               -- Col S: drives ageing
activity          text                   -- Col E: current stage code
job_card_status   text                   -- Col G: "Initial" | "Authorized"
is_initial_cutting boolean NOT NULL DEFAULT false
                                         -- true when Col G = "Initial"
                                         -- (mark is unreleased; counted in Release Balance)
category          text                   -- "TLT" | "NTLT" | null
mfc_batch         text                   -- Col U: MFC batch letter
```

**Key fields for this report:** `job`, `structure`, `tower_sub_type`, `balance_wt`, `activity`, `is_initial_cutting`, `category`.

---

### 3.3 `import_rows` — import ↔ pool membership

```
import_id  integer NOT NULL  REFERENCES imports(id) ON DELETE CASCADE
pool_id    integer NOT NULL  REFERENCES record_pool(id)
copies     integer NOT NULL  -- how many identical rows appeared in the sheet
PRIMARY KEY (import_id, pool_id)
```

This is the JOIN bridge: `import_rows` scopes the pool to a specific upload.  
Every balance query in this report does:

```sql
FROM   import_rows ir
JOIN   record_pool rp ON rp.id = ir.pool_id
WHERE  ir.import_id = <latest_id>
  AND  rp.category  = 'TLT'
  AND  <activity filter>
```

---

### 3.4 `release_balance_wip` — Release Balance snapshot

```
import_id                 integer NOT NULL DEFAULT 0
project                   text    NOT NULL
structure                 text    NOT NULL
release_balance_computed_mt  double precision NOT NULL DEFAULT 0
updated_at                timestamptz NOT NULL
UNIQUE INDEX on (import_id, project, structure)
```

**How populated:**  
After each WIP ingest, `recomputeReleaseBalance()` scans the import for rows where `is_initial_cutting = true` (equivalent to `Job Card Status = "Initial"`), sums their `balance_wt / 1000`, and UPSERTS one row per `(import_id, project, structure)`.

**Why per-import:**  
Scoping to `import_id = latestImport.id` ensures that viewing an older import snapshot shows *that file's* Release Balance, not today's.

---

### 3.5 `assignment_balance_wip` — Assignment Balance snapshot

```
project                      text    NOT NULL
structure                    text    NOT NULL
assignment_balance_computed_mt  double precision NOT NULL DEFAULT 0
updated_at                   timestamptz NOT NULL
PRIMARY KEY (project, structure)
```

**How populated:**  
After each WIP ingest, the parser scans for rows where `Col A (Type) = "Job Card Not Started"` AND `Col D (Contractor)` is blank. Their `balance_wt / 1000` is summed and the table is replaced wholesale (DELETE + re-insert). It always reflects the **latest file only** — it is not versioned by import.

> **Overlap note:** `release_balance_wip` rows (JCNS + Initial) also have a blank contractor, so they are counted in *both* Release Balance and Assignment Balance. This is intentional: they represent two different business lenses on the same marks.

---

### 3.6 `order_review_rows` — live order-book

```
id          serial PRIMARY KEY
import_id   integer NOT NULL          -- import in which this key was LAST SEEN
project     text    NOT NULL
structure   text    NOT NULL
sub_type    text
sets        integer
weight_mt   double precision          -- col G: total order qty weight (MT)
wo_order_qty_mt double precision      -- col J: work-order qty (base for balances)
bom_type    text                      -- "Proto" | "Mass" | "Pre" | null
release_mt  double precision
fab_mt      double precision
galv_mt     double precision
inspection_mt double precision
file_despatch_mt double precision
UNIQUE INDEX on (project, structure)
```

**Used by this report:** `bom_type` only — to classify each `(project, structure)` as Proto / Mass / Pre / Mixed / Unknown.

---

## 4. Column Definitions & Calculation Logic

All weights are in **MT (metric tonnes)**. The source column in the WIP file stores weights in **kg** (`balance_wt`); every query divides by 1 000.

### 4.1 Pre-Production columns

These represent marks that have **not yet entered physical production**.

#### Release Balance Calc (MT)

> *"How much weight is sitting as unreleased Job Cards?"*

**Source table:** `release_balance_wip`  
**Filter:** `import_id = latestImport.id`  
**Grouping:** pre-aggregated to `(project, structure)` at ingest time

```
Release Balance = SUM(balance_wt / 1000)
  WHERE is_initial_cutting = true
  (≡ Job Card Status = "Initial")
  for this import_id
```

Marks with `Status = Initial` are scheduled on the WIP file but have **not been physically released to the floor** yet. They carry a planned activity code (e.g., `RFI`) but that code reflects the *intended* first operation, not the current production state.

---

#### Assignment Balance Calc (MT)

> *"How much weight is on a Job Card Not Started with no contractor assigned?"*

**Source table:** `assignment_balance_wip`  
**Filter:** none (always latest file)  
**Grouping:** pre-aggregated to `(project, structure)` at ingest time

```
Assignment Balance = SUM(balance_wt / 1000)
  WHERE Type (Col A) = "Job Card Not Started"
  AND   Contractor (Col D) IS BLANK
```

These marks have a job card raised but no contractor has been assigned to work on them. The overlap with Release Balance is intentional (see §3.5).

---

### 4.2 Fabrication Stage Balance columns

These represent marks that **have been released and are physically in-progress** at a given stage. All sourced live from `import_rows JOIN record_pool`, scoped to the latest import and TLT category.

```sql
SELECT
  rp.job          AS project,
  rp.structure,
  UPPER(rp.activity) AS activity,
  COALESCE(SUM(rp.balance_wt) / 1000.0, 0) AS balance_mt
FROM   import_rows   ir
JOIN   record_pool   rp ON rp.id = ir.pool_id
WHERE  ir.import_id  = <latestImportId>
  AND  rp.category   = 'TLT'
  AND  UPPER(rp.activity) IN (<activity filter>)
GROUP BY rp.job, rp.structure, UPPER(rp.activity)
```

The `balance_wt` field (Col Q of the WIP file) represents the **remaining pending weight for that mark at its current stage**.

---

#### Cutting (C)

```
Cutting Balance = SUM(balance_wt / 1000)
  WHERE UPPER(activity) = 'C'
  AND   is_initial_cutting = false
```

The `is_initial_cutting = false` guard excludes marks whose `Status = Initial` (they are already counted in Release Balance above and have not actually started cutting).

---

#### HG (Hot-Dip Galvanising / Hole Galvanising)

```
HG Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'HG'
```

---

#### RFI (Roll Form / Fitting Item)

```
RFI Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'RFI'
```

---

#### NH (Notching / Hole-making)

```
NH Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'NH'
```

---

#### B (Bending) — part of Special Operations

```
B Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'B'
```

---

#### HAB (Hot/Cold Assembly Bending) — part of Special Operations

```
HAB Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'HAB'
```

---

#### W (Welding) — part of Special Operations

```
W Balance = SUM(balance_wt / 1000)  WHERE UPPER(activity) = 'W'
```

> **Special Operations (collapsed view):** B + HAB + W are shown combined by default as `Special Ops`. Click the column header (▶) to expand into individual B / HAB / W columns. Click ◀ on the B header to collapse again.

---

#### Quality Check / Q+TS (MT)

```
Quality Check Balance = SUM(balance_wt / 1000)
  WHERE UPPER(activity) IN ('Q', 'TS')
```

`Q` = Quality inspection; `TS` = Test/Sign-off. These are the final hold-points before a mark moves to Galvanising.

---

### 4.3 TLT process sequence in order

```
C  →  HG  →  RFI  →  NH  →  B  →  HAB  →  W  →  Q / TS  →  [Galvanising: G / GB / Y]
```

The report columns follow this left-to-right sequence. A mark's `balance_wt` appears in exactly one column (its current `activity`).

---

## 5. Row Grouping & Sorting

### 5.1 BOM Label (from Order Review)

Each `(project, structure)` is classified by looking up its `bom_type` in `order_review_rows`:

| Condition | BOM Label |
|---|---|
| No Order Review loaded, or no matching row | **Unknown** |
| Exactly one distinct `bom_type` found | That value — `Proto` / `Mass` / `Pre` |
| Two or more distinct `bom_type` values | **Mixed** |

**Sort order:** Proto → Mass → Pre → Mixed → Unknown

---

### 5.2 Sub-Type Group (from WIP Col I)

The `tower_sub_type` field is normalised (trim, uppercase, strip dots/spaces/hyphens) and bucketed:

| Raw value (normalised) | Group |
|---|---|
| `STUB` | **STUB** |
| `SST` | **SST** |
| Anything else (or blank) | **Other** |

**Sort order within a BOM Label:** STUB → SST → Other

---

### 5.3 Project

Sorted alphabetically within each Sub-Type group.

---

### 5.4 Aggregation

All weights for structures that share the same `(project, BOM Label, Sub-Type Group)` key are **summed**. One output row per unique combination.

---

### 5.5 Unknown threshold filter

Projects whose **total combined weight** across all Unknown-label rows is **< 1.0 MT** are hidden from the table entirely. Projects ≥ 1.0 MT are shown, with a cause footnote explaining each unmatched structure:

- **Code mismatch** — an Order Review structure exists under a slightly different code (leading numeric prefix, trailing `-word` suffix, or leading dash)
- **Absent** — no plausible Order Review counterpart found

---

## 6. Grand Totals & Subtotals

The table has three tiers of aggregation:

| Level | Row type | Computation |
|---|---|---|
| Structure level | Data row | Single `(project, BOM Label, Sub-Type)` |
| Sub-Type subtotal | Grey row | Sum of all project rows within a Sub-Type group |
| BOM Label total | Bold row | Sum of all Sub-Type subtotals for the BOM label |
| Grand Total | Footer | Sum of all BOM label totals |

---

## 7. Execution Plan (what queries run)

Six queries run **in parallel** on every request:

```
1. SELECT MAX(id) FROM imports                          → latest import ID

2. SELECT job, structure, MAX(tower_sub_type)
   FROM import_rows JOIN record_pool
   WHERE import_id=? AND category='TLT'
   GROUP BY job, structure                              → all TLT (project, structure) pairs

3. SELECT job, structure, SUM(balance_wt)/1000
   FROM import_rows JOIN record_pool
   WHERE import_id=? AND category='TLT'
     AND UPPER(activity)='C' AND is_initial_cutting=false
   GROUP BY job, structure                              → Cutting balance

4. SELECT job, structure, UPPER(activity), SUM(balance_wt)/1000
   FROM import_rows JOIN record_pool
   WHERE import_id=? AND category='TLT'
     AND UPPER(activity) IN ('HG','RFI','NH','B','HAB','W','Q','TS')
   GROUP BY job, structure, UPPER(activity)             → HG/RFI/NH/B/HAB/W/Q/TS balances

5. SELECT * FROM release_balance_wip
   WHERE import_id=?                                    → Release Balance (pre-computed)

6. SELECT * FROM assignment_balance_wip                 → Assignment Balance (pre-computed)

   + loadLatestOrderReview()                            → BOM types for labelling
```

After the queries complete, all results are **joined in application memory** using `Map<"project\x01structure", value>` keyed by a composite string. No cross-table SQL JOIN is used; correctness is maintained by the common `(project, structure)` identity.

---

## 8. Caveats & Edge Cases

| Situation | Behaviour |
|---|---|
| No WIP import exists | `available: false`; all rows/totals empty |
| Structure in WIP but not in Order Review | BOM Label = **Unknown** |
| Mark has `is_initial_cutting = true` | Counted in **Release Balance only**; excluded from Cutting balance |
| Assignment Balance overlaps Release Balance | Intentional — two separate business lenses |
| `assignment_balance_wip` has no import-scope | Always shows **latest file** regardless of which import is selected on other pages |
| `release_balance_wip` import_id = 0 (legacy rows) | Never matched by `WHERE import_id = <realId>`; effectively invisible |
| Multiple structures share the same project+BOM+subType | Their weights are **summed** into one row |

---

## 9. Frontend Behaviour

### Project filter

A checkbox panel above the table lets users select specific projects. `null` = all selected (default). The selection resets whenever the global job filter changes.

### Collapsible Special Operations

B, HAB, and W columns can be collapsed into a single **Special Ops** column (default). Click `▶` on the header to expand; click `◀` on the B header to collapse. The column count changes from 11 (collapsed) to 13 (expanded).

### Excel export

The **Export Excel** button exports the fully-expanded table (all 13 columns, B/HAB/W split) with a Totals row. Column labels match the on-screen headers.

### Pre-Production columns

Shown in **indigo** to visually separate them from the amber fabrication-stage columns.

---

## 10. File Locations

| Concern | File |
|---|---|
| API route & calculation logic | `artifacts/api-server/src/routes/fabricationProjectCompletion.ts` |
| DB schema — record pool | `lib/db/src/schema/recordPool.ts` |
| DB schema — import membership | `lib/db/src/schema/importRows.ts` |
| DB schema — imports | `lib/db/src/schema/imports.ts` |
| DB schema — release balance | `lib/db/src/schema/releaseBalanceWip.ts` |
| DB schema — assignment balance | `lib/db/src/schema/assignmentBalanceWip.ts` |
| DB schema — order review | `lib/db/src/schema/orderReview.ts` |
| API types | `lib/api-client-react/src/generated/api.schemas.ts` |
| Frontend table & export | `artifacts/tracker/src/pages/reports.tsx` → `FabCompletionReport` |
| Release balance computation | `artifacts/api-server/src/lib/parseWipReleaseBalance.ts` |
