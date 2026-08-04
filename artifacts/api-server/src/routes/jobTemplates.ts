import { Router, type IRouter } from "express";
import { db, jobTemplatesTable, jobTemplateMembersTable, importRowsTable, recordPoolTable, importsTable, orderReviewRowsTable } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Name generation helpers
// ---------------------------------------------------------------------------

/** Generate the next available name for a category (TLT|NTLT). Uses P1, P2, P3… */
function nextName(category: string, existingNames: string[]): string {
  const prefix = category === "TLT" ? "TLT Job P" : "NTLT Job P";
  const used = new Set(
    existingNames
      .filter((n) => n.startsWith(prefix))
      .map((n) => parseInt(n.slice(prefix.length), 10))
      .filter((n) => !isNaN(n)),
  );
  for (let i = 1; ; i++) {
    if (!used.has(i)) return prefix + i;
  }
}

// ---------------------------------------------------------------------------
// GET /api/job-templates
// Returns all templates with their member lists.
// ---------------------------------------------------------------------------
router.get("/job-templates", async (_req, res): Promise<void> => {
  const templates = await db
    .select()
    .from(jobTemplatesTable)
    .orderBy(jobTemplatesTable.category, jobTemplatesTable.sortOrder);

  const members = await db
    .select()
    .from(jobTemplateMembersTable)
    .orderBy(jobTemplateMembersTable.projectCode);

  const membersByTemplate = new Map<number, string[]>();
  for (const m of members) {
    const list = membersByTemplate.get(m.templateId) ?? [];
    list.push(m.projectCode);
    membersByTemplate.set(m.templateId, list);
  }

  res.json(
    templates.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      sortOrder: t.sortOrder,
      members: membersByTemplate.get(t.id) ?? [],
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /api/job-templates/projects
// Returns distinct project codes per category from the latest WIP import.
// Used by the Job Templates UI to populate the available-projects panel.
// ---------------------------------------------------------------------------
router.get("/job-templates/projects", async (_req, res): Promise<void> => {
  const [latestImport] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);

  if (!latestImport) {
    res.json({ tlt: [], ntlt: [] });
    return;
  }

  // Three queries in parallel:
  //   1. Distinct (job, category, mfcBatch) combos for the pool display
  //   2. Distinct (job, structure, mfcBatch) to map structure → mfc for TLT
  //   3. All order_review_rows for (project, structure) → woOrderQtyMt
  //
  // WO qty mirrors the frontend job-dashboard approach: sum woOrderQtyMt from the
  // Order Review file, grouped by mfcBatch via the structure→mfc mapping from WIP.
  const [rows, structRows, orRows] = await Promise.all([
    db
      .selectDistinct({
        job: recordPoolTable.job,
        category: recordPoolTable.category,
        mfcBatch: recordPoolTable.mfcBatch,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(
        and(
          eq(importRowsTable.importId, latestImport.id),
          sql`${recordPoolTable.job} IS NOT NULL`,
        ),
      )
      .orderBy(recordPoolTable.job, recordPoolTable.mfcBatch),

    // Distinct (job, structure, mfcBatch) — gives us structure→mfc mapping.
    db
      .selectDistinct({
        job: recordPoolTable.job,
        structure: recordPoolTable.structure,
        mfcBatch: recordPoolTable.mfcBatch,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(
        and(
          eq(importRowsTable.importId, latestImport.id),
          sql`${recordPoolTable.job} IS NOT NULL`,
          sql`${recordPoolTable.category} = 'TLT'`,
          sql`${recordPoolTable.structure} IS NOT NULL`,
        ),
      ),

    // woOrderQtyMt per (project, structure) from the Order Review snapshot.
    db
      .select({
        project: orderReviewRowsTable.project,
        structure: orderReviewRowsTable.structure,
        woOrderQtyMt: orderReviewRowsTable.woOrderQtyMt,
      })
      .from(orderReviewRowsTable),
  ]);

  // Build lookup: "project|structure" → woOrderQtyMt (MT).
  const orMap = new Map<string, number>();
  for (const r of orRows) {
    if (r.woOrderQtyMt != null) {
      orMap.set(`${r.project}|${r.structure}`, r.woOrderQtyMt);
    }
  }

  // Aggregate woOrderQtyMt per (job, mfcBatch) combo key — same logic as
  // the frontend's orderByMfc: one structure maps to one mfcBatch, so we sum
  // the OR qty for each distinct (job, structure) once, credited to its mfc.
  const tltQty: Record<string, number> = {};
  for (const s of structRows) {
    if (!s.job || !s.structure) continue;
    const mfc = s.mfcBatch || "Z";
    const orQty = orMap.get(`${s.job}|${s.structure}`) ?? 0;
    const comboKey = s.mfcBatch ? `${s.job} - ${s.mfcBatch}` : s.job;
    tltQty[comboKey] = (tltQty[comboKey] ?? 0) + orQty;
  }

  const tlt: string[] = [];
  const ntlt: string[] = [];
  for (const r of rows) {
    if (!r.job) continue;
    if (r.category === "TLT") {
      tlt.push(r.mfcBatch ? `${r.job} - ${r.mfcBatch}` : r.job);
    } else {
      ntlt.push(r.job);
    }
  }
  const dedup = (arr: string[]) => [...new Set(arr)];

  res.json({ tlt: dedup(tlt), ntlt: dedup(ntlt), tltQty });
});

// ---------------------------------------------------------------------------
// POST /api/job-templates
// Create a new template for the given category. Auto-generates a name.
// Body: { category: "TLT" | "NTLT" }
// ---------------------------------------------------------------------------
router.post("/job-templates", async (req, res): Promise<void> => {
  const { category } = req.body as { category: string };
  if (category !== "TLT" && category !== "NTLT") {
    res.status(400).json({ error: "category must be TLT or NTLT" });
    return;
  }

  const existing = await db
    .select({ name: jobTemplatesTable.name })
    .from(jobTemplatesTable)
    .where(eq(jobTemplatesTable.category, category));

  const name = nextName(category, existing.map((r) => r.name));

  // Sort order = count of existing templates in this category
  const sortOrder = existing.length;

  const [created] = await db
    .insert(jobTemplatesTable)
    .values({ name, category, sortOrder })
    .returning();

  res.status(201).json({ id: created.id, name: created.name, category: created.category, sortOrder: created.sortOrder, members: [] });
});

// ---------------------------------------------------------------------------
// PUT /api/job-templates/:id/members
// Replace the member list for a template.
// Body: { members: string[] }
// ---------------------------------------------------------------------------
router.put("/job-templates/:id/members", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  const { members } = req.body as { members: string[] };
  if (!Array.isArray(members)) {
    res.status(400).json({ error: "members must be an array" });
    return;
  }

  const normalized = [...new Set(members.map((m) => m.trim()).filter(Boolean))].sort();

  await db.transaction(async (tx) => {
    // Delete all current members for this template
    await tx
      .delete(jobTemplateMembersTable)
      .where(eq(jobTemplateMembersTable.templateId, id));

    // Insert new members
    if (normalized.length > 0) {
      await tx.insert(jobTemplateMembersTable).values(
        normalized.map((code) => ({ templateId: id, projectCode: code })),
      );
    }
  });

  res.json({ id, members: normalized });
});

// ---------------------------------------------------------------------------
// DELETE /api/job-templates/:id
// Delete a template and all its members (cascade).
// ---------------------------------------------------------------------------
router.delete("/job-templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  await db.delete(jobTemplatesTable).where(eq(jobTemplatesTable.id, id));
  res.json({ deleted: id });
});

export default router;
