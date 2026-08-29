import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userSessionLogTable = pgTable("user_session_log", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  loginAt: timestamp("login_at", { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastClientState: text("last_client_state"),
  lastPagePath: text("last_page_path"),
  logoutAt: timestamp("logout_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  busySeconds: integer("busy_seconds").notNull().default(0),
  idleSeconds: integer("idle_seconds").notNull().default(0),
});

export type UserSessionLogRow = typeof userSessionLogTable.$inferSelect;
export type UserSessionLogInsert = typeof userSessionLogTable.$inferInsert;

export const userUsageEventTable = pgTable(
  "user_usage_event",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    sessionId: text("session_id"),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    pagePath: text("page_path"),
    pageLabel: text("page_label"),
    reportName: text("report_name"),
    fileType: text("file_type"),
  },
  (table) => ({
    userOccurredAtIdx: index("user_usage_event_user_occurred_at_idx").on(
      table.userId,
      table.occurredAt,
    ),
    sessionOccurredAtIdx: index("user_usage_event_session_occurred_at_idx").on(
      table.sessionId,
      table.occurredAt,
    ),
  }),
);

export const userSessionActivitySegmentTable = pgTable(
  "user_session_activity_segment",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    state: text("state").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    pagePath: text("page_path"),
  },
  (table) => ({
    sessionStartedAtIdx: index("user_session_segment_session_started_at_idx").on(
      table.sessionId,
      table.startedAt,
    ),
    userStartedAtIdx: index("user_session_segment_user_started_at_idx").on(
      table.userId,
      table.startedAt,
    ),
  }),
);

export type UserUsageEventRow = typeof userUsageEventTable.$inferSelect;
export type UserUsageEventInsert = typeof userUsageEventTable.$inferInsert;
export type UserSessionActivitySegmentRow =
  typeof userSessionActivitySegmentTable.$inferSelect;
export type UserSessionActivitySegmentInsert =
  typeof userSessionActivitySegmentTable.$inferInsert;
