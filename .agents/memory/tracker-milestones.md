---
name: Project turnaround milestones
description: How the permanent per-project Ready/Dispatched milestone capture works and the one invariant that makes it "permanent".
---

# Project turnaround milestones (permanent capture)

Separate permanent layer (NOT a live advisory overlay). Per project (`job`,
excludes `(Unassigned)`), two milestones measured from the project's earliest
Assign Date: Ready = first import where no mark is still in an activity ranked
before `Y`; Dispatched = first import where the project is entirely absent.
Engine `artifacts/api-server/src/lib/milestones.ts`, table `project_milestones`,
endpoint `GET /milestones`.

## The invariant that makes it permanent

`recomputeMilestones()` replays ALL imports id-ASC every call (idempotent: the
earliest qualifying import always wins), then MERGES capture-once against stored
rows and upserts. The materialization loop MUST iterate the **union of replayed
project keys AND already-stored milestone rows** — not just the projects found
in the current replay.

**Why:** if it iterates only replayed `states`, any captured project that drops
out of current history (import deleted/pruned, partial-history env) vanishes from
the `/milestones` response even though its row still exists — silently breaking
the "permanent" contract. This was caught in review after the first cut narrowed
to `states` only.

**How to apply:** keep `new Set([...states.keys(), ...existing.keys()])` driving
the output/upsert loop; treat stored values as the capture-once source of truth
(stored date wins over a recomputed one).

## Other rules

- Strictly additive: reads only; never writes record_pool/import_rows/computed
  fields; never touches parsing/activity/qty/dedup/ageing/warning/velocity.
- Post-upload recompute (direct + staged commit) is best-effort (try/catch) so it
  can never fail an import.
- planned = `cumulativeTarget("Y", settings, project)`; variance = ready - planned.
