import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  appUsersTable,
  userSessionActivitySegmentTable,
  userSessionLogTable,
  userUsageEventTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { requireAuth, requireAdmin } from "./auth";
import { getSingleRouteParam } from "../lib/route-boundaries";

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
      password?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : null;
    const password = typeof body.password === "string" ? body.password : "";
    const role =
      body.role === "admin" || body.role === "user"
        ? (body.role as "admin" | "user")
        : "user";

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    if (password.length < 6) {
      res
        .status(400)
        .json({ error: "Initial password must be at least 6 characters" });
      return;
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
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
    const id = getSingleRouteParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
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
    const id = getSingleRouteParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
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
    const id = getSingleRouteParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
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
      const requestedDays = Number(req.query.days);
      const retentionDays = Number.isFinite(requestedDays)
        ? Math.min(365, Math.max(1, Math.floor(requestedDays)))
        : 90;
      const parseDateOnly = (value: unknown): Date | null => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
          ? null
          : parsed;
      };
      const startDateParam = typeof req.query.startDate === "string" ? req.query.startDate : null;
      const endDateParam = typeof req.query.endDate === "string" ? req.query.endDate : null;
      const hasCustomRange = startDateParam !== null || endDateParam !== null;
      const parsedStart = parseDateOnly(startDateParam ?? endDateParam);
      const parsedEnd = parseDateOnly(endDateParam ?? startDateParam);
      if (hasCustomRange && (!parsedStart || !parsedEnd)) {
        res.status(400).json({ error: "Dates must use YYYY-MM-DD format" });
        return;
      }
      const now = new Date();
      const since = parsedStart ?? new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const until = parsedEnd
        ? new Date(parsedEnd.getTime() + 24 * 60 * 60 * 1000)
        : now;
      if (since >= until) {
        res.status(400).json({ error: "Start date must be on or before end date" });
        return;
      }
      const requestedUserId = typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : null;
      const sessionRange = and(
        lt(userSessionLogTable.loginAt, until),
        or(
          gte(userSessionLogTable.logoutAt, since),
          isNull(userSessionLogTable.logoutAt),
        ),
      );
      const sessionWhere = requestedUserId
        ? and(sessionRange, eq(userSessionLogTable.userId, requestedUserId))
        : sessionRange;
      const sessions = await db
        .select()
        .from(userSessionLogTable)
        .where(sessionWhere)
        .orderBy(desc(userSessionLogTable.loginAt))
        .limit(5_000);

      const sessionIds = sessions.map((s) => s.id);
      const events = sessionIds.length
        ? await db
            .select()
            .from(userUsageEventTable)
            .where(
              and(
                inArray(userUsageEventTable.sessionId, sessionIds),
                gte(userUsageEventTable.occurredAt, since),
                lt(userUsageEventTable.occurredAt, until),
              ),
            )
            .orderBy(userUsageEventTable.occurredAt)
            .limit(30_000)
        : [];
      const segments = sessionIds.length
        ? await db
            .select()
            .from(userSessionActivitySegmentTable)
            .where(
              and(
                inArray(userSessionActivitySegmentTable.sessionId, sessionIds),
                lt(userSessionActivitySegmentTable.startedAt, until),
                gt(userSessionActivitySegmentTable.endedAt, since),
              ),
            )
            .limit(30_000)
        : [];
      const eventsBySession = new Map<string, typeof events>();
      for (const event of events) {
        if (!event.sessionId) continue;
        const list = eventsBySession.get(event.sessionId) ?? [];
        list.push(event);
        eventsBySession.set(event.sessionId, list);
      }
      const segmentsBySession = new Map<string, typeof segments>();
      for (const segment of segments) {
        const list = segmentsBySession.get(segment.sessionId) ?? [];
        list.push(segment);
        segmentsBySession.set(segment.sessionId, list);
      }

      type TimelineEntry = {
        kind: string;
        at: string;
        pagePath: string | null;
        pageLabel: string | null;
        reportName: string | null;
        fileType: string | null;
      };
      type DaySlice = {
        busySeconds: number;
        idleSeconds: number;
        timeline: TimelineEntry[];
        pageVisitCount: number;
        reportCount: number;
      };
      const utcDay = (value: Date) => value.toISOString().slice(0, 10);
      const firstDay = utcDay(since);
      const byDate = new Map<string, Array<Record<string, unknown>>>();

      for (const session of sessions) {
        const sessionEvents = eventsBySession.get(session.id) ?? [];
        const sessionSegments = segmentsBySession.get(session.id) ?? [];
        const hasUsageData = session.lastHeartbeatAt !== null || sessionSegments.length > 0;
        const slices = new Map<string, DaySlice>();
        const ensureSlice = (date: string) => {
          if (date < firstDay) return null;
          const existing = slices.get(date);
          if (existing) return existing;
          const created: DaySlice = {
            busySeconds: 0,
            idleSeconds: 0,
            timeline: [],
            pageVisitCount: 0,
            reportCount: 0,
          };
          slices.set(date, created);
          return created;
        };
        const addTimeline = (at: Date, entry: Omit<TimelineEntry, "at">) => {
          ensureSlice(utcDay(at))?.timeline.push({ ...entry, at: at.toISOString() });
        };

        addTimeline(session.loginAt, {
          kind: "session_start",
          pagePath: null,
          pageLabel: null,
          reportName: null,
          fileType: null,
        });
        for (const event of sessionEvents) {
          const slice = ensureSlice(utcDay(event.occurredAt));
          if (!slice) continue;
          slice.timeline.push({
            kind: event.eventType,
            at: event.occurredAt.toISOString(),
            pagePath: event.pagePath ?? null,
            pageLabel: event.pageLabel ?? null,
            reportName: event.reportName ?? null,
            fileType: event.fileType ?? null,
          });
          if (event.eventType === "page_visit") slice.pageVisitCount += 1;
          if (event.eventType === "report_generated") slice.reportCount += 1;
        }
        for (const segment of sessionSegments) {
          let cursor = segment.startedAt;
          while (cursor < segment.endedAt) {
            const nextDay = new Date(Date.UTC(
              cursor.getUTCFullYear(),
              cursor.getUTCMonth(),
              cursor.getUTCDate() + 1,
            ));
            const end = nextDay < segment.endedAt ? nextDay : segment.endedAt;
            const seconds = Math.max(0, Math.round((end.getTime() - cursor.getTime()) / 1000));
            const slice = ensureSlice(utcDay(cursor));
            if (slice) {
              if (segment.state === "busy") slice.busySeconds += seconds;
              else slice.idleSeconds += seconds;
            }
            cursor = end;
          }
        }
        if (session.logoutAt) {
          addTimeline(session.logoutAt, {
            kind: "session_end",
            pagePath: null,
            pageLabel: null,
            reportName: null,
            fileType: null,
          });
        }

        for (const [date, slice] of slices) {
          const heartbeatOnDate = session.lastHeartbeatAt && utcDay(session.lastHeartbeatAt) === date;
          const result = byDate.get(date) ?? [];
          result.push({
            id: session.id,
            userId: session.userId,
            email: session.email,
            displayName: session.displayName ?? null,
            loginAt: session.loginAt.toISOString(),
            lastActivityAt: heartbeatOnDate && session.lastActivityAt
              ? session.lastActivityAt.toISOString()
              : null,
            lastHeartbeatAt: heartbeatOnDate && session.lastHeartbeatAt
              ? session.lastHeartbeatAt.toISOString()
              : null,
            lastClientState: heartbeatOnDate &&
                (session.lastClientState === "busy" || session.lastClientState === "idle")
              ? session.lastClientState
              : null,
            lastPagePath: heartbeatOnDate ? session.lastPagePath ?? null : null,
            logoutAt: session.logoutAt && utcDay(session.logoutAt) === date
              ? session.logoutAt.toISOString()
              : null,
            durationSeconds: hasUsageData ? slice.busySeconds + slice.idleSeconds : null,
            busySeconds: hasUsageData ? slice.busySeconds : null,
            idleSeconds: hasUsageData ? slice.idleSeconds : null,
            pageVisitCount: slice.pageVisitCount,
            reportCount: slice.reportCount,
            timeline: slice.timeline.sort((a, b) => a.at.localeCompare(b.at)),
          });
          byDate.set(date, result);
        }
      }

      const resultDays = Array.from(byDate.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, daySessions]) => ({ date, sessions: daySessions }));

      res.json({ days: resultDays, totalSessions: sessions.length });
    } catch (err) {
      req.log.error({ err }, "Get user activity error");
      res.status(500).json({ error: "Failed to get user activity" });
    }
  },
);

export default router;
