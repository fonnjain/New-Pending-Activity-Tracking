import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { appUsersTable, userSessionLogTable, type AppUserRow } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";

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

    res.cookie(COOKIE_NAME, user.id, {
      ...cookieOptions(),
      signed: true,
      maxAge: MAX_AGE_MS,
    });

    // Record login session (best-effort)
    db.insert(userSessionLogTable)
      .values({ userId: user.id, email: user.email, displayName: user.displayName })
      .catch((err) => req.log.warn({ err }, "Failed to record login session"));

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

router.post("/auth/logout", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req);
  res.clearCookie(COOKIE_NAME, cookieOptions());

  // Close the most recent open session for this user (best-effort)
  if (userId) {
    try {
      const open = await db
        .select({ id: userSessionLogTable.id, loginAt: userSessionLogTable.loginAt })
        .from(userSessionLogTable)
        .where(and(eq(userSessionLogTable.userId, userId), isNull(userSessionLogTable.logoutAt)))
        .orderBy(desc(userSessionLogTable.loginAt))
        .limit(1);
      if (open.length > 0) {
        const now = new Date();
        const durationSeconds = Math.round(
          (now.getTime() - open[0]!.loginAt.getTime()) / 1000,
        );
        await db
          .update(userSessionLogTable)
          .set({ logoutAt: now, durationSeconds })
          .where(eq(userSessionLogTable.id, open[0]!.id));
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to close session log on logout");
    }
  }

  res.json({ authenticated: false });
});

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
