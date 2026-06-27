---
name: Tracker turnaround milestones (Ready / Dispatched)
description: How per-project Ready/Dispatched milestones are captured and why dispatch must not depend solely on replayable import_rows.
---

# Milestone capture model

Per-project milestones (`project_milestones`, engine `milestones.ts:recomputeMilestones`) are recomputed deterministically on every read AND after upload/delete, but captured dates are **capture-once**: a stored date always wins on merge, so replaying the full id-ASC history is idempotent and a later partial file can never move a date.

## Rule: dispatch-on-disappear must survive import deletion

A project's "Dispatched" milestone = first report where the project is entirely absent. The replay-based capture derives presence by reading `import_rows`. **`DELETE /imports/:id` cascades `import_rows` away**, so if the import that established a project's presence is deleted *before* a later report marks it absent, pure replay loses all evidence the project ever existed and it never gets dispatched (the historical 588/857-orphans failure).

**Fix / invariant:** persist an advance-forward-only presence pointer (`last_seen_import_id` + `last_seen_date`) on the milestone row. It is merged keeping the GREATER import id (stored vs replayed) so deletion can never roll it back. A separate "data-retention dispatch capture" then stamps Dispatched (dated from the newest report) when: dispatch still null AND `lastSeenImportId < latestImportId` AND project absent from the newest import.

**Why:** any milestone signal that depends only on `import_rows` is fragile under deletion/pruning — derive-once, persist forward.

**How to apply:** when adding new cross-import milestone signals, persist the qualifying state on the milestone row (forward-only) rather than relying on the row history still being present at read time. The `lastSeenImportId < latestImportId` guard is what prevents falsely dispatching a project that is present in (or only ever appeared in) the current newest import — keep it. Going-forward only: pre-existing orphans with no retained presence and no stored last-seen are NOT backfilled.
