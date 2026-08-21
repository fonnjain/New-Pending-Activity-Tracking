---
name: Canonical WIP activity aliases
description: Why raw aliased activity must be captured on shared-pool conflict even though it is excluded from row identity.
---

# Canonical WIP activity aliases

**Rule:** Canonicalize ERP aliases before hashing. Keep the original source code in a nullable, non-serialized audit field only when an alias fires. When the canonical row collides with a shared pool row, retain the first non-null raw alias instead of clearing or ignoring it.

**Why:** Canonical and already-normalized rows intentionally have the same identity. If conflict handling ignores the raw field, a later aliased source row can deduplicate against an existing canonical row and the source value is lost, defeating reversibility. Backfilling would instead rewrite historical data and is prohibited.

**How to apply:** Keep alias audit fields out of hashes, filters, reports, APIs, and exports. Use first-non-null conflict semantics for future alias events and leave all rows null at rollout. If provenance must vary by import, store it per import-row rather than changing the shared pool model.