import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import importsRouter from "./imports";
import aiRouter from "./ai";
import settingsRouter from "./settings";
import thicknessRouter from "./thickness";
import contractorCategoriesRouter from "./contractorCategories";
import fabricationPrioritiesRouter from "./fabricationPriorities";
import orderStatusRouter from "./orderStatus";
import adminRouter from "./admin";
import inventoryRouter from "./inventory";
import currentJobsRouter from "./currentJobs";
import releaseBalanceRouter from "./releaseBalance";
import fabricationProjectCompletionRouter from "./fabricationProjectCompletion";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(importsRouter);
router.use(aiRouter);
router.use(settingsRouter);
router.use(thicknessRouter);
router.use(contractorCategoriesRouter);
router.use(fabricationPrioritiesRouter);
router.use(orderStatusRouter);
router.use(adminRouter);
router.use(inventoryRouter);
router.use(currentJobsRouter);
router.use(releaseBalanceRouter);
router.use(fabricationProjectCompletionRouter);

export default router;
