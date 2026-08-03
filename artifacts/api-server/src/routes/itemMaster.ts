import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { eq, sql } from "drizzle-orm";
import { db, itemMasterTable } from "@workspace/db";
import {
  normalizeItemExactKey,
  normalizeItemStrippedKey,
} from "@workspace/domain";
import { requireAuth } from "./auth";
import { clearThicknessCache } from "./imports";

const router: IRouter = Router();

// 50 MB cap — the item master XLS is ~6 MB; allow generous headroom.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// POST /item-master/upload
// Parses an item-master XLS/XLSX file, upserts all data rows (row index 4+),
// clears the thickness cache so the new lookups take effect immediately.
// Requires authentication.
// ---------------------------------------------------------------------------
router.post(
  "/item-master/upload",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch {
      res.status(400).json({ error: "Could not parse file as XLS/XLSX" });
      return;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      defval: null,
    });

    // Header is on row index 3; data starts at row index 4.
    // Columns: 0=Select 1=ItemCode 2=ItemName 3=SubGroup 4=GroupName
    //          5=Category 6=Grade 7=SectionWt 8=ThicknessMM
    const dataRows = rawRows.slice(4);

    const rows: (typeof itemMasterTable.$inferInsert)[] = [];
    for (const r of dataRows) {
      const itemCode = String(r[1] ?? "").trim();
      if (!itemCode) continue;
      const itemName = String(r[2] ?? "").trim();
      const thicknessRaw = r[8];
      const thicknessMm =
        thicknessRaw != null && thicknessRaw !== ""
          ? parseFloat(String(thicknessRaw))
          : null;

      rows.push({
        itemCode,
        itemName,
        subGroup: r[3] != null ? String(r[3]).trim() : null,
        groupName: r[4] != null ? String(r[4]).trim() : null,
        category: r[5] != null ? String(r[5]).trim() : null,
        grade: r[6] != null ? String(r[6]).trim() : null,
        sectionWtMmM2:
          r[7] != null && r[7] !== "" ? parseFloat(String(r[7])) : null,
        thicknessMm:
          thicknessMm != null && Number.isFinite(thicknessMm) && thicknessMm > 0
            ? thicknessMm
            : null,
        exactKey: normalizeItemExactKey(itemName),
        strippedKey: normalizeItemStrippedKey(itemName),
      });
    }

    if (rows.length === 0) {
      res.status(400).json({ error: "No data rows found in file" });
      return;
    }

    // Upsert in batches of 500 to avoid parameter limits.
    const BATCH = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await db
        .insert(itemMasterTable)
        .values(batch)
        .onConflictDoUpdate({
          target: itemMasterTable.itemCode,
          set: {
            itemName: sql`excluded.item_name`,
            subGroup: sql`excluded.sub_group`,
            groupName: sql`excluded.group_name`,
            category: sql`excluded.category`,
            grade: sql`excluded.grade`,
            sectionWtMmM2: sql`excluded.section_wt_mm_m2`,
            thicknessMm: sql`excluded.thickness_mm`,
            exactKey: sql`excluded.exact_key`,
            strippedKey: sql`excluded.stripped_key`,
            updatedAt: new Date(),
          },
        });
      upserted += batch.length;
    }

    // Invalidate the in-process thickness cache so next /records hit re-builds
    // the lookup maps from the freshly upserted master data.
    clearThicknessCache();

    res.json({
      totalRows: rows.length,
      upserted,
      rowsWithThickness: rows.filter((r) => r.thicknessMm != null).length,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /item-master/thickness-rows
// Returns all item-master rows that have a thickness value (non-FG JOB WORK),
// grouped by group_name and sorted alphabetically within each group.
// ---------------------------------------------------------------------------
router.get("/item-master/thickness-rows", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      itemCode: itemMasterTable.itemCode,
      itemName: itemMasterTable.itemName,
      groupName: itemMasterTable.groupName,
      thicknessMm: itemMasterTable.thicknessMm,
    })
    .from(itemMasterTable)
    .where(
      sql`${itemMasterTable.thicknessMm} is not null
          and ${itemMasterTable.thicknessMm} > 0
          and coalesce(${itemMasterTable.groupName}, '') <> 'FG JOB WORK'`,
    )
    .orderBy(
      sql`coalesce(${itemMasterTable.groupName}, '')`,
      itemMasterTable.itemName,
    );

  // Group by groupName
  const groupMap = new Map<string, { itemCode: string; itemName: string; thicknessMm: number }[]>();
  for (const row of rows) {
    const key = row.groupName ?? "(Other)";
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push({
      itemCode: row.itemCode,
      itemName: row.itemName,
      thicknessMm: row.thicknessMm!,
    });
  }

  const groups = Array.from(groupMap.entries()).map(([groupName, items]) => ({
    groupName,
    items,
  }));

  res.json(groups);
});

// ---------------------------------------------------------------------------
// GET /item-master/stats
// Returns summary statistics about the loaded item master (no auth required —
// this is display-only data used by the admin upload card).
// ---------------------------------------------------------------------------
router.get("/item-master/stats", async (_req, res): Promise<void> => {
  const [totRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(itemMasterTable);
  const [thkRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(itemMasterTable)
    .where(
      sql`${itemMasterTable.thicknessMm} is not null and ${itemMasterTable.itemName} not ilike '%(JW)%'`,
    );
  const [latestRow] = await db
    .select({ updatedAt: itemMasterTable.updatedAt })
    .from(itemMasterTable)
    .orderBy(sql`${itemMasterTable.updatedAt} desc`)
    .limit(1);

  res.json({
    totalRows: totRow?.count ?? 0,
    rowsWithThickness: thkRow?.count ?? 0,
    lastUploadedAt: latestRow?.updatedAt ?? null,
  });
});

export default router;
