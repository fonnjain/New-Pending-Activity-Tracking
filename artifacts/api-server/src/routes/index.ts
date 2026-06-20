import { Router, type IRouter } from "express";
import healthRouter from "./health";
import importsRouter from "./imports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(importsRouter);

export default router;
