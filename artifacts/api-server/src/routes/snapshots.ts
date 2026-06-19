import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { desc, eq, or, inArray } from "drizzle-orm";
import {
  db,
  snapshotsTable,
  recordsTable,
  type InsertRecord,
} from "@workspace/db";
import {
  GetSnapshotParams,
  GetSnapshotRecordsParams,
  DeleteSnapshotParams,
} from "@workspace/api-zod";
import { parseWorkbook, computeAgeing, computeRoute } from "../lib/parse";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Wrap multer so upload errors (oversize, malformed multipart) return deterministic JSON.
const uploadSingle: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: `Upload error: ${err.message}` });
      return;
    }
    if (err) {
      res.status(400).json({ error: "Could not read the uploaded file" });
      return;
    }
    next();
  });
};

const router: IRouter = Router();

function serializeRecord(r: typeof recordsTable.$inferSelect) {
  const { routeSteps, currentStepIndex } = computeRoute(
    r.operation,
    r.activity,
  );
  return {
    id: r.id,
    snapshotId: r.snapshotId,
    markId: r.markId,
    job: r.job,
    structure: r.structure,
    markTail: r.markTail,
    section: r.section,
    grade: r.grade,
    wtPcs: r.wtPcs,
    balanceQty: r.balanceQty,
    balanceWt: r.balanceWt,
    activity: r.activity,
    operation: r.operation,
    assignDate: r.assignDate,
    contractor: r.contractor,
    orderNature: r.orderNature,
    towerType: r.towerType,
    ageingDays: computeAgeing(r.assignDate),
    routeSteps,
    currentStepIndex,
  };
}

router.get("/snapshots", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(snapshotsTable)
    .orderBy(desc(snapshotsTable.createdAt));
  res.json(rows);
});

router.post(
  "/snapshots",
  uploadSingle,
  async (req, res): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const labelRaw =
      typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const label = labelRaw.length > 0 ? labelRaw : null;

    const reportDateRaw =
      typeof req.body?.reportDate === "string" ? req.body.reportDate.trim() : "";
    const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(reportDateRaw)
      ? reportDateRaw
      : null;

    let parsed;
    try {
      parsed = parseWorkbook(file.buffer);
    } catch (err) {
      req.log.warn({ err }, "Failed to parse workbook");
      res
        .status(400)
        .json({ error: "Could not parse the uploaded file as an .xlsx report" });
      return;
    }

    if (parsed.records.length === 0) {
      res.status(400).json({
        error:
          "No marks found in the file. Check that the sheet has a header on the third row and a 'Mark No.' column.",
      });
      return;
    }

    // A re-upload with the same report date OR the same label replaces the
    // matching snapshot(s). Match + delete + insert happen in one transaction
    // to avoid races creating duplicates for the same logical key.
    const matchConditions = [
      reportDate ? eq(snapshotsTable.reportDate, reportDate) : undefined,
      label ? eq(snapshotsTable.label, label) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const { snapshot, replaced } = await db.transaction(async (tx) => {
      let replacedCount = 0;
      if (matchConditions.length > 0) {
        const matches = await tx
          .select({ id: snapshotsTable.id })
          .from(snapshotsTable)
          .where(or(...matchConditions))
          .for("update");
        if (matches.length > 0) {
          replacedCount = matches.length;
          await tx.delete(snapshotsTable).where(
            inArray(
              snapshotsTable.id,
              matches.map((m) => m.id),
            ),
          );
        }
      }

      const [snap] = await tx
        .insert(snapshotsTable)
        .values({
          label,
          sourceFilename: file.originalname,
          reportDate,
          summary: parsed.summary,
        })
        .returning();

      const values: InsertRecord[] = parsed.records.map((r) => ({
        ...r,
        snapshotId: snap.id,
      }));

      const chunkSize = 500;
      for (let i = 0; i < values.length; i += chunkSize) {
        await tx.insert(recordsTable).values(values.slice(i, i + chunkSize));
      }

      return { snapshot: snap, replaced: replacedCount > 0 };
    });

    res.status(201).json({
      snapshot,
      replaced,
    });
  },
);

router.get("/snapshots/:id", async (req, res): Promise<void> => {
  const params = GetSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [snap] = await db
    .select()
    .from(snapshotsTable)
    .where(eq(snapshotsTable.id, params.data.id));

  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  res.json(snap);
});

router.delete("/snapshots/:id", async (req, res): Promise<void> => {
  const params = DeleteSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(snapshotsTable)
    .where(eq(snapshotsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/snapshots/:id/records", async (req, res): Promise<void> => {
  const params = GetSnapshotRecordsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [snap] = await db
    .select({ id: snapshotsTable.id })
    .from(snapshotsTable)
    .where(eq(snapshotsTable.id, params.data.id));

  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  const rows = await db
    .select()
    .from(recordsTable)
    .where(eq(recordsTable.snapshotId, params.data.id))
    .orderBy(recordsTable.markId);

  res.json(rows.map(serializeRecord));
});

export default router;
