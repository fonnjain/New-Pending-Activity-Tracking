---
name: Order Review deletion safety
description: Truthful history rules for deleting merged Order Review snapshot imports.
---

When deleting an Order Review upload, remove only live order-book rows whose
last-seen import is the deleted upload. Never reassign those rows to an older
surviving import. Remove dispatch seeds and ledger entries that no longer have a
live Order Review key, then replay dispatch from the remaining durable inputs.

**Why:** An UPSERT-based current order book does not retain the earlier values
that a deleted upload overwrote. Repointing falsely implies an older file
contained values it did not contain and makes historical attribution misleading.

**How to apply:** Keep deletion corrective, not reconstructive. If per-import
snapshots are needed in the future, add immutable row snapshots as a new
explicit model; do not infer them from the current merged table.