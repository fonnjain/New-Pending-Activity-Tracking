import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, fabricationPrioritiesTable } from "@workspace/db";
import {
  isFabLoadSection,
  isFabLoadColumn,
  isFabPriority,
} from "@workspace/domain";
import { UpsertFabricationPriorityBody } from "@workspace/api-zod";

const router: IRouter = Router();

// --- Per-row priorities (P1..P10) for the "Fabrication Load for TLT" report.
// Planning overlay keyed by (section, column, project). NEVER touches parsing,
// ageing, dedup, qty, the row hash, classification, or alert math. Writes are
// public on purpose: the report is viewable by all and setting a priority is an
// inline planning action, not config. ---

router.get("/fabrication-priorities", async (_req, res): Promise<void> => {
  const rows = await db.select().from(fabricationPrioritiesTable);
  res.json(rows);
});

router.put("/fabrication-priorities", async (req, res): Promise<void> => {
  const parsed = UpsertFabricationPriorityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { section, column, priority } = parsed.data;
  const project = parsed.data.project.trim();
  if (
    !isFabLoadSection(section) ||
    !isFabLoadColumn(column) ||
    !isFabPriority(priority) ||
    !project
  ) {
    res.status(400).json({ error: "invalid payload" });
    return;
  }
  const [row] = await db
    .insert(fabricationPrioritiesTable)
    .values({ section, column, project, priority })
    .onConflictDoUpdate({
      target: [
        fabricationPrioritiesTable.section,
        fabricationPrioritiesTable.column,
        fabricationPrioritiesTable.project,
      ],
      set: { priority, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

router.delete("/fabrication-priorities", async (req, res): Promise<void> => {
  const section = String(req.query.section ?? "");
  const column = String(req.query.column ?? "");
  const project = String(req.query.project ?? "").trim();
  if (!isFabLoadSection(section) || !isFabLoadColumn(column) || !project) {
    res.status(400).json({ error: "invalid params" });
    return;
  }
  await db
    .delete(fabricationPrioritiesTable)
    .where(
      and(
        eq(fabricationPrioritiesTable.section, section),
        eq(fabricationPrioritiesTable.column, column),
        eq(fabricationPrioritiesTable.project, project),
      ),
    );
  res.status(204).end();
});

export default router;
