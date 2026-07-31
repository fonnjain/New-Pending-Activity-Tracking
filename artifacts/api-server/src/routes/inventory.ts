import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  importsTable,
  importRowsTable,
  recordPoolTable,
  orderReviewImportsTable,
  orderReviewRowsTable,
  inventoryManualETable,
  inventorySideOverrideTable,
  inventoryMfcBatchColorTable,
  inventoryProjectDatesTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "./auth";
import {
  UpsertInventoryManualEBody,
  UpsertInventorySideOverrideBody,
  UpsertInventoryMfcBatchColorBody,
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

  // (project, structure) keys that have at least one WIP mark with Order
  // Nature = Structure. Drives completed-structure exclusion: a bucket row
  // with no matching WIP marks is finished production and should be hidden.
  const wipStructureKeys = new Set<string>();
  // batch -> cumulative balance weight per (project, structure); used to
  // resolve the representative MFC Batch when a structure has marks in more
  // than one real batch.
  const mfcBatchWt = new Map<string, Map<string, number>>();

  if (newestWip) {
    const marks = await db
      .select({
        job: recordPoolTable.job,
        structure: recordPoolTable.structure,
        orderNature: recordPoolTable.orderNature,
        mfcBatch: recordPoolTable.mfcBatch,
        balanceWt: recordPoolTable.balanceWt,
        copies: importRowsTable.copies,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, newestWip.id));

    for (const m of marks) {
      const key = `${m.job}\u0001${m.structure}`;

      // Completed-exclusion: only Structure rows can ever match an Order
      // Review (project, structure) key; NTLT rows have no structure so they
      // can never collide. Restrict to Order Nature = Structure for clarity.
      if (m.orderNature === "Structure") {
        wipStructureKeys.add(key);
        // Accumulate real batch (A/B/C/D) weights for MFC resolution.
        // "Z" / null means "not yet batched" — not a real batch letter.
        const batch = m.mfcBatch;
        if (batch && batch !== "Z") {
          let bmap = mfcBatchWt.get(key);
          if (!bmap) {
            bmap = new Map();
            mfcBatchWt.set(key, bmap);
          }
          bmap.set(batch, (bmap.get(batch) ?? 0) + (m.balanceWt ?? 0) * (m.copies ?? 1));
        }
      }
    }
  }

  const rows = latestRows.map((r) => {
    const key = `${r.project}\u0001${r.structure}`;

    // Completed-exclusion flag: false = no WIP marks → structure is done.
    const hasWipMarks = wipStructureKeys.has(key);

    // MFC Batch: pick the real batch with the greatest cumulative Balance
    // Weight; fall back to "Z" (= not yet batched) when none exist.
    const bmap = mfcBatchWt.get(key);
    let mfcBatch = "Z";
    if (bmap && bmap.size > 0) {
      let bestWt = -1;
      for (const [b, wt] of bmap) {
        if (wt > bestWt) {
          bestWt = wt;
          mfcBatch = b;
        }
      }
    }

    return {
      project: r.project,
      structure: r.structure,
      subType: r.subType,
      weightMt: r.weightMt,
      woOrderQtyMt: r.woOrderQtyMt,
      releaseMt: r.releaseMt,
      fileBalReleaseMt: r.fileBalReleaseMt,
      inspectionMt: r.inspectionMt,
      // Data columns: galvMt = Progress Galvanising (col N, "Yard");
      // balFabMt/balGalvMt = Balance Fabrication/Galvanising (cols T/U).
      // Sent raw/unclamped — display clamp and Fab+Galva sum computed client-side.
      galvMt: r.galvMt,
      balFabMt: r.balFabMt,
      balGalvMt: r.balGalvMt,
      hasWipMarks,
      mfcBatch,
    };
  });

  res.json({ available: true, asOnDate: latestImport.asOnDate, rows });
});

// ---------------------------------------------------------------------------
// Manual bucket E ("Material Ready But Not Dispatched"). Persisted list the
// user maintains directly on the page; never derived, never cleared by a
// re-upload.
// ---------------------------------------------------------------------------

router.get("/inventory-manual/e", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventoryManualETable)
    .orderBy(inventoryManualETable.createdAt);
  res.json(rows);
});

router.put("/inventory-manual/e", requireAuth, requireAdmin, async (req, res): Promise<void> => {
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
    mfcBatch: (parsed.data.mfcBatch ?? "Z").trim().toUpperCase() || "Z",
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
  requireAdmin,
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

// ---------------------------------------------------------------------------
// Side overrides for auto-computed Buckets B/C/D.  When the user moves a
// project from In-House to Out-Vendor (or vice versa) on the Inventory page
// the choice is stored here so it persists across page loads and WIP
// re-uploads.  One row per (projectCode, bucket); upsert-replace semantics.
// ---------------------------------------------------------------------------

router.get("/inventory-manual/side-overrides", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventorySideOverrideTable)
    .orderBy(inventorySideOverrideTable.createdAt);
  res.json(rows);
});

router.put(
  "/inventory-manual/side-overrides",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpsertInventorySideOverrideBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { projectCode, bucket, side } = parsed.data;
    const code = projectCode.trim();
    if (!code) {
      res.status(400).json({ error: "projectCode is required" });
      return;
    }
    const [row] = await db
      .insert(inventorySideOverrideTable)
      .values({ projectCode: code, bucket, side })
      .onConflictDoUpdate({
        target: [inventorySideOverrideTable.projectCode, inventorySideOverrideTable.bucket],
        set: { side, createdAt: new Date() },
      })
      .returning();
    res.json(row);
  },
);

router.delete(
  "/inventory-manual/side-overrides",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const projectCode = String(req.query.projectCode ?? "").trim();
    const bucket = String(req.query.bucket ?? "").trim();
    if (!projectCode || !bucket) {
      res.status(400).json({ error: "projectCode and bucket are required" });
      return;
    }
    await db
      .delete(inventorySideOverrideTable)
      .where(
        and(
          eq(inventorySideOverrideTable.projectCode, projectCode),
          eq(inventorySideOverrideTable.bucket, bucket),
        ),
      );
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// MFC batch colour assignments — keyed by (project, mfcBatch) pair.
// Each entry stores a colour (white/yellow/green/blue) and optional milestone
// dates.  Applied as Excel cell background fills on the bucket list export.
//
// IMPORTANT — UPLOAD-INDEPENDENT: this table is keyed on (project, mfc_batch)
// only and is NEVER truncated, rebuilt, or modified by any WIP import/upload.
// A colour assignment is permanent: once a (project, batch) has a colour it
// must never revert to Pre-Bucket B, even if the pair disappears from a later
// WIP file and returns later.  Do NOT add import_id scoping or wholesale
// deletes here.  The Pre-Bucket B gate is colour alone — dates do not block it.
// ---------------------------------------------------------------------------

router.get("/inventory-manual/mfc-batch-colors", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventoryMfcBatchColorTable)
    .orderBy(inventoryMfcBatchColorTable.project, inventoryMfcBatchColorTable.mfcBatch);
  res.json(rows);
});

router.put(
  "/inventory-manual/mfc-batch-colors",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = UpsertInventoryMfcBatchColorBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const project = parsed.data.project.trim();
    const mfcBatch = parsed.data.mfcBatch.trim().toUpperCase() || "Z";
    if (!project) {
      res.status(400).json({ error: "project is required" });
      return;
    }
    const now = new Date();
    const [row] = await db
      .insert(inventoryMfcBatchColorTable)
      .values({
        project,
        mfcBatch,
        color: parsed.data.color,
        dateOfClientMfc: parsed.data.dateOfClientMfc ?? null,
        projectStartDate: parsed.data.projectStartDate ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [inventoryMfcBatchColorTable.project, inventoryMfcBatchColorTable.mfcBatch],
        set: {
          color: parsed.data.color,
          dateOfClientMfc: parsed.data.dateOfClientMfc ?? null,
          projectStartDate: parsed.data.projectStartDate ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    res.json(row);
  },
);

router.delete(
  "/inventory-manual/mfc-batch-colors",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const project = String(req.query.project ?? "").trim();
    const mfcBatch = String(req.query.mfcBatch ?? "").trim();
    if (!project || !mfcBatch) {
      res.status(400).json({ error: "project and mfcBatch are required" });
      return;
    }
    await db
      .delete(inventoryMfcBatchColorTable)
      .where(
        and(
          eq(inventoryMfcBatchColorTable.project, project),
          eq(inventoryMfcBatchColorTable.mfcBatch, mfcBatch),
        ),
      );
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Per-project milestone dates — "Date of Client MFC" and "Project start date".
//
// IMPORTANT — UPLOAD-INDEPENDENT: this table is keyed on project only and is
// NEVER truncated, rebuilt, or modified by any WIP import/upload.  Dates
// entered here persist across imports permanently.  Do NOT add import_id
// scoping or wholesale deletes.  The gate for leaving Pre-Bucket B is colour
// alone; these dates are informational only.
// ---------------------------------------------------------------------------

router.get("/inventory-manual/project-dates", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(inventoryProjectDatesTable)
    .orderBy(inventoryProjectDatesTable.project);
  res.json(rows);
});

router.put(
  "/inventory-manual/project-dates",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const { project, dateOfClientMfc, projectStartDate } = req.body ?? {};
    if (!project || typeof project !== "string" || !project.trim()) {
      res.status(400).json({ error: "project is required" });
      return;
    }
    const now = new Date();
    const [row] = await db
      .insert(inventoryProjectDatesTable)
      .values({
        project: project.trim(),
        dateOfClientMfc: dateOfClientMfc || null,
        projectStartDate: projectStartDate || null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: inventoryProjectDatesTable.project,
        set: {
          dateOfClientMfc: dateOfClientMfc || null,
          projectStartDate: projectStartDate || null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    res.json(row);
  },
);

export default router;
