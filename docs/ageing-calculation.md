# Ageing Calculation — Complete Logic

## What "ageing" means

Ageing is the number of whole calendar days a mark has been sitting at its current activity
stage. It answers: **how long has this mark been waiting where it is right now?**

Ageing is **never stored** in the database. It is recomputed fresh on every API read so the
number always reflects today, not the upload date.

---

## Step 1 — Choose the reference date (activity-aware)

The date ageing is measured from depends on the mark's current **Activity** (Col S in the WIP
file):

| Activity | Reference date | Rationale |
|---|---|---|
| `C` (Cutting) | **Assign Date** (Col R) | TLT first step — production has not begun. No Last Production Entry Date exists. Ages from assignment. |
| `NTF` (Non-TLT Fabrication) | **Assign Date** (Col R) | NTLT first step — same situation as Cutting for NTLT marks. |
| `NTFSW` (Non-TLT Fab + Stiffener Welding) | **Assign Date** (Col R) | NTLT first step variant — no production date yet. |
| `BL` (Bending/Lapping) | **Assign Date** (Col R) | NTLT first step variant — no production date yet. |
| Everything else | **Last Production Entry Date** (Col V) | Production has started. Ages from the last time work was recorded. |

These four activities (`C`, `NTF`, `NTFSW`, `BL`) are collectively called
**pre-production activities**. They are defined in a single named constant:

```
PRE_PRODUCTION_ACTIVITIES = { "C", "NTF", "NTFSW", "BL" }
```

This is implemented in `resolveAgeingDate()` in `parse.ts`:

```
function resolveAgeingDate(activity, assignDate, lastProductionDate):
  if activity in PRE_PRODUCTION_ACTIVITIES  →  return assignDate
  else                                      →  return lastProductionDate
```

**Never fall back**: a post-production mark with a blank Last Production Entry Date is a
genuine data-quality gap ("No production date"). The Assign Date is NOT used as a fallback
for post-production rows — doing so would paper over real missing data.

---

## Step 2 — Compute whole days from reference date to today (UTC)

Once the reference date is resolved, ageing is:

```
ageingDays = floor( (today_UTC_midnight_ms - reference_date_UTC_midnight_ms) / 86400000 )
```

Both ends are evaluated at **UTC midnight** so the result is always a whole number of days
and is timezone-independent.

**Future-date clamp**: if the reference date is later than today (e.g. an Assign Date
entered ahead of time), the difference is negative → clamped to **0**. The mark is
flagged in the upload summary as "future production date" but is never dropped.

**Unparseable date → null**: if the chosen date field is blank or cannot be parsed,
`ageingDays` is `null`. The UI labels this row (see Null labels below).

---

## Step 3 — Null labels (activity-aware)

When `ageingDays` is `null` the UI shows a descriptive label instead of a number:

| Activity | `ageingDays` is null because… | Label shown |
|---|---|---|
| `C`, `NTF`, `NTFSW`, or `BL` | Assign Date is blank — mark not yet assigned | **"Not started"** |
| anything else | Last Production Entry Date is blank | **"No production date"** |

These rows are **excluded from bucket counts and averages** — they are never counted as 0.
They are still fully counted in balance weight, mark counts, activity totals, project totals,
and every non-ageing report.

---

## Step 4 — Ageing buckets (display / reporting)

Rows with a numeric `ageingDays` are classified into three fixed buckets for charts and
colour coding:

| Bucket | Range | Colour |
|---|---|---|
| `0-30` | 0 – 30 days | Green |
| `31-60` | 31 – 60 days | Amber |
| `60+` | > 60 days | Red |

Null rows (`ageingDays === null`) are **not placed in any bucket** — they are counted and
displayed separately as "Not started" or "No production date".

---

## Step 5 — Visibility of non-ageable rows

Because non-ageable rows can carry a material share of weight (e.g. Cutting marks with no
Assign Date represent ~72% of all cutting weight in the data), the Ageing page explicitly
shows:

- **Per-activity**: the count and weight of not-aged marks for that activity.
- **Overall**: a banner showing the total not-aged count and weight, with a note that they
  are excluded from averages.
- **Avg Age tile**: shows the ageable population size: "Avg Age (N ageable)" so the
  denominator is always visible.

---

## Where each step runs

| Step | Where | File |
|---|---|---|
| `resolveAgeingDate()` — pick the reference date | Server (API) | `artifacts/api-server/src/lib/parse.ts` |
| `computeAgeing()` — compute whole-day difference | Server (API) | `artifacts/api-server/src/lib/parse.ts` |
| Attach `ageingDays` to every record response | Server (API) | `artifacts/api-server/src/routes/imports.ts` |
| `ageingBucket()` — classify into 0-30/31-60/60+ | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| `noDateLabel()` — "Not started" vs "No production date" | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| `ageingCell()` — format "12d" or null label for display | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| Upload summary sanity counts | Server (parse) | `artifacts/api-server/src/lib/parse.ts` |

---

## Upload summary sanity counts

The parse summary (shown on the Data page) includes three ageing-related counts:

| Field | What it counts |
|---|---|
| `notStarted` | Rows where `ageingDays` is null **and** activity is pre-production (C, NTF, NTFSW, BL). The Assign Date is blank — mark not yet assigned. |
| `noProductionDate` | Rows where `ageingDays` is null **and** activity is NOT pre-production. The mark has progressed past the first step but has no recorded production date. |
| `futureProductionDate` | Rows whose chosen reference date is strictly after today. These age as 0 but are flagged. |

---

## Column reference (24-column WIP format, current)

The app reads all fields by **header name**, not by column letter. The column letters below
are for documentation reference only — do not hard-code them.

| Field | Column | Header name |
|---|---|---|
| Assign Date | Col R | "Assign Date" |
| Activity | Col S | "Activity" |
| Last Production Entry Date | Col V | "Last Production Entry Date" |
| WO Batch No. / Batch No. | Col X | "WO Batch No." (old) or "Batch No." (new ≥ Jul 2026) |

The previous 21-column layout placed Activity at Col P and Last Production Entry Date at
Col S. Those letters are stale — the code is correct because it maps by header name.

---

## Invariants (never break)

1. **Pre-production activities (C, NTF, NTFSW, BL) age from Assign Date; every other activity ages from Last Production Entry Date.** No exceptions, no cross-fallbacks.
2. **Live, never stored.** `ageingDays` is always recomputed at read time. Stored rows carry only the raw source dates.
3. **Future dates clamp to 0, never negative.** A mark with a future date is never excluded, only flagged.
4. **Null is not zero.** Null `ageingDays` rows are excluded from all bucket counts, averages, and colour bands — they have their own label and are shown explicitly on the Ageing page.
5. **UTC midnight arithmetic.** Both today and the reference date are evaluated at UTC midnight so the result is always a whole-day integer independent of server timezone.
6. **Non-ageable rows are excluded from ageing only.** Balance weight, mark counts, activity totals, project totals, and every non-ageing report still count them normally.
