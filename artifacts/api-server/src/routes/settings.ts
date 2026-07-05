import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable, SETTINGS_SINGLETON_ID } from "@workspace/db";
import { migrateTurnaroundSettings } from "@workspace/domain";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { requireAuth } from "./auth";
import { recomputeMilestones } from "../lib/milestones";
import { recomputeDispatch } from "../lib/dispatch";
import { recomputeAccumulatedWip } from "../lib/accumulatedWip";
import { recomputeContractorMovement } from "../lib/contractorMovement";

const router: IRouter = Router();

// App-level turnaround-warning configuration (singleton). Advisory/display only:
// these settings never touch parsing, ageing, dedup, or any computed field.
// GET is public so read-only views (Overview warnings) render for everyone; PUT
// is gated behind the same login as the other write routes.
router.get("/settings", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, SETTINGS_SINGLETON_ID))
    .limit(1);

  if (!row) {
    // No stored row yet: return the fully-migrated defaults (seeds perProject,
    // stalledDays, and the three NTLT categories) so the shape matches a saved
    // row and the client never sees a partial settings object.
    res.json(migrateTurnaroundSettings({}));
    return;
  }

  // Normalize any stored shape (including legacy) into the current per-activity
  // shape so older rows keep working without a manual data migration. Carries
  // the sparse per-project overrides through unchanged (sanitized).
  res.json(
    migrateTurnaroundSettings({
      activities: row.activities,
      perProject: row.perProject,
      stalledDays: row.stalledDays,
      ntlt: row.ntlt,
      validFromDate: row.validFromDate,
    }),
  );
});

router.put("/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Normalize per-activity bands (non-negative, yellow <= orange <= red, full
  // PROCESS_SEQUENCE coverage) and echo the SAME object we persist, so the
  // client cache never drifts from what was actually stored.
  const normalized = migrateTurnaroundSettings(parsed.data);
  const values = {
    activities: normalized.activities,
    perProject: normalized.perProject ?? {},
    ntlt: normalized.ntlt ?? {},
    stalledDays: normalized.stalledDays ?? 10,
    // Global WIP cutoff (YYYY-MM-DD) or null. Scoping only.
    validFromDate: normalized.validFromDate ?? null,
    updatedAt: new Date(),
  };

  await db
    .insert(settingsTable)
    .values({ id: SETTINGS_SINGLETON_ID, ...values })
    .onConflictDoUpdate({ target: settingsTable.id, set: values });

  // The cutoff bounds the persisted dispatch overlay (Order Status reads the
  // STORED table, not a live recompute) and the persisted milestones. Rebuild
  // both against the new window so a cutoff change takes effect immediately.
  // Best-effort: a recompute failure must never fail the settings save.
  try {
    await recomputeDispatch();
    await recomputeMilestones();
    await recomputeAccumulatedWip();
    await recomputeContractorMovement();
  } catch (err) {
    req.log.warn({ err }, "Post-settings recompute failed (non-fatal)");
  }

  res.json(normalized);
});

export default router;
