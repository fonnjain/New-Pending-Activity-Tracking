import { Router, type IRouter } from "express";
import { db, jobTemplatesTable, jobTemplateMembersTable, importRowsTable, recordPoolTable, importsTable } from "@workspace/db";
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

  const rows = await db
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
    .orderBy(recordPoolTable.job, recordPoolTable.mfcBatch);

  const tlt: string[] = [];
  const ntlt: string[] = [];
  for (const r of rows) {
    if (!r.job) continue;
    if (r.category === "TLT") {
      // Use "job - mfcBatch" combo so each batch is a distinct selectable unit.
      // Records with no batch (null or the "Z" sentinel for blank) are keyed as
      // the plain job code.
      const batch = r.mfcBatch && r.mfcBatch !== "Z" ? r.mfcBatch : null;
      tlt.push(batch ? `${r.job} - ${batch}` : r.job);
    } else {
      ntlt.push(r.job);
    }
  }
  // Deduplicate while preserving order (selectDistinct already deduplicates at DB
  // level but the mfcBatch=null grouping can still produce duplicates after formatting).
  const dedup = (arr: string[]) => [...new Set(arr)];

  res.json({ tlt: dedup(tlt), ntlt: dedup(ntlt) });
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
