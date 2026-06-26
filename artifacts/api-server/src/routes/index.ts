import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import importsRouter from "./imports";
import aiRouter from "./ai";
import settingsRouter from "./settings";
import thicknessRouter from "./thickness";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(importsRouter);
router.use(aiRouter);
router.use(settingsRouter);
router.use(thicknessRouter);

export default router;
