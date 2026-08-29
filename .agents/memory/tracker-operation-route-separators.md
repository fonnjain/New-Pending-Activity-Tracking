---
name: Operation-route separators
description: Source-format rule for parsing the WIP Operation route in report predicates.
---

WIP `Operation` routes in the current CSV format are semicolon-delimited (for example, `C;P;S;RFI;W`). Route-based report predicates must recognize semicolons as well as legacy comma-delimited inputs.

**Why:** Treating a nonblank semicolon-delimited route as one token makes every route-membership test fail, silently zeroing Welded and Bending In Hand/Upcoming loads despite qualifying upstream records.

**How to apply:** Keep route tokenization centralized in `routeOps()` and use that helper for every route-membership decision; test both comma and semicolon input forms whenever the helper changes.