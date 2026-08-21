import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WIP_CSV_COLUMN_COUNT,
  hasExactWipCsvColumnCount,
  isCsvWip,
  parseWorkbook,
  readStructural,
} from "./parse";

const fixturePath = fileURLToPath(
  new URL("./__fixtures__/wip-20-aug-2026.csv", import.meta.url),
);

async function fixtureBuffer(): Promise<Buffer> {
  // ERP sends CRLF-delimited CSV. Normalize the checked-in safe fixture so this
  // test always exercises the same record boundaries on every platform.
  const fixture = await readFile(fixturePath, "utf8");
  return Buffer.from(fixture.replace(/\r?\n/g, "\r\n"), "utf8");
}

test("parses the compact 20-Aug WIP CSV with quoted CRLF fields and stable summary", async () => {
  const buffer = await fixtureBuffer();

  assert.equal(isCsvWip(buffer), true);
  const parsed = parseWorkbook(buffer);

  assert.deepEqual(
    {
      rowsRead: parsed.summary.rowsRead,
      rowsKept: parsed.summary.rowsKept,
      distinctRows: parsed.summary.distinctRows,
      duplicateRowCopies: parsed.summary.duplicateRowCopies,
      projectsFound: parsed.summary.projectsFound,
      missingContractor: parsed.summary.missingContractor,
      missingDate: parsed.summary.missingDate,
      notStarted: parsed.summary.notStarted,
      noProductionDate: parsed.summary.noProductionDate,
      futureProductionDate: parsed.summary.futureProductionDate,
      classificationConflicts: parsed.summary.classificationConflicts,
      ntltOrphanCount: parsed.summary.ntltOrphanCount,
      ntltOrphanWtMt: parsed.summary.ntltOrphanWtMt,
    },
    {
      rowsRead: 6,
      rowsKept: 6,
      distinctRows: 6,
      duplicateRowCopies: 0,
      projectsFound: 1,
      missingContractor: 0,
      missingDate: 0,
      notStarted: 0,
      noProductionDate: 0,
      futureProductionDate: 0,
      classificationConflicts: 0,
      ntltOrphanCount: 4,
      ntltOrphanWtMt: 14000,
    },
  );

  const [pAlias, sAlias, solar, railway, rural, jobWork] = parsed.rows;
  assert.equal(pAlias?.contractor, "ACME, Fabrication");
  assert.equal(pAlias?.assignDate, "2026-08-11");
  assert.equal(pAlias?.activity, "RFI");
  assert.equal(pAlias?.activityRaw, "P");
  assert.equal(pAlias?.operation, "C;P;S;RFI;Q;G;GB");
  assert.equal(sAlias?.activity, "RFI");
  assert.equal(sAlias?.activityRaw, "S");

  for (const row of [solar, railway, rural, jobWork]) {
    assert.equal(row?.category, "NTLT");
    assert.equal(row?.ntltSubtype, "GENERAL");
  }

  // The parser must leave the raw blank intact. DC18 identifies this exact
  // Job Card WIP case and assigns it to Quality Check at read time.
  assert.equal(jobWork?.jobCardType, "Job Card WIP");
  assert.equal(jobWork?.activity, null);
});

test("requires exactly 28 columns for a direct WIP CSV", async () => {
  const valid = await fixtureBuffer();
  const validStructure = readStructural(valid);
  assert.equal(validStructure.columnsFound.length, WIP_CSV_COLUMN_COUNT);
  assert.equal(hasExactWipCsvColumnCount(validStructure.columnsFound), true);

  const wrongCount = Buffer.from(
    valid.toString("utf8").replace(",Is Last Activity\r\n", "\r\n"),
    "utf8",
  );
  const invalidStructure = readStructural(wrongCount);
  assert.equal(isCsvWip(wrongCount), true);
  assert.equal(invalidStructure.columnsFound.length, WIP_CSV_COLUMN_COUNT - 1);
  assert.equal(hasExactWipCsvColumnCount(invalidStructure.columnsFound), false);
  assert.deepEqual(invalidStructure.problems, [
    "Expected 28 CSV columns but found 27.",
  ]);
});

test("counts future CSV dates in every protected date column before upload", async () => {
  const parsed = parseWorkbook(await fixtureBuffer(), undefined, {
    reportDate: "2026-08-20",
  });

  // JC-001 has a future Job Card Date, JC-002 a future Assign Date, and JC-004
  // a future Last Production Entry Date. Upload routes refuse this non-zero count.
  assert.equal(parsed.futureDateCount, 3);
});