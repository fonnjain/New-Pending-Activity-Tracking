---
name: Order Review "latest import" scoping
description: order_review_rows is an UPSERT table across ALL imports ever loaded, not just the newest one — features that must reflect "today's order book" need an explicit importId = latest filter, not a straight table scan.
---

`order_review_rows` has one row per (project, structure), UPSERTed on every Order Review upload. `importId` records which import last touched that key — it does NOT mean the row belongs only to that import; a row from an old upload whose key never reappeared in a later upload stays in the table forever, tagged with its original (now stale) `importId`.

Consumers like the Order Status page intentionally want this full history-plus-current view (they flag stale rows via `notInLatest` badges). But any feature whose spec says "computed from the latest Order Review import" (e.g. Inventory buckets B/C/D) must filter `WHERE importId = <latest import's id>` explicitly — a plain unfiltered read silently includes every stale row from every prior upload, inflating counts by 5–10x in a dev DB that has accumulated multiple disjoint test uploads.

**Why:** a full-table read looked plausible (matched the existing `loadLatestOrderReview()` helper's contract used elsewhere) but produced bucket counts wildly larger than the documented expected numbers; only filtering to the newest `order_review_imports.id` matched spec.

**How to apply:** when a new feature reads `order_review_rows` and the spec anchors to "the latest/current Order Review import", query `orderReviewRowsTable` filtered by the newest `order_review_imports.id` directly — don't reuse a full-history helper meant for a different page's semantics.
