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

## Documentation corrections (not code)

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
