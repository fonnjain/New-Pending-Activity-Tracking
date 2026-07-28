# Replit Agent — Fix Prompts
### Balance & Activity Tracker, derived from the audit of 21–26 July 2026

---

## How to use this

Paste **one prompt at a time** and let it finish before starting the next. They are
ordered by severity and by dependency — Fix 1 must land before the reconciliation check
can be trusted to validate anything else.

**Two working notes learned the hard way during the audit:**

1. **The Agent times out on broad questions.** Each prompt below is deliberately scoped
   to one file or one function. Do not merge them.
2. **The Agent is reliable when it pastes source and unreliable when it describes it.**
   It mis-stated the same regex three times and twice claimed FG rows were absent from
   `record_pool` when the on-screen numbers prove they are present. **Every prompt below
   ends by asking it to paste the changed lines verbatim.** Read the paste, not the
   summary.

After each fix, re-check project **920** on Project Wise. Its verified 26-Jul figures:

| | |
|---|---|
| Pending marks | 2,108 |
| Balance Wt | 213.732 MT |
| Balance Qty | 64,793 |
| Release Balance | 7.758 MT |
| Cutting | 51.483 MT |
| Quality Check | 108.970 MT |
| Galvanising | 32.445 MT |
| FG WIP | 13.077 MT (215 marks) |
| **Five-bucket total** | **213.732 MT** |

---

## FIX 1 — FG is excluded from the phase total, causing a permanent false alarm
### Severity: highest. Do this first.

```
The Project Wise page shows a "Bucket reconciliation mismatch" warning that is a false
alarm on every project holding finished goods. Please fix it.

The bug: bucketTotal = allPhasesWt + relBalKg, where allPhasesWt sums only
cutting + quality + galvanising + dispatch. The dispatch phase is declared with
activities: [] so it is always zero. But the right-hand side, totalWt, is
filtered.reduce((s, r) => s + r.balanceWt, 0) over record_pool rows — and FG Pending For
Dispatch rows ARE in record_pool. So FG weight is on the right side of the comparison and
missing from the left, and the reported shortfall always equals the FG weight exactly.

Please note two things that have been measured directly from the source files, because
earlier descriptions of this area were wrong:

  - FG rows DO carry a Mark No. All 8,337 FG rows in WIP_26-07-2026 have one (sample
    values "01", "1"). They are ordinary mark rows and they are in record_pool. Any
    reasoning that starts from "FG rows have no Mark No. and fall out of the parse loop"
    is incorrect.
  - Blank activity and Type = "FG PENDING FOR DISPATCH" select exactly the same 8,337
    rows / 2,759.459 MT on this file. Zero rows are blank-but-not-FG, zero are
    FG-but-not-blank. Either condition works today; they are not guaranteed to stay
    equivalent.

Verified at both levels for the 26-Jul import:

  Project 920 (Order Type = TLT):
    Cutting 51.483 + Quality 108.970 + Galvanising 32.445 + Release Balance 7.758
      = 200.656
    Total Balance = 213.732
    Shortfall 13.077 = project 920's FG weight (215 marks), to the kilogram.

  Whole portfolio (Order Type = TLT):
    Cutting 2,237.924 + Quality 2,013.819 + Galvanising 2,107.611
      + Release Balance 2,557.619 = 8,916.973
    Total Balance = 10,969.555
    Shortfall 2,052.582 = total TLT FG weight, to the kilogram.

Please do three things:

1. Include FG in the phase total so both sides cover the same population. Prefer routing
   blank-activity rows into the existing dispatch phase in PROCESS_PHASES over
   special-casing FG in the sum, so FG flows through the same phase mechanism as every
   other bucket. The dispatch phase already exists with activities: [] and appears to
   have been left as a placeholder for exactly this. If that route is not safe, add
   fgWip into allPhasesWt instead and explain why.

2. Make sure the fix respects the Order Type filter. TLT FG is 2,052.582 MT, but total
   blank-activity weight in the file is 2,759.459 MT — the extra 706.877 MT sits in just
   35 NTLT rows (RSJ POLE / EARTHING / GENERAL, averaging about 20 MT each). Whatever
   population totalWt covers for a given filter state, the phase total must cover the
   same one. Please verify the reconciliation holds with Order Type set to All, to TLT,
   and to NTLT — not only TLT.

3. Rewrite the warning text. It currently says the cause is "usually Release Balance
   figures are from a different import" and advises re-uploading the WIP file. That is
   wrong and the advice cannot work. Project 920's Release Balance is 7.758 MT unchanged
   across the 21, 22, 23, 24 and 26 July files, and portfolio Release Balance is only
   2,557.619 MT in total, so it could not produce a 2,052.582 MT gap under any
   circumstance. The message should state the computed difference and not assert a cause.

Do not change any bucket definition or any figure that currently displays correctly. In
particular do not alter how FG itself is measured — only where it is counted.

After the change, with Order Type = TLT:
  Project 920 must read 7.758 + 51.483 + 108.970 + 32.445 + 13.077 = 213.732 MT
  Portfolio must read  2,557.619 + 2,237.924 + 2,013.819 + 2,107.611 + 2,052.582
                       = 10,969.555 MT
Both with no warning shown.

When done, paste the changed lines verbatim — the new PROCESS_PHASES entry or the new
allPhasesWt expression, the filter handling, and the new warning string.
```

---

## FIX 2 — `release_balance_wip` has no import scoping
### Severity: second-highest.

```
The release_balance_wip table has columns project, structure,
release_balance_computed_mt, updated_at, with primary key (project, structure). It has no
import_id. recomputeReleaseBalance() deletes the entire table on every upload and
reinserts from the file just uploaded.

Because the Job Wise report joins Release Balance from this table while taking every
other figure from the selected import, viewing any historical import shows that import's
Cutting, Quality Check and Galvanising alongside the MOST RECENT file's Release Balance.

This is not theoretical. Measured Release Balance totals: 21-Jul 2,538.863 MT, 22-Jul
2,538.863, 23-Jul 2,529.380, 24-Jul 2,495.664, 26-Jul 2,557.619. A user reviewing the
21-Jul import after uploading 26-Jul sees a figure 18.756 MT wrong, silently, and the
five-bucket reconciliation fails by that amount with no explanation.

Please:

1. Add an import_id column to release_balance_wip and make the primary key
   (import_id, project, structure).

2. Change recomputeReleaseBalance() to delete and reinsert only rows for the import being
   processed, instead of truncating the whole table.

3. Update the Job Wise route to look up Release Balance scoped to the import it is
   already rendering, not to the latest upload.

4. recomputeReleaseBalance() is currently wrapped in try/catch that only logs a warning,
   so a failed recompute silently leaves stale values in place. Make a failure visible in
   the import result rather than silent.

Please also check whether assignmentBalanceWipTable has the same missing-import_id
problem, and report what you find without changing it yet.

When done, paste the new schema definition for release_balance_wip, the changed
recomputeReleaseBalance() body, and the changed lookup in the Job Wise route.
```

---

## FIX 3 — `TOTAL_ROW` regex will not catch an unspaced "SubTotal"
### Severity: low effort, high blast radius if it ever triggers.

```
In the Order Review parser, TOTAL_ROW is currently:

  const TOTAL_ROW = /^(sub\stotal|grand\stotal|total)\b/i;

\s requires exactly one whitespace character, so the string "SubTotal" with no space
would not match — the third alternative does not rescue it either, because ^total cannot
match a string beginning with "Sub".

This matters because the live Order Review files carry 166 to 169 "Sub Total" rows
totalling roughly 49,084 MT — more weight than the real data rows. A Sub Total row that
slips through roughly doubles the order book for that project.

Please change \s to \s* in both alternatives so any amount of whitespace, including none,
is matched. Then paste the changed line verbatim so I can see the asterisks.
```

---

## FIX 4 — Two safety nets are computed but never shown
### Severity: medium. Both values already exist; this is display only.

```
Two counters are computed and then discarded, so problems they would reveal stay
invisible:

1. classifyWipCase() can return UNCLASSIFIED for a row matching none of the four cases.
   Nothing consumes that result.

2. The Order Review parser counts orphan rows into missingStructure — rows with a blank
   Col C that appear before any structure code in their project, so they cannot be
   attached to a structure. This is not hypothetical: there are exactly 4 such rows
   carrying 63.882 MT in every Order Review file from 21 to 26 July, the same 4 rows each
   time.

Please surface both on the Data page, per import: the count and weight of UNCLASSIFIED
WIP rows, and the count and weight of missingStructure Order Review rows. Show them as a
visible warning when non-zero and as a quiet "0" when clean, so a clean import is
distinguishable from a check that is not running.

Do not change any parsing or classification logic — this is display only.

When done, paste the new Data page block and the shape of whatever the API returns for
these two counters.
```

---

## FIX 5 — Establish which FG representation is canonical
### Do this only after Fix 1. It is an investigation, not a change.

```
FG currently has two representations and nothing checks that they agree:

1. record_pool rows for Type = "FG Pending For Dispatch" — these drive Total Balance,
   Pending Marks and Balance Qty.
2. imports.summary.fgWipByStructure (jsonb), read by useFgRows() — this drives the FG
   WIP display column.

The jsonb copy is frozen at upload time, so a future FG fix will not change already
uploaded imports without a re-upload, while the pool copy would update.

Please do not change anything yet. Instead, for the most recent import, compare the two
sources per (project, structure) and report: how many keys appear in one but not the
other, and the total weight difference. Project 920 should show 215 FG marks and
13.077 MT.

Then tell me which source you would make canonical and why.
```

---

## ENHANCEMENT 1 — Turn Generated Order Review into per-stage validation across all projects
### Not a bug fix. This changes what the feature is for.

**Context for you, not for the Agent.** Today the generated view is gated at 5% released and
shows one project. The gate answers a project-level question ("is this project new enough
that generation is safe?") when the accuracy actually varies **by stage**, not by project.
Measured on the 28-Jul files across all 2,181 structures, rebuilding the full chain from
WO Order Qty plus WIP:

| Generated stage | Within 0.5 MT | Tier |
|---|---|---|
| Progress Release | 98.8% | high |
| Progress Fabrication | 94.6% | high |
| Progress Galvanising | 91.4% | medium |
| Progress Inspection | 85.2% | low |
| Progress Despatch | 83.4% | low |

Release and Fabrication reconstruct well for **every** project, mature or new. The Order
Review file continues to be uploaded, so WO Order Qty is always available — which is the
one input WIP cannot supply.

```
The Generated Order Review on the Data page currently only shows projects under 5%
released, which is usually one project. Please widen it into a per-stage validation view
covering every project. The Order Review file will continue to be uploaded, so WO Order
Qty (Col J) is always available — that is the one input WIP cannot provide, and it is
what makes this possible.

Measured on the 28-Jul files, rebuilding the whole chain from WO Order Qty plus WIP and
comparing against the uploaded Order Review across all 2,181 structures, using a 0.5 MT
tolerance:

  Progress Release      98.8% of structures match
  Progress Fabrication  94.6%
  Progress Galvanising  91.4%
  Progress Inspection   85.2%
  Progress Despatch     83.4%

So the early stages are reliable for every project, not just new ones, and accuracy
degrades down the chain because each stage subtracts from the previous generated value.

Please make these changes:

1. Generate for EVERY structure present in both WIP and the Order Review, not only
   projects under 5% released. Keep the 5% figure only as a "new project" badge on the
   row if that is useful context — it must no longer filter anything out.

2. Compute the chain in this order, per structure:

     genBalRelease  = WIP marks where Type = Job Card Not Started AND Status = Initial
     genProgRelease = woOrderQtyMt - genBalRelease
     genBalFab      = released WIP marks with activity in
                      { C, HG, RFI, NH, B, HAB, W, Q, TS }
     genProgFab     = genProgRelease - genBalFab
     genBalGalv     = released WIP marks with activity in { G, GB, Y }
     genProgGalv    = genProgFab - genBalGalv
     genProgInsp    = genProgGalv - (WIP FG weight)
     genProgDesp    = woOrderQtyMt - (total WIP balance for the structure)

   "released" means NOT isInitialCutting. Do not gate any of this on activity C.

3. Show generated and uploaded values side by side per stage with the delta, and flag
   any delta over 0.5 MT — the same threshold the page already uses.

4. Label each stage with a confidence tier, since they are not equally trustworthy:
   Release and Fabrication = high, Galvanising = medium, Inspection and Despatch = low.
   Make the low tier visually distinct so nobody treats a generated despatch figure as
   authoritative.

5. Add a summary strip at the top showing, per stage, the percentage of structures
   matching within 0.5 MT for the current import. This is the point of the feature: if
   Release ever drops from about 99%, something has broken in the parser or the bucket
   rules, and this is where it will show first.

6. Keep the whole view strictly read-only. It must never write back to, overwrite or
   seed the imported Order Review. Keep the existing "GENERATED — NOT IMPORTED DATA"
   banner.

Do not change the WIP parser, the bucket definitions, or any existing page. This is a new
read-only comparison built from data already in the database.

When done, paste the new chain computation and the summary-strip query verbatim, and tell
me the per-stage match percentages you get for the latest import so I can compare them
against the figures above.
```

---

## ENHANCEMENT 2 — Order Review self-consistency panel
### Small, and it surfaces a real data problem already present in the file.

**Context for you.** The uploaded Order Review is internally inconsistent in places. Its
own cascade identities should always hold, and two of them do not. Measured 28-Jul:

| Identity | Holds on |
|---|---|
| ProgFab + BalFab = ProgRelease | 2181 / 2181 |
| ProgGalv + BalGalv = ProgFab | 2180 / 2181 |
| ProgDesp + BalDesp = ProgInsp | 2179 / 2181 |
| ProgRelease + BalRelease = WO Order Qty | 1583 / 2181 (over-release, expected) |
| **ProgInsp + BalInsp = ProgGalv** | **1869 / 2181** |

Balance Inspection also sums to **negative 1,434.164 MT** across the file, which is not a
possible value for a balance. The single worst structure is **916F / F24**, deviating by
**4,935.990 MT** — the same structure that breaks the FG comparison.

```
The uploaded Order Review is internally inconsistent in places, and nothing currently
surfaces it. Please add a small self-consistency panel to the Data page that checks the
file's own cascade identities per structure on each import:

  ProgRelease + BalRelease  should equal  WO Order Qty
  ProgFab     + BalFab      should equal  ProgRelease
  ProgGalv    + BalGalv     should equal  ProgFab
  ProgInsp    + BalInsp     should equal  ProgGalv
  ProgDesp    + BalDesp     should equal  ProgInsp

Report per identity: how many structures satisfy it within 0.002 MT, and list the ten
worst offenders with their deviation.

Also flag separately any structure where a Balance column is negative, since a negative
balance is not a possible value.

On the 28-Jul file you should find that the fabrication and galvanising identities hold
almost perfectly, but the inspection identity fails on roughly 312 structures, Balance
Inspection sums to about negative 1,434 MT, and structure 916F / F24 deviates by about
4,936 MT.

Note that ProgRelease + BalRelease not matching WO Order Qty is EXPECTED — that is
over-release, a real business condition, and it accounts for a stable residual of about
+193.7 MT concentrated in projects 912 and 938. Label that identity as informational
rather than as an error.

This is read-only reporting. Do not correct or alter any imported value.

When done, paste the identity check code and tell me the counts you get.
```

These are wrong in the current docs and should be corrected wherever they appear:

| Item | Currently says | Should say |
|---|---|---|
| Balance Release agreement | "~97% on 21-Jul, drifting to ~91%" | **95.5%, flat across 21–26 July** |
| Order Review total, 21-Jul | "~2,664 MT" | **2,732.531 MT** |
| Agreement delta | "widens to ~168 MT" | **constant +193.668 MT every day** |
| Unaged Cutting share | "~30%" | **28.0%** (4,243 of 15,137) |
| Project count | "all 66 projects" | **67** distinct TLT project codes, 21-Jul |
| `TOTAL_ROW` regex | "uses `\s*`, `SubTotal` is caught" | **invert — code uses `\s`; see Fix 3** |
| Hash field list | 20 items described as 21 | split `towerSubType/alias` into two entries |
| `parse.ts` line 36 comment | "the 19 source columns" | **21** |
| WIP column letters (Architecture sheet) | Mark No.=I, Balance Wt=O, Last Production=T, `G` twice | **K, Q, V** — see master reference §2.1 |
| Order Review letters (Architecture sheet) | release=K, despatch=P | **L and Q** — K is BOM Label, P is empty |
| FG in `record_pool` | "never inserted" | **present in the pool but routed to no phase** |
