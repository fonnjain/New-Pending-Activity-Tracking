---
name: Order Review blank structures
description: How to preserve numeric Order Review rows whose Tower Type is blank.
---

Numeric Order Review rows with a blank Tower Type must be retained for project totals, rather than discarded as malformed.

**Why:** Some single-structure project blocks contain real order, release, and despatch figures followed immediately by a subtotal, but omit the Tower Type. Dropping them silently breaks project totals and order-book reconciliation.

**How to apply:** Preserve these rows as explicitly non-joinable structure records during ingestion and project-level aggregation. Never invent or forward-fill a structure from another project block.