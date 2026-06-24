import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable, SETTINGS_SINGLETON_ID } from "@workspace/db";
import { DEFAULT_TURNAROUND_SETTINGS } from "@workspace/domain";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

// App-level turnaround-warning configuration (singleton). Advisory/display only:
// these settings never touch parsing, ageing, dedup, or any computed field.
router.get("/settings", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, SETTINGS_SINGLETON_ID))
    .limit(1);

  if (!row) {
    res.json(DEFAULT_TURNAROUND_SETTINGS);
    return;
  }

  res.json({
    idealDays: row.idealDays,
    yellowMax: row.yellowMax,
    orangeMax: row.orangeMax,
    graceMode: row.graceMode,
    overrides: row.overrides,
  });
});

router.put("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // Validate band ordering/sign before persisting. These are advisory display
  // thresholds, but inverted (yellowMax > orangeMax) or negative bands produce
  // ambiguous, non-spec banding, so reject them rather than store bad config.
  const yellowMax = Math.round(data.yellowMax);
  const orangeMax = Math.round(data.orangeMax);
  if (yellowMax < 0 || orangeMax < 0 || yellowMax > orangeMax) {
    res.status(400).json({
      error: "yellowMax and orangeMax must be non-negative with yellowMax <= orangeMax",
    });
    return;
  }
  for (const [code, ov] of Object.entries(data.overrides)) {
    if (ov.yellowMax < 0 || ov.orangeMax < 0 || ov.yellowMax > ov.orangeMax) {
      res.status(400).json({
        error: `override "${code}" must have non-negative yellowMax <= orangeMax`,
      });
      return;
    }
  }

  // Persist normalized (rounded) bands and echo the SAME normalized object back,
  // so the client cache never drifts from what was actually stored.
  const normalized = {
    idealDays: data.idealDays,
    yellowMax,
    orangeMax,
    graceMode: data.graceMode,
    overrides: data.overrides,
  };
  const values = { ...normalized, updatedAt: new Date() };

  await db
    .insert(settingsTable)
    .values({ id: SETTINGS_SINGLETON_ID, ...values })
    .onConflictDoUpdate({ target: settingsTable.id, set: values });

  res.json(normalized);
});

export default router;
