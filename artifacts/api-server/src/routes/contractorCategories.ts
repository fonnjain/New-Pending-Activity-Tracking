import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, contractorCategoriesTable } from "@workspace/db";
import {
  normalizeContractorName,
  isContractorCategory,
  isOutVendorType,
} from "@workspace/domain";
import { UpsertContractorCategoryBody } from "@workspace/api-zod";
import { requireAuth } from "./auth";

const router: IRouter = Router();

// --- Contractor sub-category overlay (CNC / Sub-contractor / Out-vendor +
// FAB/GALVA tags). Config only; joined to records at read time. ---

router.get("/contractor-categories", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(contractorCategoriesTable)
    .orderBy(contractorCategoriesTable.displayName);
  res.json(rows);
});

router.put(
  "/contractor-categories",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = UpsertContractorCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const displayName = parsed.data.displayName.trim();
    const nameKey = normalizeContractorName(displayName);
    if (!nameKey) {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    if (!isContractorCategory(parsed.data.category)) {
      res.status(400).json({ error: "invalid category" });
      return;
    }
    // Out-vendor tags only meaningful for OUT_VENDOR; drop them otherwise.
    const outVendorType =
      parsed.data.category === "OUT_VENDOR"
        ? (parsed.data.outVendorType ?? []).filter(isOutVendorType)
        : [];
    const [row] = await db
      .insert(contractorCategoriesTable)
      .values({
        nameKey,
        displayName,
        category: parsed.data.category,
        outVendorType,
      })
      .onConflictDoUpdate({
        target: contractorCategoriesTable.nameKey,
        set: {
          displayName,
          category: parsed.data.category,
          outVendorType,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.json(row);
  },
);

router.delete(
  "/contractor-categories",
  requireAuth,
  async (req, res): Promise<void> => {
    const nameKey = normalizeContractorName(String(req.query.nameKey ?? ""));
    if (!nameKey) {
      res.status(400).json({ error: "nameKey is required" });
      return;
    }
    await db
      .delete(contractorCategoriesTable)
      .where(eq(contractorCategoriesTable.nameKey, nameKey));
    res.status(204).end();
  },
);

export default router;
