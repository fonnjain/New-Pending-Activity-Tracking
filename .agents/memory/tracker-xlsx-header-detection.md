---
name: Excel list-upload column detection
description: Parsing a simple plain-list Excel upload (e.g. a list of project codes) still needs header/footer detection, not a fixed column index.
---

Even a "simple" upload type — a plain list of codes in one column, no complex schema — cannot assume the data lives in column 0. Real-world exports commonly have preamble title rows above the header, and the actual code column may not be the first column (e.g. an "S.No." column precedes it). They also commonly have a trailing "Total"/"Grand Total"/"Totals" footer row that must not be ingested as a bogus data value.

**Why:** a hardcoded `row[0]` read silently ingests garbage (title text, serial numbers, footer labels) instead of erroring, and the bug only surfaces when a user uploads a real file rather than a synthetic test fixture.

**How to apply:** for any new plain-list Excel ingestion, scan the first ~10 rows for a cell matching expected header tokens to locate `{row, col}` (falling back to col 0 if no header is found), and explicitly skip rows whose first/label cell matches a footer-token set (`total`, `totals`, `grand total`) before treating the row as data.
