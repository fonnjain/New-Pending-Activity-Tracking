import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userSessionLogTable = pgTable("user_session_log", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  loginAt: timestamp("login_at", { withTimezone: true }).notNull().defaultNow(),
  logoutAt: timestamp("logout_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
});

export type UserSessionLogRow = typeof userSessionLogTable.$inferSelect;
export type UserSessionLogInsert = typeof userSessionLogTable.$inferInsert;
