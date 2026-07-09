import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { appUsersTable, userSessionLogTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "./auth";

const DEFAULT_PASSWORD = "Vtpl@2026";

const router: IRouter = Router();

router.get(
  "/users",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    try {
      const users = await db
        .select({
          id: appUsersTable.id,
          email: appUsersTable.email,
          displayName: appUsersTable.displayName,
          role: appUsersTable.role,
          mustChangePassword: appUsersTable.mustChangePassword,
          createdAt: appUsersTable.createdAt,
        })
        .from(appUsersTable)
        .orderBy(appUsersTable.email);
      res.json({ users });
    } catch (err) {
      req.log.error({ err }, "List users error");
      res.status(500).json({ error: "Failed to list users" });
    }
  },
);

router.post(
  "/users",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as {
      email?: unknown;
      displayName?: unknown;
      role?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : null;
    const role =
      body.role === "admin" || body.role === "user"
        ? (body.role as "admin" | "user")
        : "user";

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    try {
      const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      const rows = await db
        .insert(appUsersTable)
        .values({
          email,
          displayName: displayName || null,
          passwordHash,
          role,
          mustChangePassword: true,
        })
        .returning({
          id: appUsersTable.id,
          email: appUsersTable.email,
          displayName: appUsersTable.displayName,
          role: appUsersTable.role,
          mustChangePassword: appUsersTable.mustChangePassword,
          createdAt: appUsersTable.createdAt,
        });
      res.status(201).json({ user: rows[0] });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "23505") {
        res.status(409).json({ error: "Email already exists" });
        return;
      }
      req.log.error({ err }, "Create user error");
      res.status(500).json({ error: "Failed to create user" });
    }
  },
);

router.put(
  "/users/:id/reset-password",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const { id } = req.params;
    try {
      const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      const rows = await db
        .update(appUsersTable)
        .set({
          passwordHash,
          mustChangePassword: true,
          updatedAt: new Date(),
        })
        .where(eq(appUsersTable.id, id))
        .returning({ id: appUsersTable.id, email: appUsersTable.email });

      if (rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ success: true, email: rows[0]!.email });
    } catch (err) {
      req.log.error({ err }, "Reset password error");
      res.status(500).json({ error: "Failed to reset password" });
    }
  },
);

router.put(
  "/users/:id/role",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const { id } = req.params;
    const body = (req.body ?? {}) as { role?: unknown };
    const role =
      body.role === "admin" || body.role === "user"
        ? (body.role as "admin" | "user")
        : null;
    if (!role) {
      res.status(400).json({ error: "role must be 'admin' or 'user'" });
      return;
    }
    try {
      const rows = await db
        .update(appUsersTable)
        .set({ role, updatedAt: new Date() })
        .where(eq(appUsersTable.id, id))
        .returning({ id: appUsersTable.id });
      if (rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, "Update role error");
      res.status(500).json({ error: "Failed to update role" });
    }
  },
);

router.delete(
  "/users/:id",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const { id } = req.params;
    if (id === req.user!.id) {
      res.status(400).json({ error: "Cannot delete your own account" });
      return;
    }
    try {
      const rows = await db
        .delete(appUsersTable)
        .where(eq(appUsersTable.id, id))
        .returning({ email: appUsersTable.email });
      if (rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, "Delete user error");
      res.status(500).json({ error: "Failed to delete user" });
    }
  },
);

router.get(
  "/users/activity",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    try {
      const sessions = await db
        .select()
        .from(userSessionLogTable)
        .orderBy(desc(userSessionLogTable.loginAt));

      // Group by UTC date (YYYY-MM-DD)
      const byDate = new Map<
        string,
        Array<typeof sessions[number]>
      >();
      for (const s of sessions) {
        const day = s.loginAt.toISOString().slice(0, 10);
        if (!byDate.has(day)) byDate.set(day, []);
        byDate.get(day)!.push(s);
      }

      const days = Array.from(byDate.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, sess]) => ({
          date,
          sessions: sess.map((s) => ({
            id: s.id,
            userId: s.userId,
            email: s.email,
            displayName: s.displayName ?? null,
            loginAt: s.loginAt.toISOString(),
            logoutAt: s.logoutAt ? s.logoutAt.toISOString() : null,
            durationSeconds: s.durationSeconds ?? null,
          })),
        }));

      res.json({ days, totalSessions: sessions.length });
    } catch (err) {
      req.log.error({ err }, "Get user activity error");
      res.status(500).json({ error: "Failed to get user activity" });
    }
  },
);

export default router;
