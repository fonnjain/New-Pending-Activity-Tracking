import { Router, type IRouter } from "express";
import healthRouter from "./health";
import importsRouter from "./imports";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(importsRouter);
router.use(aiRouter);

export default router;
