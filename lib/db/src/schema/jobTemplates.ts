import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Named sets of project codes for the global Job filter.
// Replaces the single "Current Jobs" excel-upload with UI-managed, named groups.
// Each template belongs to exactly one category (TLT | NTLT) and is auto-named
// "TLT Job A", "TLT Job B", … by the server.
export const jobTemplatesTable = pgTable("job_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // e.g. "TLT Job A"
  category: text("category").notNull(), // "TLT" | "NTLT"
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobTemplateRow = typeof jobTemplatesTable.$inferSelect;

// Members of each template (project codes).
export const jobTemplateMembersTable = pgTable(
  "job_template_members",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => jobTemplatesTable.id, { onDelete: "cascade" }),
    projectCode: text("project_code").notNull(),
  },
  (t) => [
    unique("job_template_members_uniq").on(t.templateId, t.projectCode),
  ],
);

export type JobTemplateMemberRow = typeof jobTemplateMembersTable.$inferSelect;
