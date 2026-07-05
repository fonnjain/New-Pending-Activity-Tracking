---
name: Diagnosing "report shows nothing for X" complaints
description: Workflow for verifying whether an empty bucket/column in a derived report is a code bug or a genuine data fact, using this tracker's Contractor Performance stage split as the worked example.
---

When a user reports "report X shows nothing for stage A but shows stage B", don't assume a bug in the classifier. Reproduce the exact frontend logic against live data first:

1. Find the classifier function (e.g. `stageFor()` mapping `fromActivity` to a bucket).
2. Hit the same API endpoint the frontend uses, and replay the classifier over the raw entries in Node (via `bash`/`code_execution`), not just eyeballing the UI.
3. Independently confirm with a raw SQL query over the source tables (e.g. a `LAG()` window over `import_rows`/`record_pool`) so the check doesn't depend on the same code path that might be buggy.
4. If both replications agree the bucket is empty, check whether the *other* bucket is also empty — a genuinely empty report (both sides zero) reads very differently from a real asymmetry, and the user may be misreading a different, unrelated table (e.g. an unfiltered "total moved" summary) as evidence for the bucket that actually has data.

**Why:** In the Contractor Performance report, "Fabrication (left TS)" and "Galvanizing (left Y)" are both a strict single-activity-departure check. A 6-import window where every recorded transition was internal `G↔GB` rework produced zero qualifying events for BOTH buckets — not a Fabrication-only bug. The user's impression of "Galvanizing is shown" came from an adjacent, unfiltered daily-total sheet that happened to contain only G/GB rows.

**How to apply:** Before touching classifier code, get the user's actual exported/rendered artifact (e.g. ask them to attach the xlsx export) and inspect every relevant sheet/section — don't rely on a single screenshot or a cut-off scroll capture. Only propose a logic change after confirming the data itself supports a different bucketing (e.g. broadening "Galvanizing" to include intra-bundle moves), and let the user decide whether that's the fix they want versus leaving a mathematically-correct-but-quiet report as-is.
