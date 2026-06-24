import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import importsRouter from "./imports";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(importsRouter);
router.use(aiRouter);

export default router;
