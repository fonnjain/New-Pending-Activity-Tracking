import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  orderReviewImportsTable,
  orderReviewRowsTable,
  inventoryManualATable,
  inventoryManualETable,
} from "@workspace/db";
import { requireAuth } from "./auth";
import {
  UpsertInventoryManualABody,
  UpsertInventoryManualEBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Inventory page (5-bucket board A-E). Buckets B/C/D are AUTO-computed
// CLIENT-SIDE from the raw joined rows this endpoint returns (Order Review's
// latest snapshot + the distinct contractors touching each (project,
// structure) in the newest WIP import). Server work is kept to the join only
// — never applies the B/C/D numeric filters or the in-house/out-vendor side
// classification (that lives in the frontend's classifyStructureSides, next
// to contractor_categories + the hardcoded name overrides). Purely additive
// and read-only: reads order_review_rows + record_pool + import_rows, never
// writes to any of them.
// ---------------------------------------------------------------------------

router.get("/inventory/buckets", async (_req, res): Promise<void> => {
  const [latestImport] = await db
    .select()
    .from(orderReviewImportsTable)
    .orderBy(desc(orderReviewImportsTable.id))
    .limit(1);
  if (!latestImport) {
    res.json({ available: false, asOnDate: null, rows: [] });
    return;
  }

  // Bucket B/C/D source is ONLY the newest Order Review import's rows (not the
  // full order_review_rows upsert history, which also carries rows last seen
  // in an OLDER import that the newest upload never touched).
  const latestRows = await db
    .select()
    .from(orderReviewRowsTable)
    .where(eq(orderReviewRowsTable.importId, latestImport.id));

  const [newestWip] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);

  const contractorsByKey = new Map<string, Set<string>>();
  if (newestWip) {
    const marks = await db
      .select({
        job: recordPoolTable.job,
        structure: recordPoolTable.structure,
        contractor: recordPoolTable.contractor,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, newestWip.id));
    for (const m of marks) {
      if (!m.contractor) continue;
      const key = `${m.job}\u0001${m.structure}`;
      let set = contractorsByKey.get(key);
      if (!set) {
        set = new Set();
        contractorsByKey.set(key, set);
      }
      set.add(m.contractor);
    }
  }

  const rows = latestRows.map((r) => {
    const key = `${r.project}\u0001${r.structure}`;
    const contractors = contractorsByKey.get(key);
    return {
      project: r.project,
      structure: r.structure,
      subType: r.subType,
      weightMt: r.weightMt,
      woOrderQtyMt: r.woOrderQtyMt,
      fileBalReleaseMt: r.fileBalReleaseMt,
      inspectionMt: r.inspectionMt,
      contractors: contractors ? Array.from(contractors) : [],
      notInLatest: false,
    };
  });

  res.json({ available: true, asOnDate: latestImport.asOnDate, rows });
});

// ---------------------------------------------------------------------------
// Manual buckets A ("Project to Start") and E ("Material Ready But Not
// Dispatched"). Persisted lists the user maintains directly on the page;
// never derived, never cleared by a re-upload. Two structurally identical
// tables (A = free-text project entry, E = dropdown-picked project) kept
// separate per their distinct entry UX / lifecycle.
// ---------------------------------------------------------------------------

router.get("/inventory-manual/a", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventoryManualATable)
    .orderBy(inventoryManualATable.createdAt);
  res.json(rows);
});

router.put("/inventory-manual/a", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertInventoryManualABody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const projectCode = parsed.data.projectCode.trim();
  if (!projectCode) {
    res.status(400).json({ error: "projectCode is required" });
    return;
  }
  const values = {
    projectCode,
    side: parsed.data.side,
    note: parsed.data.note ?? null,
  };
  if (parsed.data.id != null) {
    const [row] = await db
      .update(inventoryManualATable)
      .set(values)
      .where(eq(inventoryManualATable.id, parsed.data.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    res.json(row);
    return;
  }
  const [row] = await db.insert(inventoryManualATable).values(values).returning();
  res.json(row);
});

router.delete(
  "/inventory-manual/a",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    await db.delete(inventoryManualATable).where(eq(inventoryManualATable.id, id));
    res.status(204).end();
  },
);

router.get("/inventory-manual/e", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventoryManualETable)
    .orderBy(inventoryManualETable.createdAt);
  res.json(rows);
});

router.put("/inventory-manual/e", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertInventoryManualEBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const projectCode = parsed.data.projectCode.trim();
  if (!projectCode) {
    res.status(400).json({ error: "projectCode is required" });
    return;
  }
  const values = {
    projectCode,
    side: parsed.data.side,
    note: parsed.data.note ?? null,
  };
  if (parsed.data.id != null) {
    const [row] = await db
      .update(inventoryManualETable)
      .set(values)
      .where(eq(inventoryManualETable.id, parsed.data.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    res.json(row);
    return;
  }
  const [row] = await db.insert(inventoryManualETable).values(values).returning();
  res.json(row);
});

router.delete(
  "/inventory-manual/e",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    await db.delete(inventoryManualETable).where(eq(inventoryManualETable.id, id));
    res.status(204).end();
  },
);

export default router;
