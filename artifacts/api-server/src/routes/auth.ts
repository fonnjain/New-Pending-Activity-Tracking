import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  appUsersTable,
  userSessionActivitySegmentTable,
  userSessionLogTable,
  userUsageEventTable,
  type AppUserRow,
} from "@workspace/db";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import {
  DEV_STAGING_FIXTURE_PROJECT,
  DEV_STAGING_FIXTURE_ROW_HASH,
  isDevelopmentStagingFixtureRuntime,
} from "../lib/dev-staging-fixture";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AppUserRow;
    }
  }
}

const router: IRouter = Router();

const COOKIE_NAME = "vtpl_auth";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function getSessionUserId(req: Request): string | null {
  const val = req.signedCookies?.[COOKIE_NAME];
  return typeof val === "string" && val.length > 0 ? val : null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

async function loadUser(userId: string): Promise<AppUserRow | null> {
  const rows = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getSessionUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const user = await loadUser(userId);
    if (!user) {
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req);
  if (!userId) {
    res.json({ authenticated: false });
    return;
  }
  try {
    const user = await loadUser(userId);
    if (!user) {
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    });
  } catch {
    res.json({ authenticated: false });
  }
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.email, email))
      .limit(1);
    const user = rows[0];

    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const loginAt = new Date();
    res.cookie(COOKIE_NAME, user.id, {
      ...cookieOptions(),
      signed: true,
      maxAge: MAX_AGE_MS,
    });

    // Await when possible so the first page visit usually attaches to this
    // session, but never reject a valid login because the audit is unavailable.
    try {
      await withUsageSessionLock(user.id, (tx) =>
        tx.insert(userSessionLogTable)
          .values({
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            loginAt,
          }),
      );
    } catch (err) {
      req.log.warn({ err }, "Failed to record login session");
    }

    res.json({
      authenticated: true,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const USAGE_EVENT_TYPES = new Set(["page_visit", "report_generated", "visibility"]);
const USAGE_PAGE_LABELS: Record<string, string> = {
  "/": "Overview",
  "/jobs": "Project Wise",
  "/activity": "Activity Wise",
  "/contractor": "Contractor Wise",
  "/plant": "Plant Operation Wise",
  "/inventory": "Bucket List",
  "/reports": "Reports",
  "/turnaround": "Turn Around Time",
  "/stuck": "Speed of Execution",
  "/data": "Data",
  "/job-templates": "Job Templates",
  "/computed-fg": "Computed FG",
  "/order-reconciliation": "Order Reconciliation",
  "/release-balance": "Release Balance",
  "/order-review-generated": "Generated Order Review",
  "/order-status": "Order Status",
  "/contractor-setup": "Contractor Setup",
  "/warning-parameters": "Warning Parameters",
  "/thickness": "Thickness",
  "/data-check": "Data Check",
  "/erp-rules": "ERP Rules",
  "/bucket-list-dates": "Bucket List Dates",
  "/users": "Users & Usage Activity",
};
const USAGE_REPORTS: Record<string, { name: string; fileType: string }> = {
  spreadsheet_export: { name: "Spreadsheet Export", fileType: "xlsx" },
  report_export: { name: "Report Export", fileType: "xlsx" },
  plant_operation_fabrication: { name: "Plant Operation — Fabrication", fileType: "xlsx" },
  plant_operation_galvanization: { name: "Plant Operation — Galvanization", fileType: "xlsx" },
  contractor_performance: { name: "Contractor Performance", fileType: "xlsx" },
  fabrication_load: { name: "Fabrication Load", fileType: "xlsx" },
  generated_order_review: { name: "Generated Order Review", fileType: "xlsx" },
  item_master_thickness: { name: "Item Master Thickness", fileType: "csv" },
  import_data_export: { name: "Import Data Export", fileType: "json" },
  report_archive: { name: "Report Archive", fileType: "zip" },
  ai_turnaround_report: { name: "AI Turnaround Report", fileType: "pdf" },
};

type UsageState = "busy" | "idle";
type UsageDatabase = Pick<typeof db, "select" | "insert" | "update" | "execute">;

function cleanUsageText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function cleanPagePath(value: unknown): string | null {
  const path = cleanUsageText(value, 240);
  if (!path || !path.startsWith("/")) return null;
  const withoutQuery = path.split(/[?#]/, 1)[0] || "/";
  const canonical = withoutQuery === "/production"
    ? "/"
    : withoutQuery.startsWith("/production/")
      ? withoutQuery.slice("/production".length)
      : withoutQuery;
  return Object.hasOwn(USAGE_PAGE_LABELS, canonical) ? canonical : null;
}

function cleanUsageState(value: unknown): UsageState {
  return value === "busy" ? "busy" : "idle";
}

async function withUsageSessionLock<T>(
  userId: string,
  operation: (tx: UsageDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    return operation(tx);
  });
}

async function createUsageSession(
  database: UsageDatabase,
  user: AppUserRow,
  now: Date,
  state: UsageState,
  pagePath: string | null,
) {
  const rows = await database
    .insert(userSessionLogTable)
    .values({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      loginAt: now,
      lastActivityAt: state === "busy" ? now : null,
      lastHeartbeatAt: now,
      lastClientState: state,
      lastPagePath: pagePath,
    })
    .returning({ id: userSessionLogTable.id });
  return rows[0]?.id ?? null;
}

async function getOrCreateUsageSession(
  database: UsageDatabase,
  user: AppUserRow,
  now: Date,
) {
  const open = await database
    .select({
      id: userSessionLogTable.id,
      loginAt: userSessionLogTable.loginAt,
      lastHeartbeatAt: userSessionLogTable.lastHeartbeatAt,
      lastClientState: userSessionLogTable.lastClientState,
      lastPagePath: userSessionLogTable.lastPagePath,
      busySeconds: userSessionLogTable.busySeconds,
      idleSeconds: userSessionLogTable.idleSeconds,
    })
    .from(userSessionLogTable)
    .where(and(eq(userSessionLogTable.userId, user.id), isNull(userSessionLogTable.logoutAt)))
    .orderBy(desc(userSessionLogTable.loginAt))
    .limit(1);
  if (open[0]) {
    const session = open[0];
    const anchor = session.lastHeartbeatAt ?? session.loginAt;
    if (now.getTime() - anchor.getTime() <= IDLE_TIMEOUT_MS) return session.id;

    const state: UsageState = session.lastClientState === "busy" ? "busy" : "idle";
    const knownSeconds = Math.round(IDLE_TIMEOUT_MS / 1000);
    const logoutAt = new Date(anchor.getTime() + IDLE_TIMEOUT_MS);
    if (session.lastHeartbeatAt) {
      await database.insert(userSessionActivitySegmentTable).values({
        sessionId: session.id,
        userId: user.id,
        state,
        startedAt: anchor,
        endedAt: logoutAt,
        durationSeconds: knownSeconds,
        pagePath: session.lastPagePath,
      });
    }
    await database
      .update(userSessionLogTable)
      .set({
        logoutAt,
        durationSeconds: Math.max(0, Math.round((logoutAt.getTime() - session.loginAt.getTime()) / 1000)),
        busySeconds: (session.busySeconds ?? 0) + (state === "busy" ? knownSeconds : 0),
        idleSeconds: (session.idleSeconds ?? 0) + (state === "idle" ? knownSeconds : 0),
      })
      .where(eq(userSessionLogTable.id, session.id));
  }
  return createUsageSession(database, user, now, "busy", null);
}

router.post("/auth/heartbeat", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const user = req.user!;
  const now = new Date();
  const body = (req.body ?? {}) as { state?: unknown; pagePath?: unknown };
  const state = cleanUsageState(body.state);
  const pagePath = cleanPagePath(body.pagePath);

  try {
    await withUsageSessionLock(userId, async (tx) => {
      // Serialize session mutation per user. Multiple browser tabs may send
      // heartbeats near-simultaneously; without this lock their intervals can
      // overlap and counters can be lost.
      const open = await tx
      .select({
        id: userSessionLogTable.id,
        loginAt: userSessionLogTable.loginAt,
        lastActivityAt: userSessionLogTable.lastActivityAt,
        lastHeartbeatAt: userSessionLogTable.lastHeartbeatAt,
        lastClientState: userSessionLogTable.lastClientState,
        lastPagePath: userSessionLogTable.lastPagePath,
        busySeconds: userSessionLogTable.busySeconds,
        idleSeconds: userSessionLogTable.idleSeconds,
      })
      .from(userSessionLogTable)
      .where(and(eq(userSessionLogTable.userId, userId), isNull(userSessionLogTable.logoutAt)))
      .orderBy(desc(userSessionLogTable.loginAt))
      .limit(1);

    if (open.length === 0) {
      // No open session at all — create one (e.g. user was already logged in before this feature)
      await tx.insert(userSessionLogTable).values({
        userId,
        email: user.email,
        displayName: user.displayName,
        loginAt: now,
        lastActivityAt: state === "busy" ? now : null,
        lastHeartbeatAt: now,
        lastClientState: state,
        lastPagePath: pagePath,
      });
    } else {
      const session = open[0]!;
      const anchor = session.lastHeartbeatAt ?? session.loginAt;
      const elapsedSeconds = Math.max(0, Math.round(
        (now.getTime() - anchor.getTime()) / 1000,
      ));
      const previousState: UsageState =
        session.lastClientState === "busy" ? "busy" : "idle";

      if (elapsedSeconds <= Math.round(IDLE_TIMEOUT_MS / 1000)) {
        if (elapsedSeconds > 0 && session.lastHeartbeatAt) {
          await tx.insert(userSessionActivitySegmentTable).values({
            sessionId: session.id,
            userId,
            state: previousState,
            startedAt: anchor,
            endedAt: now,
            durationSeconds: elapsedSeconds,
            pagePath: session.lastPagePath,
          });
        }
        await tx
          .update(userSessionLogTable)
          .set({
            lastActivityAt: state === "busy" ? now : session.lastActivityAt,
            lastHeartbeatAt: now,
            lastClientState: state,
            lastPagePath: pagePath,
            busySeconds: (session.busySeconds ?? 0) +
              (previousState === "busy" ? elapsedSeconds : 0),
            idleSeconds: (session.idleSeconds ?? 0) +
              (previousState === "idle" ? elapsedSeconds : 0),
          })
          .where(eq(userSessionLogTable.id, session.id));
      } else {
        // A missing signal beyond the idle boundary ends the old session. Count
        // only the known five-minute window, never the entire unknown gap.
        const knownSeconds = Math.round(IDLE_TIMEOUT_MS / 1000);
        const logoutAt = new Date(anchor.getTime() + IDLE_TIMEOUT_MS);
        const durationSeconds = Math.max(0, Math.round(
          (logoutAt.getTime() - session.loginAt.getTime()) / 1000,
        ));
        if (session.lastHeartbeatAt) {
          await tx.insert(userSessionActivitySegmentTable).values({
            sessionId: session.id,
            userId,
            state: previousState,
            startedAt: anchor,
            endedAt: logoutAt,
            durationSeconds: knownSeconds,
            pagePath: session.lastPagePath,
          });
        }
        await tx
          .update(userSessionLogTable)
          .set({
            logoutAt,
            durationSeconds,
            busySeconds: (session.busySeconds ?? 0) +
              (previousState === "busy" ? knownSeconds : 0),
            idleSeconds: (session.idleSeconds ?? 0) +
              (previousState === "idle" ? knownSeconds : 0),
          })
          .where(eq(userSessionLogTable.id, session.id));

        const rows = await tx
          .insert(userSessionLogTable)
          .values({
            userId,
            email: user.email,
            displayName: user.displayName,
            loginAt: now,
            lastActivityAt: state === "busy" ? now : null,
            lastHeartbeatAt: now,
            lastClientState: state,
            lastPagePath: pagePath,
          })
          .returning({ id: userSessionLogTable.id });
        if (!rows[0]?.id) throw new Error("Failed to start a usage session");
      }
      }
    });

    res.json({ ok: true });
  } catch (err) {
    req.log.warn({ err }, "Heartbeat error");
    res.json({ ok: false });
  }
});

router.post("/auth/usage-event", requireAuth, async (req, res): Promise<void> => {
  const user = req.user!;
  const body = (req.body ?? {}) as {
    eventType?: unknown;
    pagePath?: unknown;
    pageLabel?: unknown;
    reportKey?: unknown;
  };
  const eventType = cleanUsageText(body.eventType, 40);
  if (!eventType || !USAGE_EVENT_TYPES.has(eventType)) {
    res.status(400).json({ error: "Unsupported usage event type" });
    return;
  }

  const pagePath = cleanPagePath(body.pagePath);
  const visibilityState = body.pageLabel === "visible" || body.pageLabel === "hidden"
    ? body.pageLabel
    : null;
  const reportKey = cleanUsageText(body.reportKey, 80);
  const report = reportKey ? USAGE_REPORTS[reportKey] : undefined;
  if (eventType === "page_visit" && !pagePath) {
    res.status(400).json({ error: "Page path is required" });
    return;
  }
  if (eventType === "report_generated" && !report) {
    res.status(400).json({ error: "Supported report key is required" });
    return;
  }

  try {
    const now = new Date();
    const sessionId = await withUsageSessionLock(
      user.id,
      (tx) => getOrCreateUsageSession(tx, user, now),
    );
    await db.insert(userUsageEventTable).values({
      userId: user.id,
      sessionId,
      eventType,
      occurredAt: now,
      pagePath,
      pageLabel: eventType === "page_visit"
        ? (pagePath ? USAGE_PAGE_LABELS[pagePath] : null)
        : eventType === "visibility"
          ? visibilityState
          : null,
      reportName: report?.name ?? null,
      fileType: report?.fileType ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.warn({ err }, "Usage event error");
    res.json({ ok: false });
  }
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req);
  res.clearCookie(COOKIE_NAME, cookieOptions());

  // Close the most recent open session for this user (best-effort)
  if (userId) {
    try {
      await withUsageSessionLock(userId, async (tx) => {
      const open = await tx
        .select({
          id: userSessionLogTable.id,
          loginAt: userSessionLogTable.loginAt,
          lastHeartbeatAt: userSessionLogTable.lastHeartbeatAt,
          lastClientState: userSessionLogTable.lastClientState,
          lastPagePath: userSessionLogTable.lastPagePath,
          busySeconds: userSessionLogTable.busySeconds,
          idleSeconds: userSessionLogTable.idleSeconds,
        })
        .from(userSessionLogTable)
        .where(and(eq(userSessionLogTable.userId, userId), isNull(userSessionLogTable.logoutAt)))
        .orderBy(desc(userSessionLogTable.loginAt))
        .limit(1);
      if (open.length > 0) {
        const now = new Date();
        const session = open[0]!;
        const anchor = session.lastHeartbeatAt ?? session.loginAt;
        const elapsedSeconds = session.lastHeartbeatAt
          ? Math.min(
              Math.max(0, Math.round((now.getTime() - anchor.getTime()) / 1000)),
              Math.round(IDLE_TIMEOUT_MS / 1000),
            )
          : 0;
        const previousState: UsageState =
          session.lastClientState === "busy" ? "busy" : "idle";
        if (elapsedSeconds > 0 && session.lastHeartbeatAt) {
          await tx.insert(userSessionActivitySegmentTable).values({
            sessionId: session.id,
            userId,
            state: previousState,
            startedAt: anchor,
            endedAt: new Date(anchor.getTime() + elapsedSeconds * 1000),
            durationSeconds: elapsedSeconds,
            pagePath: session.lastPagePath,
          });
        }
        const logoutAt = new Date(anchor.getTime() + elapsedSeconds * 1000);
        const durationSeconds = Math.round(
          (logoutAt.getTime() - session.loginAt.getTime()) / 1000,
        );
        await tx
          .update(userSessionLogTable)
          .set({
            logoutAt,
            durationSeconds,
            busySeconds: (session.busySeconds ?? 0) +
              (previousState === "busy" ? elapsedSeconds : 0),
            idleSeconds: (session.idleSeconds ?? 0) +
              (previousState === "idle" ? elapsedSeconds : 0),
          })
          .where(eq(userSessionLogTable.id, session.id));
      }
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to close session log on logout");
    }
  }

  res.json({ authenticated: false });
});

// This cleanup exists solely for the browser staging-safeguard check. It is
// unavailable outside NODE_ENV=development and removes only the orphaned
// fixture row identified by both its reserved project marker and full-row hash.
router.post(
  "/auth/dev-staging-fixture-cleanup",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!isDevelopmentStagingFixtureRuntime()) {
      res.sendStatus(404);
      return;
    }
    try {
      const deleted = await db.execute(sql`
        DELETE FROM "record_pool" AS pool
        WHERE pool."job" = ${DEV_STAGING_FIXTURE_PROJECT}
          AND pool."hash" = ${DEV_STAGING_FIXTURE_ROW_HASH}
          AND NOT EXISTS (
            SELECT 1
            FROM "import_rows" AS membership
            WHERE membership."pool_id" = pool."id"
          )
        RETURNING pool."id"
      `);
      res.json({ deletedPoolRows: deleted.rowCount ?? 0 });
    } catch (err) {
      req.log.error({ err }, "Development staging fixture cleanup failed");
      res.status(500).json({ error: "Development staging fixture cleanup failed" });
    }
  },
);

router.post(
  "/auth/change-password",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.user!;
    const body = (req.body ?? {}) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";

    if (!newPassword || newPassword.length < 6) {
      res
        .status(400)
        .json({ error: "New password must be at least 6 characters" });
      return;
    }

    try {
      const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!currentOk) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await db
        .update(appUsersTable)
        .set({
          passwordHash: newHash,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(appUsersTable.id, user.id));

      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, "Change password error");
      res.status(500).json({ error: "Failed to change password" });
    }
  },
);

export default router;
