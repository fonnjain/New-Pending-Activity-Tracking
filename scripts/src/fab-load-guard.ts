// Fabrication Load invariant guard.
//
// The Fabrication Load report (Welded / Bending / Drilling / Plate Punch /
// Plate Drill x Operational / In-Hand = 10 cells) is a PROTECTED INVARIANT:
// reordering activities in PROCESS_SEQUENCE must NOT change those numbers.
//
// HG was relocated in the sequence (it now sits before B and W). That is only
// safe while NO mark currently sits at activity HG - a mark at HG would fall
// "before B/W" under the new ordering and silently inflate the In-Hand Bending
// (and Welding) figures. This script:
//   1. Recomputes the 10 Fabrication Load figures from the latest import,
//      reusing the SAME @workspace/domain sequence helpers the UI uses, so a
//      sequence edit is reflected here and the locked assertions fail.
//   2. Asserts the locked expected tonnages (and In-Hand mark counts).
//   3. Fails loudly if ANY eligible mark currently sits at activity HG, so the
//      one case that could legitimately shift Bending In-Hand is explained
//      rather than mysterious.
//
// Run with: pnpm --filter @workspace/scripts run fab-load-guard
// Requires DATABASE_URL (same as the API server).

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  pool,
  importsTable,
  importRowsTable,
  recordPoolTable,
} from "@workspace/db";
import {
  activityRank,
  deriveHoleOperation,
  normalizeActivity,
  routeIncludesOp,
  FAB_LOAD_SECTIONS,
  fabLoadColumnsForSection,
  type FabLoadColumn,
  type FabLoadSection,
} from "@workspace/domain";

const W_RANK = activityRank("W");
const B_RANK = activityRank("B");

// Minimal record shape needed by the Fabrication Load matcher, mirroring the
// fields the API serializes and the UI's fabLoadMatch reads.
interface FabRecord {
  job: string;
  activity: string | null;
  operation: string | null;
  balanceWt: number;
  category: string | null;
  sectionType: string | null;
  holeOperation: string | null;
}

// EXACT copy of the client-side fabLoadMatch (reports.tsx). Kept in lockstep so
// this guard tests the real cell membership rules. Welded/Bending use a
// POSITIONAL rule in the TLT sequence (rank vs W/B); Drilling/Plate Punch/Plate
// Drill use a SPECIFIC-ACTIVITY rule + sectionType + holeOperation.
function fabLoadMatch(
  section: FabLoadSection,
  column: FabLoadColumn,
  r: FabRecord,
): boolean {
  const act = normalizeActivity(r.activity);
  const rank = activityRank(r.activity);
  const sec = r.sectionType;
  const op = r.holeOperation;
  if (section === "operational") {
    switch (column) {
      case "welded":
        return act === "W";
      case "bending":
        return act === "B";
      case "drilling":
        return sec === "ANGLE" && act === "RFI" && op === "DRILLING";
      case "platePunch":
        return sec === "PLATE" && act === "RFI" && op === "PUNCHING";
      case "plateDrill":
        return sec === "PLATE" && act === "RFI" && op === "DRILLING";
    }
  }
  switch (column) {
    case "welded":
      return rank < W_RANK && routeIncludesOp(r.operation, "W");
    case "bending":
      return rank < B_RANK && routeIncludesOp(r.operation, "B");
    case "drilling":
      return sec === "ANGLE" && act === "C" && op === "DRILLING";
    case "platePunch":
      return sec === "PLATE" && act === "C" && op === "PUNCHING";
    case "plateDrill":
      return sec === "PLATE" && act === "C" && op === "DRILLING";
  }
  return false;
}

// Locked expected values for the CURRENT dataset (all 10 cells). Tonnage in
// tonnes (kg/1000); mark counts are expanded-record counts.
//
// PROVENANCE: The task that introduced this guard quoted an earlier dataset
// snapshot (Operational Drilling 84.42t, Plate Punch 39.00t, Plate Drill
// 14.58t; In-Hand Drilling 301.57t, Plate Punch 187.02t, Plate Drill 98.10t;
// In-Hand Welded 251.48t/1602, Bending 544.51t/2609). The dataset in this
// environment has since grown (more imports uploaded), so those figures no
// longer describe the latest import. The HG relocation was verified NOT to be
// the cause: the set of activities "before B" and "before W" is identical under
// the old and new sequence orderings, and 0 marks currently sit at HG. The
// values below are the verified totals for the current latest import and were
// cross-checked with an independent SQL recompute of In-Hand Bending.
//
// RE-LOCK these values whenever a new balance report is uploaded (legitimate
// data changes move the numbers). Between uploads, a mismatch means a code
// change (e.g. a PROCESS_SEQUENCE reorder) has silently shifted the totals.
interface Expected {
  section: FabLoadSection;
  column: FabLoadColumn;
  tonnes: number;
  marks: number;
}
const EXPECTED: Expected[] = [
  { section: "operational", column: "welded", tonnes: 19.45, marks: 430 },
  { section: "operational", column: "drilling", tonnes: 103.0, marks: 160 },
  { section: "operational", column: "platePunch", tonnes: 41.89, marks: 571 },
  { section: "operational", column: "plateDrill", tonnes: 12.57, marks: 90 },
  { section: "operational", column: "bending", tonnes: 97.9, marks: 521 },
  { section: "inhand", column: "welded", tonnes: 260.83, marks: 1667 },
  { section: "inhand", column: "drilling", tonnes: 289.85, marks: 270 },
  { section: "inhand", column: "platePunch", tonnes: 194.35, marks: 3650 },
  { section: "inhand", column: "plateDrill", tonnes: 95.08, marks: 426 },
  { section: "inhand", column: "bending", tonnes: 705.94, marks: 3026 },
];

// Tolerance for tonnage comparison (expected values are 2-decimal rounded).
const TONNE_TOLERANCE = 0.01;

function cellKey(section: string, column: string): string {
  return `${section}|${column}`;
}

async function main(): Promise<void> {
  // Latest import = default view = highest id (newest upload).
  const [latest] = await db
    .select({ id: importsTable.id })
    .from(importsTable)
    .orderBy(desc(importsTable.id))
    .limit(1);

  if (!latest) {
    console.error("FAIL: no imports found - cannot verify Fabrication Load.");
    process.exitCode = 1;
    return;
  }

  console.log(`Fabrication Load guard - latest import id: ${latest.id}\n`);

  // Membership of the latest import: pool rows + copies (in-sheet duplicates
  // count as separate pending units, exactly like the /records endpoint).
  const membership = await db
    .select({ pool: recordPoolTable, copies: importRowsTable.copies })
    .from(importRowsTable)
    .innerJoin(
      recordPoolTable,
      eq(importRowsTable.poolId, recordPoolTable.id),
    )
    .where(eq(importRowsTable.importId, latest.id));

  // Expand each pool row into `copies` serialized records, deriving hole
  // operation live from the immutable section (mirrors serializeRecord).
  const records: FabRecord[] = [];
  for (const { pool: p, copies } of membership) {
    const hole = deriveHoleOperation(p.section);
    const rec: FabRecord = {
      job: p.job,
      activity: p.activity,
      operation: p.operation,
      balanceWt: p.balanceWt ?? 0,
      category: p.category,
      sectionType: hole.sectionType,
      holeOperation: hole.holeOperation,
    };
    for (let c = 0; c < copies; c++) records.push(rec);
  }

  // Fabrication Load report scope: TLT only (category defaults to TLT on legacy
  // rows), a real project (not blank / "(Unassigned)"), positive balance wt.
  const eligible = records.filter((r) => {
    if ((r.category || "TLT") !== "TLT") return false;
    const project = (r.job || "").trim();
    if (!project || project === "(Unassigned)") return false;
    return (r.balanceWt ?? 0) > 0;
  });

  // --- HG guard: HG now sits before B and W. Any eligible mark at HG would
  // shift In-Hand Bending/Welding under the new ordering. ---
  const hgEligible = eligible.filter(
    (r) => normalizeActivity(r.activity) === "HG",
  );
  const hgAll = records.filter((r) => normalizeActivity(r.activity) === "HG");

  // Aggregate every cell (kg + expanded mark count).
  const totals = new Map<string, { kg: number; marks: number }>();
  for (const s of FAB_LOAD_SECTIONS) {
    for (const c of fabLoadColumnsForSection(s.value)) {
      totals.set(cellKey(s.value, c.value), { kg: 0, marks: 0 });
    }
  }
  for (const r of eligible) {
    for (const s of FAB_LOAD_SECTIONS) {
      for (const c of fabLoadColumnsForSection(s.value)) {
        if (!fabLoadMatch(s.value, c.value, r)) continue;
        const t = totals.get(cellKey(s.value, c.value))!;
        t.kg += r.balanceWt ?? 0;
        t.marks += 1;
      }
    }
  }

  // Print the full 10-cell grid for visibility.
  console.log("Computed Fabrication Load (all 10 cells):");
  for (const s of FAB_LOAD_SECTIONS) {
    for (const c of fabLoadColumnsForSection(s.value)) {
      const t = totals.get(cellKey(s.value, c.value))!;
      console.log(
        `  ${s.value.padEnd(11)} ${c.value.padEnd(10)} ` +
          `${(t.kg / 1000).toFixed(2).padStart(9)}t  ${String(t.marks).padStart(5)} marks`,
      );
    }
  }
  console.log("");

  const failures: string[] = [];

  // HG failure comes first so the discrepancy is explained, not mysterious.
  if (hgEligible.length > 0) {
    failures.push(
      `HG guard: ${hgEligible.length} eligible mark(s) currently sit at activity HG ` +
        `(${hgAll.length} across the whole import). HG was relocated to sit BEFORE B and W ` +
        `in PROCESS_SEQUENCE, so these marks now count toward In-Hand Bending/Welding and ` +
        `the locked totals below no longer describe the dataset. Re-verify the Fabrication ` +
        `Load figures and update the locked expected values in this guard.`,
    );
  } else {
    console.log(
      `HG guard OK: 0 eligible marks at activity HG (${hgAll.length} total across import).\n`,
    );
  }

  // Assert the locked expected values.
  for (const e of EXPECTED) {
    const t = totals.get(cellKey(e.section, e.column))!;
    const tonnes = t.kg / 1000;
    if (Math.abs(tonnes - e.tonnes) > TONNE_TOLERANCE) {
      failures.push(
        `${e.section} ${e.column}: expected ${e.tonnes.toFixed(2)}t, ` +
          `got ${tonnes.toFixed(2)}t (delta ${(tonnes - e.tonnes).toFixed(2)}t).`,
      );
    }
    if (t.marks !== e.marks) {
      failures.push(
        `${e.section} ${e.column}: expected ${e.marks} marks, got ${t.marks}.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("FAIL: Fabrication Load invariant broken:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `PASS: all ${EXPECTED.length} locked Fabrication Load figures match and no marks sit at HG.`,
  );
}

main()
  .catch((err) => {
    console.error("FAIL: Fabrication Load guard errored:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
