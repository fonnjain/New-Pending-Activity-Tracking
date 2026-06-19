import { Router, type IRouter } from "express";
import healthRouter from "./health";
import snapshotsRouter from "./snapshots";

const router: IRouter = Router();

router.use(healthRouter);
router.use(snapshotsRouter);

export default router;
