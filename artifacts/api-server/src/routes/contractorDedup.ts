import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  db,
  contractorAliasesTable,
  contractorDedupProposalsTable,
  contractorCategoriesTable,
  recordPoolTable,
  type AliasEntry,
} from "@workspace/db";
import { normalizeContractorName } from "@workspace/domain";
import { requireAuth } from "./auth";
import {
  AI_MODEL_STANDARD,
  callClaude,
  parseJsonObject,
} from "../lib/ai";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /contractor-aliases
// Returns all approved alias mappings (normalizedAlias → canonicalKey + rawName).
// Public (read-only); the frontend uses this to build the resolution map.
// ---------------------------------------------------------------------------
router.get("/contractor-aliases", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(contractorAliasesTable)
    .orderBy(contractorAliasesTable.rawName);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /contractor-dedup/pending-count
// Returns the count of proposals still awaiting review.
// ---------------------------------------------------------------------------
router.get(
  "/contractor-dedup/pending-count",
  async (_req, res): Promise<void> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contractorDedupProposalsTable)
      .where(eq(contractorDedupProposalsTable.status, "pending"));
    res.json({ count: row?.count ?? 0 });
  },
);

// ---------------------------------------------------------------------------
// GET /contractor-dedup/proposals
// Returns all proposals, newest first. Optional ?status= filter.
// ---------------------------------------------------------------------------
router.get("/contractor-dedup/proposals", async (req, res): Promise<void> => {
  const statusFilter = req.query.status
    ? String(req.query.status)
    : undefined;
  const rows = await db
    .select()
    .from(contractorDedupProposalsTable)
    .where(
      statusFilter
        ? eq(contractorDedupProposalsTable.status, statusFilter)
        : undefined,
    )
    .orderBy(sql`${contractorDedupProposalsTable.createdAt} DESC`);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /contractor-dedup/analyze
// Reads all distinct contractor strings (from record_pool + contractor_categories),
// filters out strings that are already in contractor_aliases or have a pending
// proposal, then calls Claude to propose merge groups.
// Returns the newly-created proposal rows.
// Requires auth.
// ---------------------------------------------------------------------------
router.post(
  "/contractor-dedup/analyze",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      // --- Gather all known contractor strings ---
      const [poolRows, catRows, aliasRows, existingProposals] =
        await Promise.all([
          db
            .selectDistinct({ contractor: recordPoolTable.contractor })
            .from(recordPoolTable)
            .where(sql`${recordPoolTable.contractor} is not null and ${recordPoolTable.contractor} <> ''`),
          db
            .select({
              nameKey: contractorCategoriesTable.nameKey,
              displayName: contractorCategoriesTable.displayName,
            })
            .from(contractorCategoriesTable),
          db.select().from(contractorAliasesTable),
          db
            .select({
              canonicalKey: contractorDedupProposalsTable.canonicalKey,
              aliasEntries: contractorDedupProposalsTable.aliasEntries,
              status: contractorDedupProposalsTable.status,
            })
            .from(contractorDedupProposalsTable),
        ]);

      // Build a set of normalized keys already covered by alias mappings or
      // real merge proposals. Approved aliases and canonical keys from contractor_categories
      // are covered via the allNormalized/catRows pass below.
      const coveredKeys = new Set<string>();
      for (const a of aliasRows) {
        coveredKeys.add(a.aliasKey);
        coveredKeys.add(a.canonicalKey);
      }
      for (const p of existingProposals) {
        if (p.status === "rejected") continue;
        const entries = (p.aliasEntries as AliasEntry[]) ?? [];
        // "New contractor" notifications have no alias entries — they remain
        // eligible for AI analysis even when pending. Only real merge proposals
        // (aliasEntries.length > 0) should block re-analysis of their key set,
        // otherwise a flagged-but-unanalyzed name can never be merged by AI.
        if (entries.length === 0) continue;
        coveredKeys.add(p.canonicalKey);
        for (const e of entries) coveredKeys.add(e.normalizedKey);
      }

      // Collect all distinct normalized strings.
      const allNormalized = new Map<string, string>(); // normalizedKey → best rawName
      for (const r of poolRows) {
        const raw = r.contractor?.trim();
        if (!raw) continue;
        const key = normalizeContractorName(raw);
        if (!allNormalized.has(key)) allNormalized.set(key, raw);
      }
      for (const c of catRows) {
        if (!allNormalized.has(c.nameKey))
          allNormalized.set(c.nameKey, c.displayName);
      }

      // Only pass un-covered strings to the AI.
      const candidates: { normalizedKey: string; rawName: string }[] = [];
      for (const [key, raw] of allNormalized) {
        if (!coveredKeys.has(key)) {
          candidates.push({ normalizedKey: key, rawName: raw });
        }
      }

      if (candidates.length === 0) {
        res.json({ proposals: [], message: "No new candidates to analyze." });
        return;
      }

      if (!req.body?.force && candidates.length < 2) {
        res.json({
          proposals: [],
          message: "Only one candidate — nothing to merge.",
        });
        return;
      }

      // --- Call Claude ---
      const nameList = candidates
        .map((c, i) => `${i + 1}. "${c.rawName}"`)
        .join("\n");

      const systemPrompt = `You are a data-deduplication assistant for a steel fabrication tracker.
Your job is to find contractor name variants that refer to the EXACT SAME legal entity or operational unit.

CRITICAL RULES — any violation is a data-loss error:
1. NEVER merge names that differ by a unit suffix: UNIT-II, GP-2, (A), (B), (NGP), or any parenthesised sub-name that denotes a different site, sub-unit, or vendor.
   Examples of MUST NOT MERGE:
   - "DASHMESH ENTERPRISES" vs "DASHMESH ENTERPRISES (UNIT-II)" — different sites
   - "SRIJAN ENTERPRISES" vs "SRIJAN ENTERPRISES (UNIT-II)" — different sites
   - "CNC APM 2020" vs "CNC APM 2020 (A)" — different operational units
   - "SARLA TRADING COMAPNY (ASHTHA ENTERPRISES)" vs "SARLA TRADING COMAPNY (BDM)" — different sub-vendors
   - "METAL PARK (UNIT-II)" vs "METAL PARK (UNIT-II - JAIN PLATE)" — different units

2. DO NOT correct spelling. "COMAPNY" and "TOWRS" are intentional source-data typos that serve as matching keys — do not merge them with correctly-spelled variants unless the entire name (including the typo) is otherwise identical to another name.

3. ONLY merge names where the difference is purely one of:
   - Punctuation: "PVT. LTD." vs "PVT.LTD." vs "PVT LTD"
   - Extra/missing spaces or whitespace
   - Different capitalisation
   - A trailing location qualifier that is clearly part of the same legal entity name (e.g. "(NGP)" added to the SAME company)

4. When in doubt, do NOT merge — a missed duplicate is safer than a wrong merge.

Output a JSON object (no prose, no markdown fences) like:
{
  "groups": [
    {
      "canonicalDisplay": "PHOENIX STRUCTURAL & ENGINEERING PVT. LTD.",
      "aliases": ["PHOENIX STRUCTURAL & ENGINEERING PVT.LTD.", "PHOENIX STRUCTURAL & ENGINEERING PVT.LTD. (NGP)"],
      "confidence": 0.95,
      "reason": "Same legal name; difference is punctuation spacing in PVT.LTD. and a location suffix (NGP) that does not denote a different unit"
    }
  ]
}

Only include groups with 2 or more members (canonicalDisplay + at least one alias).
If no safe merges exist, return { "groups": [] }.`;

      const userPrompt = `Here are the contractor name variants to analyze (${candidates.length} total):\n\n${nameList}\n\nReturn only safe merge groups per the rules above.`;

      const aiResult = await callClaude({
        model: AI_MODEL_STANDARD,
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 4096,
      });

      if (!aiResult.ok) {
        res.status(503).json({ error: `AI analysis failed: ${aiResult.error}` });
        return;
      }

      const parsed = parseJsonObject(aiResult.text) as {
        groups?: Array<{
          canonicalDisplay: string;
          aliases: string[];
          confidence: number;
          reason: string;
        }>;
      } | null;

      if (!parsed || !Array.isArray(parsed.groups)) {
        res
          .status(502)
          .json({ error: "AI returned an unparseable response", raw: aiResult.text.slice(0, 500) });
        return;
      }

      // --- Build + insert proposals ---
      const inserted = [];
      for (const g of parsed.groups) {
        if (!g.canonicalDisplay || !Array.isArray(g.aliases) || g.aliases.length === 0)
          continue;

        const canonicalKey = normalizeContractorName(g.canonicalDisplay);
        const aliasEntries: AliasEntry[] = g.aliases
          .map((raw) => ({
            rawName: String(raw).trim(),
            normalizedKey: normalizeContractorName(raw),
          }))
          .filter(
            (e) =>
              e.normalizedKey &&
              e.normalizedKey !== canonicalKey &&
              !coveredKeys.has(e.normalizedKey),
          );

        if (aliasEntries.length === 0) continue;

        const [row] = await db
          .insert(contractorDedupProposalsTable)
          .values({
            canonicalKey,
            canonicalDisplay: g.canonicalDisplay.trim(),
            aliasEntries,
            confidence:
              typeof g.confidence === "number"
                ? Math.min(1, Math.max(0, g.confidence))
                : null,
            reason: g.reason ? String(g.reason) : null,
            status: "pending",
          })
          .returning();
        inserted.push(row);

        // Mark these keys as covered so a later group in the same batch
        // doesn't duplicate them.
        coveredKeys.add(canonicalKey);
        for (const e of aliasEntries) coveredKeys.add(e.normalizedKey);
      }

      res.json({ proposals: inserted });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Analysis failed: ${msg}` });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /contractor-dedup/proposals/:id/approve
// Marks the proposal approved, writes alias rows, and consolidates
// contractor_categories onto the canonical key.
// Requires auth.
// ---------------------------------------------------------------------------
router.post(
  "/contractor-dedup/proposals/:id/approve",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "Invalid proposal id" });
        return;
      }

      const [proposal] = await db
        .select()
        .from(contractorDedupProposalsTable)
        .where(eq(contractorDedupProposalsTable.id, id));

      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      if (proposal.status !== "pending") {
        res
          .status(409)
          .json({ error: `Proposal is already ${proposal.status}` });
        return;
      }

      const aliasEntries = (proposal.aliasEntries as AliasEntry[]) ?? [];
      const canonicalKey = proposal.canonicalKey;

      // -------------------------------------------------------------------
      // GUARD: empty-alias ("new contractor") proposals may not be approved
      // if the canonical key is ALREADY an alias key in contractor_aliases.
      // Approving such a proposal would create a contractor_categories row
      // for an alias key, which would shadow the existing alias mapping and
      // break dedup resolution. Instead the user should reject this stale
      // notification (the merge that covered it has already been approved).
      // -------------------------------------------------------------------
      if (aliasEntries.length === 0) {
        const [existingAlias] = await db
          .select({ canonicalKey: contractorAliasesTable.canonicalKey })
          .from(contractorAliasesTable)
          .where(eq(contractorAliasesTable.aliasKey, canonicalKey));
        if (existingAlias) {
          res.status(409).json({
            error:
              `Cannot approve: "${canonicalKey}" is already an alias for ` +
              `"${existingAlias.canonicalKey}". ` +
              `This notification was superseded by an approved merge — reject it instead.`,
          });
          return;
        }
      }

      // Collect the alias normalized keys so we can look up their existing
      // contractor_categories rows (to migrate settings to the canonical entry).
      const aliasKeys = aliasEntries.map((e) => e.normalizedKey);
      const involvedKeys = [canonicalKey, ...aliasKeys];

      // Load any existing contractor_categories rows for the canonical + aliases.
      const existingCats = await db
        .select()
        .from(contractorCategoriesTable)
        .where(inArray(contractorCategoriesTable.nameKey, involvedKeys.length > 0 ? involvedKeys : [canonicalKey]));

      // Pick the best settings: prefer non-UNCLASSIFIED rows; among those,
      // pick the canonical if it exists, otherwise the first alias row.
      const catByKey = new Map(existingCats.map((r) => [r.nameKey, r]));
      const canonicalCat = catByKey.get(canonicalKey);
      const nonUnclassified = existingCats.filter(
        (r) => r.category !== "UNCLASSIFIED",
      );
      const bestSource =
        canonicalCat?.category !== "UNCLASSIFIED"
          ? canonicalCat
          : nonUnclassified[0] ?? canonicalCat;

      await db.transaction(async (tx) => {
        // 1. Ensure canonical entry exists in contractor_categories.
        await tx
          .insert(contractorCategoriesTable)
          .values({
            nameKey: canonicalKey,
            displayName: proposal.canonicalDisplay,
            category: bestSource?.category ?? "UNCLASSIFIED",
            outVendorType: bestSource?.outVendorType ?? [],
            plantLocation: bestSource?.plantLocation ?? null,
          })
          .onConflictDoUpdate({
            target: contractorCategoriesTable.nameKey,
            set: {
              displayName: proposal.canonicalDisplay,
              category: bestSource?.category ?? "UNCLASSIFIED",
              outVendorType: bestSource?.outVendorType ?? [],
              plantLocation: bestSource?.plantLocation ?? null,
              updatedAt: new Date(),
            },
          });

        // 2. Insert alias mappings (skip any that already exist).
        for (const entry of aliasEntries) {
          if (!entry.normalizedKey || entry.normalizedKey === canonicalKey)
            continue;
          await tx
            .insert(contractorAliasesTable)
            .values({
              aliasKey: entry.normalizedKey,
              canonicalKey,
              rawName: entry.rawName,
            })
            .onConflictDoNothing();
        }

        // 3. Remove alias keys from contractor_categories — they now resolve
        //    transparently through the alias table.
        if (aliasKeys.length > 0) {
          await tx
            .delete(contractorCategoriesTable)
            .where(
              and(
                inArray(contractorCategoriesTable.nameKey, aliasKeys),
                sql`${contractorCategoriesTable.nameKey} <> ${canonicalKey}`,
              ),
            );
        }

        // 4. Mark proposal approved.
        await tx
          .update(contractorDedupProposalsTable)
          .set({ status: "approved", reviewedAt: new Date() })
          .where(eq(contractorDedupProposalsTable.id, id));

        // 5. Auto-reject any pending "new contractor" notifications (empty
        //    aliasEntries) whose canonical key is one of the alias keys just
        //    absorbed. Those proposals are now stale — approving them later
        //    would re-create a contractor_categories row for the alias key and
        //    shadow the alias mapping. Only target empty-alias proposals to
        //    avoid accidentally closing a real AI merge proposal that happens
        //    to share the same canonical key.
        if (aliasKeys.length > 0) {
          const allPendingForAliasKeys = await tx
            .select({
              id: contractorDedupProposalsTable.id,
              aliasEntries: contractorDedupProposalsTable.aliasEntries,
            })
            .from(contractorDedupProposalsTable)
            .where(
              and(
                eq(contractorDedupProposalsTable.status, "pending"),
                inArray(contractorDedupProposalsTable.canonicalKey, aliasKeys),
              ),
            );
          // Only auto-reject empty-alias proposals (new-contractor notifications).
          const staleIds = allPendingForAliasKeys
            .filter((r) => ((r.aliasEntries as AliasEntry[]) ?? []).length === 0)
            .map((r) => r.id);
          if (staleIds.length > 0) {
            await tx
              .update(contractorDedupProposalsTable)
              .set({
                status: "rejected",
                reviewedAt: new Date(),
                reason: "Superseded: this contractor was absorbed as an alias in an approved merge.",
              })
              .where(inArray(contractorDedupProposalsTable.id, staleIds));
          }
        }
      });

      res.json({ ok: true, id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Approve failed: ${msg}` });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /contractor-dedup/proposals/:id/reject
// Marks the proposal rejected; no alias rows are written.
// Requires auth.
// ---------------------------------------------------------------------------
router.post(
  "/contractor-dedup/proposals/:id/reject",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "Invalid proposal id" });
        return;
      }

      const [proposal] = await db
        .select()
        .from(contractorDedupProposalsTable)
        .where(eq(contractorDedupProposalsTable.id, id));

      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      if (proposal.status !== "pending") {
        res
          .status(409)
          .json({ error: `Proposal is already ${proposal.status}` });
        return;
      }

      await db
        .update(contractorDedupProposalsTable)
        .set({ status: "rejected", reviewedAt: new Date() })
        .where(eq(contractorDedupProposalsTable.id, id));

      res.json({ ok: true, id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Reject failed: ${msg}` });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /contractor-aliases
// Removes a single alias mapping (undo an approved merge for one alias).
// Requires auth. The alias key is passed as a query param.
// ---------------------------------------------------------------------------
router.delete(
  "/contractor-aliases",
  requireAuth,
  async (req, res): Promise<void> => {
    const aliasKey = normalizeContractorName(String(req.query.aliasKey ?? ""));
    if (!aliasKey) {
      res.status(400).json({ error: "aliasKey is required" });
      return;
    }
    await db
      .delete(contractorAliasesTable)
      .where(eq(contractorAliasesTable.aliasKey, aliasKey));
    res.status(204).end();
  },
);

export default router;
