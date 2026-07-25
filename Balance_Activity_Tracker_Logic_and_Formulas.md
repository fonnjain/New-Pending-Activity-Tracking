# Balance & Activity Tracker — Complete Logic & Formulas Reference

> **Scope:** Every deterministic rule, formula, and invariant that drives numbers in the app.  
> **Additive principle:** Advisory overlays (turnaround, velocity, stalled) never change parsing, Activity values, qty, dedup, ageing, or each other's thresholds.

---

## 1. Parsing Rules (`parse.ts`)

### 1.1 File Reading

- Reads `Sheet1`; falls back to the first sheet if `Sheet1` is absent.
- Columns are read **by header name, not by position**.
- Header auto-detect: scans the first ~10 rows for a cell containing `"Project Code"`; data starts on the very next row. Falls back to row 3 (historical) with a problem note if not found.

### 1.2 Format Detection (Old vs New)

| Format | Columns | Detection signal |
|--------|---------|------------------|
| Old (≤ Jun 2026) | 21 cols | No `"Type"` column |
| New (≥ Jul 2026) | 24 cols | Has `"Type"` column (col A) |

New format adds: `"Type"` (col A), `"Job Card Date"` (col F, ignored), `"Job Card Status"` (col G).  
`"WO Batch No."` renamed to `"Batch No."` (now col X). Parser accepts either name — extra columns silently ignored.

### 1.3 Project Code Forward-Fill

```
IF  Order Nature == "Structure"
    AND Project Code is blank
THEN  inherit the last non-blank Project Code
ELSE  job = "(Unassigned)"   ← RSJ POLE / EARTHING / GENERAL / blank / unknown Order Nature
```

`"794."` normalizes to `"794"`.  
`"(Unassigned)"` rows are excluded from `projectsFound` and must NOT borrow a project code.

### 1.4 Row Filtering

Only rows with a **non-empty Mark No.** are kept.  
`"FG Pending For Dispatch"` rows (new format `Type` column) are tallied in `parseSummary.fgWipByJob` / `fgWipByStructure` but **NOT inserted into `record_pool`**.

### 1.5 Mark Derivation — `deriveMark(row)` (Rules 0 → A → B → D → C)

**Rule 0 (pre-process, always):** Strip a single stray leading `-` from the alias (col G in old format / col H alias in new format). Read-time only; does not touch raw values or the hash.

**Rule A — Bare mark** (col H has no space or backslash, cols A and G are both empty):
```
mNo        = col H
markNumber = mNo
structure  = ""
```

**Rule B — IS / SC / S rows** (col G exactly `IS`, `SC`, or `S`). The only rows that have `proMno`. 4-part form:
```
project \ proMno \ structure \ mNo
```
- Strip prefix `"<A> <G>-"` from col H.
- Strip a leading `VT` only if it precedes inner project digits.
- If inner numeric token matches the project code, absorb it into `proMno`; else `proMno = "<G>"`.

**Rule D — Backslash form** (non-IS/SC; col H contains `\`):
```
structure = everything before the LAST backslash
mNo       = everything after the last backslash
3-part: project \ structure \ mNo
```

**Rule C — Space form** (non-IS/SC; col H contains `<A> <G>-<mNo>`):
```
Strip "<A> <G>-" prefix
structure = col G
mNo       = remainder (kept whole)
3-part: project \ structure \ mNo
```

**Aliases:**
- `structure` = `aliasCorrected`
- `markTail`  = `mNo`
- `markId`    = `markNumber`
- Change-log identity = `markId | jobCardNo`

### 1.6 Category Classification — `classifyMark(row)`

| Order Nature | `category` | `ntltSubtype` | `groupType` | `groupKey` | `active` |
|---|---|---|---|---|---|
| `Structure` | `TLT` | null | `project` | `job` | true |
| `RSJ POLE` | `NTLT` | `RSJ` | `section` | cleaned RSJ prefix | true |
| `EARTHING` | `NTLT` | `EARTHING` | `section` | normalized Section | true |
| `GENERAL` | `NTLT` | `GENERAL` | `section` | normalized Section | true |
| `FOUNDATION BOLT` | null | null | null | null | **false** |
| blank / unknown | `NTLT` | `GENERAL` | `section` | normalized Section | true |

Classification is **NOT hashed**; it is additive/display-only.

### 1.7 Row Hash — `hashRow(row)`

SHA-256 of exactly **21 raw source column values** (pre-normalization, pre-"Z" substitution):

```
job, orderNature, contractor, jobCardNo, towerType,
towerSubType/alias, markNo, section, length, width, wtPcs,
balanceQty, balanceWt, assignDate, operation, refJobCardNo,
activity, lastProductionDate, workOrderNo, mfcBatch (RAW pre-Z)
```

**NOT hashed** (changing these never creates a new pool row):
`category, ntltSubtype, groupType, groupKey, active, sectionType, holeOperation, holeOperationSource, fg, jobCardStatus, isInitialCutting`, and the mfcBatch `"Z"` substitution itself.

### 1.8 MFC Batch Normalization

```
mfcBatch = TRIM(UPPER(raw "WO Batch No." or "Batch No."))
IF mfcBatch == "" THEN mfcBatch = "Z"   ← sorts last; NOT hashed as "Z"
```

The **raw** (pre-"Z") value is what goes into the hash. A genuine batch change is a real change; the blank→"Z" display substitution is not.

### 1.9 `isInitialCutting` Flag

```
isInitialCutting = (jobCardStatus.toUpperCase() == "INITIAL")
```

Activity-independent. In the newer WIP format the `Activity` column holds the **planned** activity for scheduling, not the current production stage — a mark at `Activity=RFI + Status=Initial` has NOT started RFI; it is unreleased raw material already counted in Release Balance.

- Additive, NOT hashed.
- Defaults `false` for old-format rows (no Job Card Status column).
- Boot backfill (`backfillInitialCutting`) corrects existing DB rows on server startup.

### 1.10 Hole Operation Derivation

From the immutable `section` string (never hashed; stable across re-imports):

| Section family | Rule | Result |
|---|---|---|
| CHANNEL / BEAM / RSJ | Always | `DRILLING` |
| ANGLE / PLATE | thickness ≤ 12 mm | `PUNCHING` |
| ANGLE / PLATE | thickness > 12 mm | `DRILLING` |
| FLAT / PIPE / ROUND / GRATING / OTHER | — | `NOT_SET` |

Source: `holeOperationSource` = `"rule_fixed"` (CHANNEL/BEAM/RSJ) or `"rule_thickness"` (ANGLE/PLATE) or `"not_applicable"` (others).

---

## 2. Activity Sequences

### 2.1 TLT Canonical Sequence (`PROCESS_SEQUENCE`)

```
C → HG → RFI → NH → B → HAB → W → Q → TS → G → GB → Y
```

Single source of truth in `@workspace/domain`. Never re-define locally. Import and use `activityRank`, `compareActivity`, `sortActivities`.

Unknown codes rank **after** all known codes (sort to end); never dropped.

### 2.2 NTLT Sequences

| Key | Sequence |
|---|---|
| `NTLT_RSJ` | `NTF → NTFSW → NTFW → TS → G → GB → Y` |
| `NTLT_EARTHING` | `TS → G → GB → Y` |
| `NTLT_GENERAL` | `TS → G → GB → Y` |

All sequences end at `Y`. The common tail `TS → G → GB → Y` is shared.

### 2.3 Sequence Selection

```
sequenceFor(record):
  if category != "NTLT" => TLT (PROCESS_SEQUENCE)
  else switch ntltSubtype:
    "RSJ"      => NTLT_RSJ
    "EARTHING" => NTLT_EARTHING
    "GENERAL"  => NTLT_GENERAL
    default    => NTLT_GENERAL
```

### 2.4 Process Phases

| Phase | Activities (TLT) | Notes |
|---|---|---|
| `cutting` | `C` | First step |
| `quality` | `HG, RFI, NH, B, HAB, W, Q, TS` | TS is last fab step; **not** in galvanising |
| `galvanising` | `G, GB, Y` | Galvanising starts at `G`; spans through terminal `Y` |
| `dispatch` | (FG field, not activity) | From `Type="FG Pending For Dispatch"` rows in new-format WIP |

NTLT `quality` phase also includes `NTF, NTFSW, NTFW` (NTLT-only pre-galvanising steps).

---

## 3. Ageing Logic

### 3.1 Reference Date Selection

```
IF activity IN {C, NTF, NTFSW, BL}   ← pre-production activities
    referenceDate = assignDate
ELSE
    referenceDate = lastProductionDate
```

**Do NOT extend the assign-date fallback to non-pre-production rows.**

### 3.2 Ageing Days Calculation

```
IF referenceDate is blank / unparseable:
    ageingDays = null        ← excluded from all buckets and averages
ELSE:
    ageingDays = max(0, today - referenceDate)   ← future dates clamp to 0
```

Ageing is **live** (recomputed at read time). It is **never stored**.

### 3.3 Ageing Null Labels (Activity-Aware)

```
IF ageingDays == null:
    IF activity IN pre-production set AND assignDate is blank:
        label = "Not started"
    ELSE:
        label = "No production date"
```

### 3.4 Ageing Buckets

| Bucket | Condition |
|---|---|
| `0-30` | `ageingDays <= 30` |
| `31-60` | `31 <= ageingDays <= 60` |
| `60+` | `ageingDays > 60` |

Fixed buckets: green ≤ 30, amber 31–60, red > 60. Do **not** reuse ageing bucket colour classes (`ageing-*`) for turnaround status.

---

## 4. Turnaround Warning Engine (`@workspace/domain`)

### 4.1 Cumulative Target

```
cumulativeTarget(activity, settings, project):
    sequence = PROCESS_SEQUENCE (TLT) or NTLT sequence
    sum = 0
    FOR each step S in sequence UP TO AND INCLUDING activity:
        grace = resolveActivityGrace(settings, project, S)
        sum += grace.idealDays
    RETURN sum   ← total ideal days from step 1 through the mark's current activity
```

If `activity` is not in the sequence, returns `null` (=> status = `na`).

### 4.2 Grace Resolution — `resolveActivityGrace(settings, scope, step)`

Per-cell inheritance (not per-row):

```
base = settings.activities[step] ?? DEFAULT_ACTIVITY_CONFIG
override = settings.perProject[project]?.[step]   ← TLT; perSection for NTLT

effIdeal = override.idealDays ?? base.idealDays

FOR band IN {yellow, orange, red}:
    cell = override[band] ?? base[band]
    IF cell.mode == "auto":
        effectiveDays = round(cell.percent / 100 * effIdeal)
    ELSE:
        effectiveDays = cell.value

grace = {idealDays: effIdeal, yellowGrace, orangeGrace, redGrace}
APPLY normalizeGrace: yellowGrace <= orangeGrace <= redGrace (raise later bands)
```

**Defaults** (when no settings exist):
```
idealDays   = 3 days
yellowGrace = 7 days (manual)
orangeGrace = 21 days (manual)
redGrace    = 21 days (manual)
```

### 4.3 Alert Status — `alertStatus(ageingDays, activity, settings, scope)`

```
target  = cumulativeTarget(activity, settings, scope)
IF target == null OR ageingDays == null:
    RETURN { status: "na", target: null, overrun: null }

overrun = ageingDays - target
grace   = resolveActivityGrace(settings, scope, activity)

IF overrun <= 0:           RETURN "green"
IF overrun <= yellowGrace: RETURN "yellow"
IF overrun <= orangeGrace: RETURN "orange"
RETURN "red"
```

### 4.4 Lifecycle Status — 8-State Ladder (`lifecycleStatus`)

```
target      = cumulativeTarget(activity, settings, scope)
consumedPct = ageingDays / target * 100   ← only when ageingDays != null AND target > 0
preWarn     = resolvePreWarn(settings, scope, activity)   ← {pw1, pw2, pw3} percents

IF target == null OR ageingDays == null: RETURN "na"
overrun = ageingDays - target

IF overrun > 0:
    ← BREACH phase (overrun > 0, maps from alert bands)
    IF overrun <= yellowGrace: RETURN "breach1"
    IF overrun <= orangeGrace: RETURN "breach2"
    RETURN "breach3"
ELSE:
    ← WITHIN TARGET (overrun <= 0, classify by % consumed)
    IF consumedPct <  pw1: RETURN "green"
    IF consumedPct <  pw2: RETURN "prewarn1"
    IF consumedPct <  pw3: RETURN "prewarn2"
    RETURN "prewarn3"
```

Pre-warning invariant: `0 <= pw1 <= pw2 <= pw3 <= 100` (enforced on write by `orderPreWarn`).  
**Defaults:** `pw1 = 70%, pw2 = 85%, pw3 = 95%`.

### 4.5 Per-Project Overrides

TLT: `settings.perProject[project][activity]` — sparse; absent fields inherit global.  
NTLT: `settings.ntlt[RSJ|EARTHING|GENERAL].perSection[sectionKey][activity]` — same sparse inheritance.

Changing from global to per-project: only overridden cells/fields are stored.

---

## 5. Stalled Marks

### 5.1 Mark Stalled Definition

A mark is **stalled** when its **signature** (distinct activities + lastProductionDates) is **unchanged for ≥ `stalledDays`** consecutive days (cross-import comparison).

```
signature = { activity, lastProductionDate }
stalled = signature[import_N] == signature[import_N-1]
          AND (reportDate[N] - reportDate[N-1]) >= stalledDays
```

### 5.2 Rules

- `GET /api/imports/{id}/movement` computes stalled marks.
- Frontend `lib/movement.ts` joins by identity (`markId|jobCardNo`).
- **Never flags stalled when `hasHistory == false`** (mark only seen in one import).
- Default `stalledDays = 10`.

### 5.3 Stuck Score

```
stuckScore(mark) = stalledWeight + slowWeight
```

Used to rank the Stuck Projects leaderboard.

---

## 6. Velocity (`@workspace/domain`)

### 6.1 Per-Mark Velocity — `velocityForMark(snapshots)`

```
pace = (weightAtLatest - weightAtEarliest) / daysBetween   ← MT/day change
```

Requires ≥ 2 snapshots with the same mark identity. `< 2` snapshots → `status = "insufficient"`.

### 6.2 ETA Calculation

```
IF pace > 0:
    eta = today + (currentWeight / pace)   ← days until weight reaches zero
    eta_gap = eta - plannedReadyDate
ELSE:
    eta = null
    eta_gap = null
```

### 6.3 Status Classification

| Status | Condition |
|---|---|
| `insufficient` | < 2 snapshots |
| `moving` | pace above threshold |
| `slow` | pace positive but below threshold |
| `stalled` | pace <= 0 (no movement) |

### 6.4 Aggregate Velocity

Aggregate pages (e.g. Overview, Stuck Projects) recompute velocity rollups from **filter-scoped items** so that header filters (job, contractor, activity, etc.) are honoured. Velocity data is kept **out** of `/records` (the 28 MB payload) — it has its own endpoint: `GET /api/imports/{id}/velocity`.

---

## 7. Project Milestones (`milestones.ts`)

### 7.1 Milestone Definitions

| Milestone | Code | Condition |
|---|---|---|
| M1 Ready for Dispatch | `readyDate` | First import where **no mark** in the project is at an activity earlier than `Y` (all marks ≥ Y or gone) |
| M2 Dispatched | `dispatchedDate` | First import where the project is **entirely absent** |

`blocksReady(record)` uses `sequenceFor(record)` — NTLT-only steps (e.g. `NTF`) correctly block readiness.

### 7.2 Capture-Once Rule

```
recomputeMilestones():
    FOR each import IN ORDER (id ASC):
        replay marks present in this import
        IF M1 not captured AND all marks >= Y:
            capture readyDate = import.reportDate
        IF M2 not captured AND project absent:
            capture dispatchedDate = import.reportDate
    MATERIALIZE: union of replayed + stored rows
    ← stored milestone dates always win (permanent)
```

Earliest qualifying import always wins. A later partial file cannot move a captured date. Idempotent: replaying the same history produces the same result.

**Edge cases:**
- Straight-to-absent: stamps M1 at the dispatch date (lag = 0).
- `limitedHistory`: captured with no prior in-progress observation.
- `reopened`: a mark returned to an earlier activity after milestone capture.

### 7.3 Derived Figures

```
projectStart         = min(assignDate) across all marks ever seen for the project
readyTurnaroundDays  = max(0, readyDate - projectStart)
dispatchedTurnaroundDays = max(0, dispatchedDate - projectStart)
dispatchLagDays      = dispatchedTurnaroundDays - readyTurnaroundDays
plannedReadyDays     = cumulativeTarget("Y", settings, project)
varianceReadyDays    = readyTurnaroundDays - plannedReadyDays   ← + = slower than planned
```

---

## 8. Upload & Merge Logic (`diff.ts`)

### 8.1 Concurrency Safety

```
BEGIN TRANSACTION
LOCK pg_advisory_xact_lock(728041)   ← serializes all uploads app-wide
... parse + pool insert + import_rows insert ...
COMMIT
```

### 8.2 Pool Insert (Dedup)

```
FOR each parsed row:
    INSERT INTO record_pool (...) ON CONFLICT (hash) DO NOTHING
    IF inserted: poolId = new id
    ELSE: poolId = SELECT id FROM record_pool WHERE hash = ?

INSERT INTO import_rows (importId, poolId, copies)
```

### 8.3 Change Log (vs Previous Import)

```
identity = markId | jobCardNo

For each identity present in BOTH imports:
    IF activity changed:   movedActivity++
    IF balanceQty or balanceWt changed:  qtyChanged++

For each identity in NEW import but NOT in previous: newMarks++
For each identity in PREVIOUS import but NOT in new: completed++

Conservation check: added + unchanged == rowsKept
```

### 8.4 Direct vs Staged Upload

| Path | Steps |
|---|---|
| Direct | `POST /imports` → parse → merge → commit |
| Staged | `POST /imports/stage` → `POST /imports/validate` (Claude) → `POST /imports/commit` |

**Commit is idempotent:** checks `committedImportId` on the staging row; a retried commit returns the same import.  
Concurrent commits serialize in `mergeImport()`'s lock; only one wins the atomic claim.  
Committed staged rows cleaned by 24-hour TTL.

### 8.5 Sanitize Invariant (`isTruncatingCleanup`)

```
isTruncatingCleanup(from, to):
    tokenize both strings (alphanumeric runs only)
    RETURN from.tokens != to.tokens
```

A cleanup is **dropped** unless `from` and `to` share the **same alphanumeric token sequence**. Prevents Claude from abbreviating or rewriting names. Date fields are exempt.

---

## 9. Generated Order Review (Client-Side)

Computed entirely client-side in `data.tsx`. No server call.

### 9.1 Key Sets

```
GEN_FAB_BAL  = {C, HG, RFI, NH, B, HAB, W, Q, TS}    ← pre-galvanising activities
GEN_FAB_PROG = {RFI, NH, B, HAB, W, Q, TS}            ← fab progress (post-cutting)
GEN_GALV_BAL = {G, GB}                                 ← galvanising (excl. Yard)
```

### 9.2 Record Sets

```
marks   = ALL records for (project, structure)
nonInit = marks.filter(r => !r.isInitialCutting)   ← RELEASED marks only
init    = marks.filter(r => r.isInitialCutting)     ← unreleased (Status=Initial)
```

### 9.3 Column Formulas

All tonnage values = `sum(balanceWt) / 1000` (kg → MT), rounded to 3 dp.

| Column | Label | Formula | Record set |
|---|---|---|---|
| L | Release Balance | `sum(init.balanceWt) / 1000` | `init` (unreleased) |
| M | Fab Progress | `sum(nonInit where activity IN GEN_FAB_PROG) / 1000` | `nonInit` |
| T | Balance Fabrication | `sum(nonInit where activity IN GEN_FAB_BAL) / 1000` | `nonInit` |
| N | Balance Galvanizing | `sum(nonInit where activity IN GEN_GALV_BAL) / 1000` | `nonInit` |
| V | Balance Inspection | `sum(nonInit where activity != "Y") / 1000` | `nonInit` |
| — | Dispatched (Yard) | `sum(nonInit where activity == "Y") / 1000` | `nonInit` |

**Critical fix (Jul 2026):** `isInitialCutting` is now `Status=INITIAL` for **any** activity. Previously it was `Activity=C AND Status=INITIAL`, which missed non-C planned-activity marks, inflating Balance Fabrication by counting unreleased marks as released pending fab.

### 9.4 Cross-Check Against Actual OR

Generated figures are cross-checked against the actual Order Review file columns at a 1% tolerance + small absolute floor.

---

## 10. Order Review Dispatch (`orderReview.ts`)

### 10.1 Two-Layer Dispatch

```
computedDispatch(project, structure) = seedMt + accruedMt
```

**seedMt:** One-time baseline from the **first** Order Review file's `Despatch MT` (col P) for that key. Capture-once; never re-seeded.

**accruedMt:** Sum of all Y-departure deltas from WIP imports **after** `seedImportId`:

```
FOR each consecutive WIP import pair (prev, curr) after seedImportId:
    departed = marks at Y in prev that are ABSENT in curr
    accruedMt += sum(departed.balanceWt) / 1000
```

### 10.2 Dispatch Ledger

Append-only audit trail. Every delta (seed or wip_departure) logged with `entryDate`, `deltaMt`, `runningMt`. Rebuilt deterministically on each recompute (idempotent).

---

## 11. Contractor Movement Ledger

### 11.1 Movement Credit Rule

```
FOR each consecutive WIP import pair:
    FOR each mark where activity changed from actA to actB:
        credit delta weight to the contractor AT activity actA (the FROM contractor)
        entryDate = reportDate of the LATER import
```

### 11.2 Fab/Galv Stage Derivation

```
stage(fromActivity):
    IF fromActivity == "TS": stage = "GALV" (leaving Tee Stock => entering Galvanizing)
    IF fromActivity == "Y":  stage = "YARD"
    ELSE:                    stage = "FAB"
```

### 11.3 Scope

Marks whose **current contractor is blank** are excluded from Contractor Performance entirely — a blank contractor means the mark is now with VTPL, and its full move history is excluded, not just its current state.

---

## 12. Thickness Resolution

Live-resolved at read time (never hashed or stored on `record_pool`):

```
resolveThickness(markId, section):
    1. Manual pin:  manual_thickness WHERE markId = ?  → highest priority
    2. Section derive: parse section string (e.g. "ISA 75x75x6" → 6 mm)
    3. RSJ lookup: rsjThickness WHERE section prefix matches
    4. Unset: null
```

DELETE endpoints use **query params** (not path segments) for `markId`/`groupKey` because backslashes and spaces in these values break URL path routing.

---

## 13. Fabrication Load Route Guard

The "In Hand" (upcoming) fab load for an operation (W or B) counts a mark only if:

```
routeIncludesOp(mark.operation, op):
    IF operation is blank / null:  RETURN true   ← don't exclude; no route info
    ops = parse operation string (comma-split, intersect with standard activity codes)
    RETURN op IN ops
```

**Blank Col Q falls back to include** (conservative). A non-blank route that simply doesn't list the op returns `false` — that mark legitimately never performs the operation.

---

## 14. Turnaround Settings Migration

`migrateTurnaroundSettings(raw)` accepts **every legacy shape**:

| Legacy shape | Outcome |
|---|---|
| Old flat `{idealDays, yellowMax, orangeMax, overrides}` | Converted to per-activity MANUAL cells |
| Previous numeric grace `yellowGrace` / `orangeGrace` | Converted to `{mode:"manual", value:N}` |
| New cell shape `{mode, percent?, value?}` | Passed through as-is |

Consumers call `migrateTurnaroundSettings(settings)` defensively before classifying any mark.

---

## 15. Invariants (Must Never Break)

| # | Invariant |
|---|---|
| 1 | **Strictly additive.** No overlay changes parsing, Activity values, qty, dedup/hash identity, or ageing math. TLT behaviour is byte-for-byte unchanged across additions. |
| 2 | **Hash = 21 source columns only.** Derived/classification/thickness/MFC-normalization fields excluded from hash. |
| 3 | **No within-file dedup.** In-sheet duplicate rows = separate pending units (`copies`). Dedup is cross-upload only (via `hash`). |
| 4 | **Live ageing, never stored.** Activity `C` ages from `assignDate`; every other activity ages from `lastProductionDate`. Do NOT extend assign-date fallback to non-pre-production rows. Future dates clamp to 0; blank → null. |
| 5 | **Append-only merge.** Each upload = one immutable import. Re-upload is idempotent. Pool rows are permanent; deleting an import cascades only `import_rows`. |
| 6 | **Canonical activity order.** PROCESS_SEQUENCE is the single source of truth. Never re-define a local order array or sort activities alphabetically anywhere. |
| 7 | **Conservation.** `added + unchanged == rowsKept` (self-check on every import). |
| 8 | **Milestone capture-once.** Earliest qualifying import always wins. Stored milestone dates always win on merge. |
| 9 | **Client-side aggregation.** All KPIs/buckets/breakdowns computed client-side. No aggregation endpoints. |
| 10 | **`isInitialCutting = Status=INITIAL` (any activity).** Not activity-gated. Released marks = `isInitialCutting == false`. |
| 11 | **Large responses compressed.** `/records` must pass through `compression()` middleware; uncompressed ~28 MB causes proxy 500. |
| 12 | **Date display: dd-mm-yyyy.** Every user-facing date rendered via `formatDate()` / `formatDateTime()` helpers. Export column labels (raw ISO) are the intentional exception for spreadsheet consumers. |
| 13 | **No emojis in UI.** |

---

## 16. Settings Defaults Reference

| Setting | Default value |
|---|---|
| `idealDays` per activity | 3 days |
| `yellowGrace` | 7 days (manual cell) |
| `orangeGrace` | 21 days (manual cell) |
| `redGrace` | 21 days (manual cell) |
| `pw1` (pre-warn 1) | 70% of cumulative target |
| `pw2` (pre-warn 2) | 85% of cumulative target |
| `pw3` (pre-warn 3) | 95% of cumulative target |
| `stalledDays` | 10 days |
| `validFromDate` | null (no cutoff) |

---

## 17. Key Code Locations

| Topic | File |
|---|---|
| Activity sequences, bundles, turnaround engine, velocity, milestones math | `lib/domain/src/index.ts` |
| Excel parse, hash, row derivation, category classify | `artifacts/api-server/src/lib/parse.ts` |
| Import merge, change log, dedup | `artifacts/api-server/src/lib/diff.ts` |
| Milestone recompute | `artifacts/api-server/src/lib/milestones.ts` |
| AI sanitize + gatekeeper | `artifacts/api-server/src/lib/ai.ts` |
| Boot backfills (classification, isInitialCutting, holeOperation) | `artifacts/api-server/src/lib/backfill.ts` |
| API routes (imports, settings, milestones) | `artifacts/api-server/src/routes/` |
| Generated Order Review (client-side formulas) | `artifacts/tracker/src/pages/data.tsx` |
| Ageing helpers + PRE_PRODUCTION_ACTIVITIES | `artifacts/tracker/src/lib/ageing.ts` |
| Turnaround classification (frontend) | `artifacts/tracker/src/lib/turnaround.ts` |
| Velocity (frontend) | `artifacts/tracker/src/lib/velocity.ts` |
| Stalled / movement (frontend) | `artifacts/tracker/src/lib/movement.ts` |
| Global filter store | `artifacts/tracker/src/lib/store.tsx` |
| DB schema | `lib/db/src/schema/` |
| API contract | `lib/api-spec/openapi.yaml` |
| Theme + colour scales | `artifacts/tracker/src/index.css` |
