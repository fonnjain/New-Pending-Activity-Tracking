import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { requireAuth } from "./auth";
import {
  parseCurrentJobsFile,
  ingestCurrentJobs,
  loadCurrentJobs,
  clearCurrentJobs,
} from "../lib/currentJobs";

// "Current Jobs" — a small additive overlay: upload a plain list of project
// codes (.xlsx/.xls), which then powers a "Current Jobs" option in the
// existing Job filter (set-membership, restricts every page). Each upload
// REPLACES the list. Never touches WIP/Order Review parsing, hash/dedup,
// Activity, qty, or ageing.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

router.post(
  "/current-jobs/upload",
  requireAuth,
  uploadSingle,
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    let codes: string[];
    try {
      ({ codes } = parseCurrentJobsFile(req.file.buffer));
    } catch {
      res.status(400).json({ error: "Could not read the uploaded file" });
      return;
    }
    if (codes.length === 0) {
      res.status(400).json({ error: "No project codes found in the file" });
      return;
    }
    const { header } = await ingestCurrentJobs(req.file.originalname, codes);
    res.json({
      id: header.id,
      fileName: header.fileName,
      uploadedAt: header.uploadedAt,
      codeCount: header.codeCount,
      matchedCount: header.matchedCount,
      unmatched: header.unmatched,
      codes,
    });
  },
);

router.get("/current-jobs", async (_req, res): Promise<void> => {
  const { codes, meta } = await loadCurrentJobs();
  res.json({
    codes,
    meta: meta
      ? {
          id: meta.id,
          fileName: meta.fileName,
          uploadedAt: meta.uploadedAt,
          codeCount: meta.codeCount,
          matchedCount: meta.matchedCount,
          unmatched: meta.unmatched,
        }
      : null,
  });
});

router.delete("/current-jobs", requireAuth, async (_req, res): Promise<void> => {
  await clearCurrentJobs();
  res.status(204).end();
});

export default router;
