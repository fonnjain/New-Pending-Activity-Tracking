import { pgTable, serial, text, real, timestamp, jsonb } from "drizzle-orm/pg-core";

// One entry in the alias_entries jsonb array. Each entry is a raw contractor
// string that should map to the proposal's canonicalKey.
export interface AliasEntry {
  rawName: string;
  normalizedKey: string;
}

// AI-generated (or upload-triggered) merge proposals awaiting human review.
// status:
//   'pending'  — not yet reviewed
//   'approved' — reviewer accepted the merge; alias rows have been written
//   'rejected' — reviewer rejected; no aliases written
// confidence: 0–1 float from the AI (null for upload-triggered proposals)
// reason: AI's stated rationale (null for upload-triggered proposals)
export const contractorDedupProposalsTable = pgTable(
  "contractor_dedup_proposals",
  {
    id: serial("id").primaryKey(),
    canonicalKey: text("canonical_key").notNull(),
    canonicalDisplay: text("canonical_display").notNull(),
    aliasEntries: jsonb("alias_entries")
      .$type<AliasEntry[]>()
      .notNull()
      .default([]),
    confidence: real("confidence"),
    reason: text("reason"),
    // 'pending' | 'approved' | 'rejected'
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
);

export type ContractorDedupProposalRow =
  typeof contractorDedupProposalsTable.$inferSelect;
