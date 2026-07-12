# Ageing Calculation — Complete Logic

## What "ageing" means

Ageing is the number of whole calendar days a mark has been sitting at its current activity
stage. It answers: **how long has this mark been waiting where it is right now?**

Ageing is **never stored** in the database. It is recomputed fresh on every API read so the
number always reflects today, not the upload date.

---

## Step 1 — Choose the reference date (activity-aware)

The date ageing is measured from depends on the mark's current **Activity** (Col P in the WIP
file):

| Activity | Reference date | Rationale |
|---|---|---|
| `C` (Cutting) | **Assign Date** (Col R) | Cutting has not begun — no production has happened yet. The mark ages from when it was assigned (how long it has been waiting to start). |
| Everything else | **Last Production Entry Date** (Col S) | Production has started. The mark ages from the last time work was recorded on it. |

This rule is implemented in `resolveAgeingDate()` in `parse.ts`:

```
function resolveAgeingDate(activity, assignDate, lastProductionDate):
  if activity == "C"  →  return assignDate
  else                →  return lastProductionDate
```

**Never fall back**: a non-C mark with a blank Last Production Entry Date is a genuine
data-quality gap ("No production date"). The Assign Date is NOT used as a fallback for
non-C rows — doing so would paper over real missing data.

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
| `C` | Assign Date is blank — mark not yet assigned | **"Not started"** |
| anything else | Last Production Entry Date is blank | **"No production date"** |

These rows are **excluded from bucket counts and averages** — they are never counted as 0.

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

## Where each step runs

| Step | Where | File |
|---|---|---|
| `resolveAgeingDate()` — pick the reference date | Server (API) | `artifacts/api-server/src/lib/parse.ts` |
| `computeAgeing()` — compute whole-day difference | Server (API) | `artifacts/api-server/src/lib/parse.ts` |
| Attach `ageingDays` to every record response | Server (API) | `artifacts/api-server/src/routes/imports.ts` line 296 |
| `ageingBucket()` — classify into 0-30/31-60/60+ | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| `noDateLabel()` — "Not started" vs "No production date" | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| `ageingCell()` — format "12d" or null label for display | Frontend | `artifacts/tracker/src/lib/ageing.ts` |
| Upload summary sanity counts | Server (parse) | `artifacts/api-server/src/lib/parse.ts` |

---

## Upload summary sanity counts

The parse summary (shown on the Data page) includes three ageing-related counts:

| Field | What it counts |
|---|---|
| `notStarted` | Rows where `ageingDays` is null **and** activity is `C` (Cutting). The Assign Date is blank — mark not yet assigned. |
| `noProductionDate` | Rows where `ageingDays` is null **and** activity is NOT `C`. The mark has progressed past cutting but has no recorded production date. |
| `futureProductionDate` | Rows whose chosen reference date (Assign Date for C, else Last Production Entry Date) is strictly after today. These age as 0 but are flagged. |

---

## Invariants (never break)

1. **Activity `C` ages from Assign Date; every other activity ages from Last Production Entry Date.** No exceptions, no cross-fallbacks.
2. **Live, never stored.** `ageingDays` is always recomputed at read time. Stored rows carry only the raw source dates.
3. **Future dates clamp to 0, never negative.** A mark with a future date is never excluded, only flagged.
4. **Null is not zero.** Null `ageingDays` rows are excluded from all bucket counts, averages, and colour bands — they have their own label.
5. **UTC midnight arithmetic.** Both today and the reference date are evaluated at UTC midnight so the result is always a whole-day integer independent of server timezone.
