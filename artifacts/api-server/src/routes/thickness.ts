import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  rsjThicknessTable,
  manualThicknessTable,
} from "@workspace/db";
import { UpsertRsjThicknessBody, UpsertManualThicknessBody } from "@workspace/api-zod";
import { requireAuth } from "./auth";

const router: IRouter = Router();

// --- RSJ Types & Thickness lookup (NTLT/RSJ auto-fill). Config only. ---

router.get("/rsj-thickness", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(rsjThicknessTable)
    .orderBy(rsjThicknessTable.groupKey);
  res.json(rows);
});

router.put("/rsj-thickness", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertRsjThicknessBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const groupKey = parsed.data.groupKey.trim().toUpperCase();
  if (!groupKey) {
    res.status(400).json({ error: "groupKey is required" });
    return;
  }
  const [row] = await db
    .insert(rsjThicknessTable)
    .values({ groupKey, thicknessMm: parsed.data.thicknessMm })
    .onConflictDoUpdate({
      target: rsjThicknessTable.groupKey,
      set: { thicknessMm: parsed.data.thicknessMm, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

router.delete("/rsj-thickness", requireAuth, async (req, res): Promise<void> => {
  const groupKey = String(req.query.groupKey ?? "");
  if (!groupKey) {
    res.status(400).json({ error: "groupKey is required" });
    return;
  }
  await db
    .delete(rsjThicknessTable)
    .where(eq(rsjThicknessTable.groupKey, groupKey));
  res.status(204).end();
});

// --- Manual thickness pins (NTLT/GENERAL + any hand-pinned mark). Survive re-import. ---

router.get("/manual-thickness", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(manualThicknessTable)
    .orderBy(manualThicknessTable.markId);
  res.json(rows);
});

router.put("/manual-thickness", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertManualThicknessBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const markId = parsed.data.markId.trim();
  if (!markId) {
    res.status(400).json({ error: "markId is required" });
    return;
  }
  const [row] = await db
    .insert(manualThicknessTable)
    .values({ markId, thicknessMm: parsed.data.thicknessMm })
    .onConflictDoUpdate({
      target: manualThicknessTable.markId,
      set: { thicknessMm: parsed.data.thicknessMm, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

router.delete(
  "/manual-thickness",
  requireAuth,
  async (req, res): Promise<void> => {
    const markId = String(req.query.markId ?? "");
    if (!markId) {
      res.status(400).json({ error: "markId is required" });
      return;
    }
    await db
      .delete(manualThicknessTable)
      .where(eq(manualThicknessTable.markId, markId));
    res.status(204).end();
  },
);

export default router;
