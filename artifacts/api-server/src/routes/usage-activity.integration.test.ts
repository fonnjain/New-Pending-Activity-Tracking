import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { mock } from "node:test";
import bcrypt from "bcryptjs";
import { asc, eq } from "drizzle-orm";
import {
  appUsersTable,
  db,
  userSessionActivitySegmentTable,
  userSessionLogTable,
  userUsageEventTable,
} from "@workspace/db";
import app from "../app";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const START_MS = Date.parse("2026-08-27T23:50:00.000Z");
const USER_ID = "usage-boundary-test-user";
const USER_EMAIL = "usage-boundary-test@example.invalid";
const LEGACY_SESSION_ID = "usage-boundary-legacy-session";
const PASSWORD = "UsageBoundary@2026";

type ActivitySession = {
  id: string;
  loginAt: string;
  logoutAt: string | null;
  durationSeconds: number | null;
  busySeconds: number | null;
  idleSeconds: number | null;
};

type ActivityResponse = {
  days: Array<{ date: string; sessions: ActivitySession[] }>;
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine usage-test port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test(
  "usage activity preserves five-minute boundaries, rollover, logout, and UTC-day totals",
  { timeout: 60_000 },
  async () => {
    mock.timers.enable({ apis: ["Date"], now: START_MS });
    let server: Server | null = null;
    let cookie = "";

    const cleanup = async () => {
      await db
        .delete(userUsageEventTable)
        .where(eq(userUsageEventTable.userId, USER_ID));
      await db
        .delete(userSessionActivitySegmentTable)
        .where(eq(userSessionActivitySegmentTable.userId, USER_ID));
      await db
        .delete(userSessionLogTable)
        .where(eq(userSessionLogTable.userId, USER_ID));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, USER_ID));
    };

    try {
      await cleanup();
      const passwordHash = await bcrypt.hash(PASSWORD, 4);
      await db.insert(appUsersTable).values({
        id: USER_ID,
        email: USER_EMAIL,
        displayName: "Usage Boundary Test",
        passwordHash,
        role: "admin",
        mustChangePassword: false,
      });

      server = createServer(app);
      const port = await listen(server);
      const baseUrl = `http://127.0.0.1:${port}/api`;
      const request = async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set("cookie", cookie);
        return fetch(`${baseUrl}${path}`, { ...init, headers });
      };
      const jsonRequest = (path: string, body: unknown, method = "POST") =>
        request(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const login = await jsonRequest("/auth/login", {
        email: USER_EMAIL,
        password: PASSWORD,
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert.ok(cookie, "Login must set an authenticated session cookie");

      const heartbeat = async (state: "busy" | "idle") => {
        const response = await jsonRequest("/auth/heartbeat", {
          state,
          pagePath: "/",
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
      };

      // The first heartbeat anchors the measured interval. Exactly five
      // minutes is still known activity; only the later request beyond that
      // boundary rolls the session and caps the old interval.
      await heartbeat("busy");
      mock.timers.setTime(START_MS + FIVE_MINUTES_MS);
      await heartbeat("idle");
      mock.timers.setTime(START_MS + 2 * FIVE_MINUTES_MS);
      await heartbeat("busy");
      mock.timers.setTime(START_MS + 3 * FIVE_MINUTES_MS + 1_000);
      await heartbeat("idle");

      let sessions = await db
        .select()
        .from(userSessionLogTable)
        .where(eq(userSessionLogTable.userId, USER_ID))
        .orderBy(asc(userSessionLogTable.loginAt));
      assert.equal(sessions.length, 2);
      const rolledSession = sessions[0]!;
      const replacementSession = sessions[1]!;
      assert.equal(rolledSession.durationSeconds, 900);
      assert.equal(rolledSession.busySeconds, 600);
      assert.equal(rolledSession.idleSeconds, 300);
      assert.equal(
        rolledSession.logoutAt?.toISOString(),
        "2026-08-28T00:05:00.000Z",
      );

      const rolledSegments = await db
        .select()
        .from(userSessionActivitySegmentTable)
        .where(eq(userSessionActivitySegmentTable.sessionId, rolledSession.id))
        .orderBy(asc(userSessionActivitySegmentTable.startedAt));
      assert.deepEqual(
        rolledSegments.map((segment) => ({
          state: segment.state,
          startedAt: segment.startedAt.toISOString(),
          endedAt: segment.endedAt.toISOString(),
          durationSeconds: segment.durationSeconds,
        })),
        [
          {
            state: "busy",
            startedAt: "2026-08-27T23:50:00.000Z",
            endedAt: "2026-08-27T23:55:00.000Z",
            durationSeconds: 300,
          },
          {
            state: "idle",
            startedAt: "2026-08-27T23:55:00.000Z",
            endedAt: "2026-08-28T00:00:00.000Z",
            durationSeconds: 300,
          },
          {
            state: "busy",
            startedAt: "2026-08-28T00:00:00.000Z",
            endedAt: "2026-08-28T00:05:00.000Z",
            durationSeconds: 300,
          },
        ],
      );

      // Explicit logout happens much later, but the final idle interval is
      // known only through the five-minute boundary.
      mock.timers.setTime(START_MS + 35 * 60 * 1000 + 1_000);
      const logout = await jsonRequest("/auth/logout", {});
      assert.equal(logout.status, 200);
      assert.deepEqual(await logout.json(), { authenticated: false });

      sessions = await db
        .select()
        .from(userSessionLogTable)
        .where(eq(userSessionLogTable.userId, USER_ID))
        .orderBy(asc(userSessionLogTable.loginAt));
      const closedReplacement = sessions.find(
        (session) => session.id === replacementSession.id,
      )!;
      assert.equal(closedReplacement.durationSeconds, 300);
      assert.equal(closedReplacement.busySeconds, 0);
      assert.equal(closedReplacement.idleSeconds, 300);
      assert.equal(
        closedReplacement.logoutAt?.toISOString(),
        "2026-08-28T00:10:01.000Z",
      );

      // A session created before heartbeat tracking existed has no measured
      // interval and must remain explicitly unknown in the report.
      await db.insert(userSessionLogTable).values({
        id: LEGACY_SESSION_ID,
        userId: USER_ID,
        email: USER_EMAIL,
        displayName: "Usage Boundary Test",
        loginAt: new Date(Date.parse("2026-08-28T00:20:00.000Z")),
      });

      // The logout response clears the browser's cookie, but keep the local
      // header so this request still represents the authenticated admin.
      const activity = await request("/users/activity?days=90");
      assert.equal(activity.status, 200);
      const body = await activity.json() as ActivityResponse;
      const day = (date: string) => body.days.find((entry) => entry.date === date);
      const august27 = day("2026-08-27");
      const august28 = day("2026-08-28");
      assert.ok(august27);
      assert.ok(august28);

      const rolledOnAugust27 = august27.sessions.find(
        (session) => session.id === rolledSession.id,
      )!;
      assert.deepEqual(
        {
          durationSeconds: rolledOnAugust27.durationSeconds,
          busySeconds: rolledOnAugust27.busySeconds,
          idleSeconds: rolledOnAugust27.idleSeconds,
        },
        { durationSeconds: 600, busySeconds: 300, idleSeconds: 300 },
      );

      const rolledOnAugust28 = august28.sessions.find(
        (session) => session.id === rolledSession.id,
      )!;
      assert.deepEqual(
        {
          durationSeconds: rolledOnAugust28.durationSeconds,
          busySeconds: rolledOnAugust28.busySeconds,
          idleSeconds: rolledOnAugust28.idleSeconds,
        },
        { durationSeconds: 300, busySeconds: 300, idleSeconds: 0 },
      );

      const replacementOnAugust28 = august28.sessions.find(
        (session) => session.id === replacementSession.id,
      )!;
      assert.deepEqual(
        {
          durationSeconds: replacementOnAugust28.durationSeconds,
          busySeconds: replacementOnAugust28.busySeconds,
          idleSeconds: replacementOnAugust28.idleSeconds,
        },
        { durationSeconds: 300, busySeconds: 0, idleSeconds: 300 },
      );

      const legacy = august28.sessions.find(
        (session) => session.id === LEGACY_SESSION_ID,
      )!;
      assert.equal(legacy.durationSeconds, null);
      assert.equal(legacy.busySeconds, null);
      assert.equal(legacy.idleSeconds, null);
    } finally {
      if (server) await close(server);
      await cleanup();
      mock.timers.reset();
    }
  },
);