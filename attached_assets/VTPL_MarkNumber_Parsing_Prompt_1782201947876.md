# VTPL Shop Floor — Replit Prompt

## Mark Number Parsing (final, consolidated)

This is the complete, self-contained rule for parsing the **Mark No.** column (Col H) of the WIP file into structured fields. It replaces any earlier Mark-No / alias-split instructions. Verified against the real file (41,180 rows).

---

## Goal

Parse each row's **Mark No. (Col H)** into these fields and store them on the job-card object:

- `project` — always **Col A** (Project Code)
- `structure` — the structure / alias code
- `mNo` — the bare mark token (kept whole, including variant letters like `X`, `R`, `H`, `RH`, and trailing tokens like `R-4`)
- `proMno` — **only for IS/SC rows** (see below); empty `""` otherwise
- `markNumber` — the composed display string:
  - **IS / SC rows → 4 parts:** `project \ proMno \ structure \ mNo`
  - **all other rows → 3 parts:** `project \ structure \ mNo`

`markNumber` is the value shown on the form's Mark field and written to every exported report.

---

## Parsing rules (apply in this order)

### Rule A — Case 1: bare mark (Col A and Col G both empty)
Trigger: Col H has no space and no backslash, and Col A & Col G are empty (Earthing / General / RSJ Pole / similar).
- `mNo = H`; `project = ""`; `structure = ""`; `proMno = ""`
- `markNumber = mNo`
- Example: `H = 01` → `markNumber = "01"`.

### Rule B — IS / SC rows (the only rows that get `proMno`, 4-part mark)
Trigger: **Col G (Alias) is exactly `IS`, `SC`, or `S`** (any Mark No. shape — backslash, dash, or space).
1. `project = A`.
2. Strip the prefix `"<A> <G>-"` from H → `body`.
3. **Strip a leading `VT`** if it sits immediately before the inner project number (i.e. `body` starts with `VT` directly followed by a digit, e.g. `VT837` → `837`, `VT775` → `775`). Do **not** strip `VT` anywhere else — leave it intact inside structure codes like `3IVTS`, `MVT`, `3MVT`, `2IVT`, `2CVT`, `4CVT`.
4. **Absorb the inner project into proMno:** if `body` now begins with a numeric project token (one or more digits, with an optional trailing dot, e.g. `775` or `824.`) that is either followed by a separator (`\`, `-`, or space) **or** glued directly to letters (e.g. `775OC15M`):
   - `proMno = "<G>-<that number>"` (e.g. `IS-775`, `SC-775`, `IS-824.`)
   - remove that number (and its separator) from the front of `body`.
   - Otherwise (no inner numeric project): `proMno = "<G>"` (e.g. `IS`).
5. From what remains: `structure` = the first token (split on the first `\`, `-`, or space); `mNo` = the rest.
6. `markNumber = project + " \\ " + proMno + " \\ " + structure + " \\ " + mNo` (**4 parts**).
7. As a safety net, if `mNo` still contains a backslash or space after parsing, flag the row `{ field:"markNo", rawValue:H, issue:"IS/SC mark — review" }` and import as-is. (On the current file this catches **0 rows** — all 905 IS/SC/S rows parse cleanly.)

### Rule C — Case 2: standard space form `<A> <G>-<mNo>` (non-IS/SC)
Trigger: Col H has a space, no backslash, and Col G is **not** IS/SC/S.
1. `project = A`; `structure = G` (unchanged); `proMno = ""`.
2. **Strip the known prefix** `"<A> <G>-"`; the remainder is `mNo`, kept whole. (Do **not** split on the first dash — the Alias itself can contain a dash, e.g. `2DF-5`.)
3. `markNumber = project + " \\ " + structure + " \\ " + mNo` (**3 parts**).
4. Validate H starts with `"<A> <G>-"`; if not, keep the row and flag it.
- Examples: `811 3S5-143` → `mNo "143"`, `markNumber "811 \ 3S5 \ 143"`; `933 2AF3-20X` → `mNo "20X"`, `markNumber "933 \ 2AF3 \ 20X"`; `933 2DF-5-204X` → `mNo "204X"`, `markNumber "933 \ 2DF-5 \ 204X"`.

### Rule D — Case 3: backslash form, non-IS/SC (e.g. Col G = `S` already handled by Rule B; others)
Trigger: Col H contains a backslash and Col G is **not** IS/SC/S.
1. `project = A`; `structure` = segment **before the last backslash**; `mNo` = segment **after the last backslash** (kept whole, e.g. `R-4`); `proMno = ""`.
2. `markNumber = project + " \\ " + structure + " \\ " + mNo` (**3 parts**).

> Note: rows where Col G is `IS`/`SC`/`S` always go through **Rule B**, even if they contain backslashes — Rule B's split handles `\`, `-`, and space uniformly.

### Leftover odd shapes — flag only (never auto-change)
Flag for manual review (still import as-is): Mark No. where Col G is `OFS` or `DD`, or a free-text mark like `916F F24-Pln. Wshr` (mark contains a space-separated word rather than a structure-mark). Issue: `"non-standard mark format — review"`. (~5 rows.)

---

## Worked examples

### IS / SC → 4-part `project \ proMno \ structure \ mNo`

| Raw Mark No. (H) | project | proMno | structure | mNo | markNumber |
|---|---|---|---|---|---|
| `775 IS-775\OB6M\4` | 775 | IS-775 | OB6M | 4 | `775 \ IS-775 \ OB6M \ 4` |
| `821 IS-BD3M\269` | 821 | IS | BD3M | 269 | `821 \ IS \ BD3M \ 269` |
| `837 IS-775-OC24M-344` | 837 | IS-775 | OC24M | 344 | `837 \ IS-775 \ OC24M \ 344` |
| `837 IS-775\OC24M\18` | 837 | IS-775 | OC24M | 18 | `837 \ IS-775 \ OC24M \ 18` |
| `821 IS-821 2DD3-6` | 821 | IS-821 | 2DD3 | 6 | `821 \ IS-821 \ 2DD3 \ 6` |
| `775 SC-775OC15M-8` | 775 | SC-775 | OC15M | 8 | `775 \ SC-775 \ OC15M \ 8` |
| `824. IS-824.\2GB2\39` | 824. | IS-824. | 2GB2 | 39 | `824. \ IS-824. \ 2GB2 \ 39` |
| `775 IS-775\OB6M\R-4` | 775 | IS-775 | OB6M | R-4 | `775 \ IS-775 \ OB6M \ R-4` |
| `837 IS-VT837\2UR6M\11X` | 837 | IS-837 | 2UR6M | 11X | `837 \ IS-837 \ 2UR6M \ 11X` |
| `837 IS-VT775\OC24M\307` | 837 | IS-775 | OC24M | 307 | `837 \ IS-775 \ OC24M \ 307` |
| `811 IS-811\3IVTS\5` | 811 | IS-811 | 3IVTS | 5 | `811 \ IS-811 \ 3IVTS \ 5` |

### Non-IS/SC → 3-part `project \ structure \ mNo`

| Raw Mark No. (H) | project | structure | mNo | markNumber |
|---|---|---|---|---|
| `811 3S5-143` | 811 | 3S5 | 143 | `811 \ 3S5 \ 143` |
| `933 2AF3-20X` | 933 | 2AF3 | 20X | `933 \ 2AF3 \ 20X` |
| `933 2DF-5-204X` | 933 | 2DF-5 | 204X | `933 \ 2DF-5 \ 204X` |
| `821 2DD3-363RH` | 821 | 2DD3 | 363RH | `821 \ 2DD3 \ 363RH` |
| `869 NDF3M\\OB6M\\3` (non IS/SC backslash) | 869 | (before last `\`) | (after last `\`) | 3-part |
| `01` (bare, A & G empty) | — | — | 01 | `01` |

### Flagged (import as-is, surface in sanity report)

| Raw Mark No. (H) | why |
|---|---|
| `916F F24-Pln. Wshr` | free-text mark (Col G = F24) |
| `VS-91 OFS-VS-69 WT9-20A` | OFS non-standard shape (Col A not numeric) |
| `934 DD-DD 6 H` | DD free-text/odd shape |

---

## Scope / counts (verified on current file)

- IS/SC/S rows: **905** total → **all 905 parse cleanly** into the 4-part form, **0 flagged**. (A leading `VT` before the inner project number is stripped, e.g. `VT837` → `837`; `VT` inside structure codes like `2CVT`, `3IVTS`, `MVT` is preserved.)
- All other rows: unchanged 3-part parsing. The `<A> <G>-` prefix-strip matches **100%** of standard space-form rows, including the 697 where the Alias itself contains a dash (e.g. `2DF-5`).
- `mNo` always keeps variant suffixes (`X`, `R`, `L`, `H`, `RH`, …) and trailing tokens (`R-4`) whole — never split.
- Bare marks may be non-numeric (one `N` exists) — still valid.

---

## Replit instruction (paste this)

> Implement Mark No. (Col H) parsing exactly as specified in this document. Add a new `proMno` field to the job-card object (empty for non-IS/SC rows). Apply Rules A–D in order. **Only rows where Col G is `IS`, `SC`, or `S` get a `proMno` and a 4-part `markNumber` (`project \ proMno \ structure \ mNo`); all other rows keep the 3-part `markNumber` (`project \ structure \ mNo`).** `project` is always Col A; `mNo` is always kept whole (never split off variant letters). Flag — but still import as-is — the rows noted under "flag only" and any IS/SC row whose `mNo` still contains a backslash or space after parsing; surface all flags in the import sanity report. Do not change Case 1 bare marks. The composed `markNumber` is the value displayed on the Cutting form's Mark field and written to exported reports.
