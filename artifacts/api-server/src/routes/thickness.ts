import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  db,
  rsjThicknessTable,
  manualThicknessTable,
  importRowsTable,
  recordPoolTable,
} from "@workspace/db";
import { UpsertRsjThicknessBody, UpsertManualThicknessBody } from "@workspace/api-zod";
import { normalizeItemExactKey, normalizeItemStrippedKey } from "@workspace/domain";
import { requireAuth } from "./auth";
import { clearThicknessCache, loadThicknessLookups, evictSerializedRecordsCache } from "./imports";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
  clearThicknessCache();
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
  clearThicknessCache();
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
  clearThicknessCache();
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
    clearThicknessCache();
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// POST /manual-thickness/apply-item-master
// For all marks in the given import that are NOT already manually pinned,
// run the item-master exact→stripped key lookup and bulk-upsert any matches
// into manual_thickness, then clear the thickness + serialised-records caches
// so the next /records fetch reflects the new pins. Requires auth.
// ---------------------------------------------------------------------------
router.post(
  "/manual-thickness/apply-item-master",
  requireAuth,
  async (req, res): Promise<void> => {
    const importId = Number(req.body?.importId);
    if (!Number.isInteger(importId) || importId <= 0) {
      res.status(400).json({ error: "importId must be a positive integer" });
      return;
    }

    // Load item-master lookup maps (uses the shared in-process cache).
    const lookups = await loadThicknessLookups();

    // Fetch all already-pinned markIds so we can skip them.
    const pinned = await db.select({ markId: manualThicknessTable.markId }).from(manualThicknessTable);
    const pinnedSet = new Set(pinned.map((p) => p.markId));

    // Distinct (markId, section) pairs for this import, excluding already-pinned marks.
    const rows = await db
      .selectDistinct({
        markId: recordPoolTable.markId,
        section: recordPoolTable.section,
      })
      .from(importRowsTable)
      .innerJoin(recordPoolTable, eq(importRowsTable.poolId, recordPoolTable.id))
      .where(eq(importRowsTable.importId, importId));

    // Use a Map to deduplicate by markId — selectDistinct returns (markId,section)
    // pairs, so the same markId can appear with multiple sections. Inserting
    // duplicate PKs in a single INSERT … ON CONFLICT DO UPDATE causes PostgreSQL
    // to throw "command cannot affect row a second time". First match wins.
    const toInsertMap = new Map<string, number>();
    let alreadyPinned = 0;
    let noMatch = 0;

    for (const r of rows) {
      if (pinnedSet.has(r.markId)) { alreadyPinned++; continue; }
      if (toInsertMap.has(r.markId)) continue; // already resolved via another section row
      const section = r.section ?? "";
      // Exact key first.
      const exactKey = normalizeItemExactKey(section);
      const exactHit = lookups.masterExactMap?.get(exactKey);
      if (exactHit != null && exactHit > 0) {
        toInsertMap.set(r.markId, exactHit);
        continue;
      }
      // Stripped key fallback.
      const strippedKey = normalizeItemStrippedKey(section);
      const strippedHit = strippedKey ? lookups.masterStrippedMap?.get(strippedKey) : undefined;
      if (strippedHit != null && strippedHit > 0) {
        toInsertMap.set(r.markId, strippedHit);
        continue;
      }
      noMatch++;
    }

    const toInsert = Array.from(toInsertMap, ([markId, thicknessMm]) => ({ markId, thicknessMm }));

    // Bulk-upsert in chunks.
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await db
        .insert(manualThicknessTable)
        .values(toInsert.slice(i, i + CHUNK).map((v) => ({ markId: v.markId, thicknessMm: v.thicknessMm })))
        .onConflictDoUpdate({
          target: manualThicknessTable.markId,
          set: { thicknessMm: sql`excluded.thickness_mm`, updatedAt: new Date() },
        });
    }

    clearThicknessCache();
    evictSerializedRecordsCache(importId);

    res.json({ applied: toInsert.length, noMatch, alreadyPinned });
  },
);

// ---------------------------------------------------------------------------
// POST /manual-thickness/import-xlsx
// Accepts a multipart .xlsx/.xls file. Scans the first 10 rows for a header
// containing BOTH a "mark" column and a "thickness" column (case-insensitive).
// A header must be found — there is no column-position fallback.  This prevents
// files like the VTPL item-master (which has an Item Code column containing
// numeric-looking strings) from being silently misread and corrupting the DB.
//
// Thickness values must also be in a plausible engineering range (1–150 mm).
// Values outside that range are rejected with an error row; they are never
// inserted.  Requires auth.
// ---------------------------------------------------------------------------
// MAX_THICKNESS_MM — wall thicknesses above this value are rejected as
// implausible.  Real galvanizing steel sections are at most ~80 mm; 150 mm
// gives generous headroom while still catching item-code numbers misread as
// thicknesses (those parse as 100,000,000+ mm).
const MAX_THICKNESS_MM = 150;

router.post(
  "/manual-thickness/import-xlsx",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      const importIdRaw = req.body?.importId ? Number(req.body.importId) : null;

      let wb: XLSX.WorkBook;
      try {
        wb = XLSX.read(req.file.buffer, { type: "buffer" });
      } catch {
        res.status(400).json({ error: "Could not parse file — ensure it is a valid .xlsx or .xls" });
        return;
      }
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) {
        res.status(400).json({ error: "Workbook has no sheets" });
        return;
      }
      const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (!rawRows.length) {
        res.status(400).json({ error: "Sheet is empty" });
        return;
      }

      // Detect header row: scan first 10 rows for one that has BOTH a "mark"
      // column AND a "thickness" column.  No fallback — a missing header means
      // the wrong file was uploaded, not that we should guess column positions.
      let headerIdx = -1;
      let markCol = -1;
      let thicknessCol = -1;
      for (let ri = 0; ri < Math.min(10, rawRows.length); ri++) {
        const row = rawRows[ri].map((c) => String(c ?? "").toLowerCase().trim());
        const mIdx = row.findIndex(
          (c) => c === "mark" || c === "mark id" || c === "markid" || c === "mark_id",
        );
        const tIdx = row.findIndex(
          (c) => c.includes("thick") || c === "mm" || c === "thickness mm",
        );
        if (mIdx >= 0 && tIdx >= 0) {
          headerIdx = ri;
          markCol = mIdx;
          thicknessCol = tIdx;
          break;
        }
      }

      if (headerIdx < 0) {
        res.status(400).json({
          error:
            "No mark/thickness header found in the first 10 rows. " +
            "This endpoint accepts files with a 'Mark' column and a 'Thickness' (mm) column. " +
            "If you are trying to upload the VTPL item master, use the Item Master card on the Data tab instead.",
        });
        return;
      }

      const dataRows = rawRows.slice(headerIdx + 1);
      const toInsert: { markId: string; thicknessMm: number }[] = [];
      const errors: string[] = [];

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const markRaw = row[markCol];
        const thickRaw = row[thicknessCol];
        const markId = String(markRaw ?? "").trim();
        if (!markId) continue;
        const thicknessMm = parseFloat(String(thickRaw ?? ""));
        if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) {
          errors.push(
            `Row ${headerIdx + i + 2}: "${markId}" — thickness "${thickRaw}" is not a valid positive number`,
          );
          continue;
        }
        if (thicknessMm > MAX_THICKNESS_MM) {
          errors.push(
            `Row ${headerIdx + i + 2}: "${markId}" — thickness ${thicknessMm} mm exceeds the ` +
            `maximum plausible value (${MAX_THICKNESS_MM} mm). Check that the thickness column ` +
            `is in millimetres, not microns or some other unit.`,
          );
          continue;
        }
        toInsert.push({ markId, thicknessMm });
      }

      if (!toInsert.length) {
        res.status(400).json({
          error: "No valid rows found in file",
          details: errors.slice(0, 20),
        });
        return;
      }

      // Deduplicate by markId before inserting — same markId appearing twice in a
      // single INSERT … ON CONFLICT DO UPDATE causes PostgreSQL to error.
      const deduped = Array.from(
        new Map(toInsert.map((v) => [v.markId, v])).values(),
      );

      const CHUNK = 500;
      for (let i = 0; i < deduped.length; i += CHUNK) {
        await db
          .insert(manualThicknessTable)
          .values(
            deduped
              .slice(i, i + CHUNK)
              .map((v) => ({ markId: v.markId, thicknessMm: v.thicknessMm })),
          )
          .onConflictDoUpdate({
            target: manualThicknessTable.markId,
            set: { thicknessMm: sql`excluded.thickness_mm`, updatedAt: new Date() },
          });
      }

      clearThicknessCache();
      if (importIdRaw && Number.isInteger(importIdRaw) && importIdRaw > 0) {
        evictSerializedRecordsCache(importIdRaw);
      } else {
        evictSerializedRecordsCache(); // clear all if no importId supplied
      }

      res.json({ imported: deduped.length, skipped: errors.length, errors: errors.slice(0, 20) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Import failed: ${msg}` });
    }
  },
);

export default router;
