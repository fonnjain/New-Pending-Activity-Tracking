import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isCsvWip,
  parseWorkbook,
  readStructural,
} from "./parse";
import { isLiveWorkType } from "@workspace/domain";

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

test("accepts appended CSV columns while flagging them for review", async () => {
  const valid = await fixtureBuffer();
  const appended = [
    "Lot Document No.",
    "Lot Document Date",
    "Lot Source Form",
    "Issue Lot Rate",
    "Issue Document No.",
    "Issue Document Date",
    "SinRateForIssueMonth",
    "NearestSinDateToIssue",
  ];
  const extended = Buffer.from(
    valid
      .toString("utf8")
      .replace("Is Last Activity\r\n", `Is Last Activity,${appended.join(",")}\r\n`),
    "utf8",
  );
  const structure = readStructural(extended);

  assert.equal(isCsvWip(extended), true);
  assert.equal(structure.columnsFound.length, 36);
  assert.equal(structure.problems.some((problem) => problem.includes("Expected")), false);
  assert.deepEqual(structure.wipFormatCheck?.unexpectedFound, []);
  assert.deepEqual(structure.wipFormatCheck?.appendedNew, appended);
});

test("stores material issue columns without changing WIP row identity", () => {
  const baseHeaders = [
    "Type", "Project Code", "Order Nature", "Contractor", "Job Card No.", "Job Card Date",
    "Job Card Status", "Tower Type", "Tower Sub Type", "Alias", "Mark No.", "Section",
    "Length", "Width", "Wt/Pcs", "Balance Qty.", "Balance Wt.", "Assign Date", "Activity",
    "Operation", "Ref. Job Card No.", "Last Production Entry Date", "Work Order No.",
    "Batch No.", "BOM Status", "Is Welded Structure", "Sales Order Status", "Is Last Activity",
  ];
  const baseRow = [
    "Job Card WIP", "920", "Structure", "ACME", "JC-001", "01/08/2026", "Authorized",
    "TOWER", "TLT", "A", "920 A-1", "ANGLE", "1000", "", "10", "1", "10",
    "01/08/2026", "C", "C", "", "01/08/2026", "WO-001", "A", "Authorized",
    "False", "", "1",
  ];
  const issueHeaders = [
    "Lot Document No.", "Lot Document Date", "Lot Source Form", "Issue Lot Rate",
    "Issue Document No.", "Issue Document Date", "SinRateForIssueMonth", "NearestSinDateToIssue",
  ];
  const issueValues = [
    "SIN/VT/26-27/U2/PG/00002", "01/08/2024", "SIN Lot Entry", "50.7912",
    "VTMI/26-27/001243", "02/08/2024", "48.1250", "01/08/2024",
  ];
  const csv = (headers: string[], values: string[]) =>
    Buffer.from(`${headers.join(",")}\r\n${values.map((value) => JSON.stringify(value)).join(",")}\r\n`);

  const original = parseWorkbook(csv(baseHeaders, baseRow));
  const parsed = parseWorkbook(csv([...baseHeaders, ...issueHeaders], [...baseRow, ...issueValues]));
  const row = parsed.rows[0];

  assert.equal(row?.hash, original.rows[0]?.hash);
  assert.equal(row?.lotDocumentNo, "SIN/VT/26-27/U2/PG/00002");
  assert.equal(row?.lotDocumentDate, "2024-08-01");
  assert.equal(row?.issueDocumentDate, "2024-08-02");
  assert.equal(row?.nearestSinDateToIssue, "2024-08-01");
  assert.equal(row?.issueLotRate, 50.7912);
  assert.equal(row?.sinRateForIssueMonth, 48.125);

  const watch = parsed.summary.sourceColumnWatch ?? [];
  assert.deepEqual(
    watch.find((column) => column.key === "lotSourceForm"),
    {
      key: "lotSourceForm",
      header: "Lot Source Form",
      present: true,
      mode: "distribution",
      populatedCount: 1,
      numericSummary: null,
      values: [{ value: "SIN Lot Entry", marks: 1, weightMt: 0.01 }],
      crossTab: [{ orderNature: "Structure", value: "SIN Lot Entry", marks: 1 }],
    },
  );
  assert.deepEqual(
    watch.find((column) => column.key === "issueLotRate")?.numericSummary,
    { min: 50.7912, max: 50.7912, mean: 50.7912 },
  );
  assert.equal(watch.find((column) => column.key === "issueDocumentNo")?.populatedCount, 1);
});

test("counts future CSV dates in every protected date column before upload", async () => {
  const parsed = parseWorkbook(await fixtureBuffer(), undefined, {
    reportDate: "2026-08-20",
  });

  // JC-001 has a future Job Card Date, JC-002 a future Assign Date, and JC-004
  // a future Last Production Entry Date. Upload routes refuse this non-zero count.
  assert.equal(parsed.futureDateCount, 3);
});

test("reports Type breakdown and excludes only explicit FG from live work", () => {
  const headers = ["Type", "Project Code", "Mark No.", "Balance Wt.", "Job Card Status"];
  const csv = [
    headers.join(","),
    "Job Card WIP,900,900-A,100,Authorized",
    "FG Pending For Dispatch,900,900-B,200,",
    "New ERP Type,900,900-C,300,Authorized",
    ",900,900-D,400,",
  ].join("\r\n");

  const parsed = parseWorkbook(Buffer.from(`${csv}\r\n`));

  assert.deepEqual(parsed.summary.typeCounts, [
    { type: "(blank / legacy)", rows: 1 },
    { type: "FG Pending For Dispatch", rows: 1 },
    { type: "Job Card WIP", rows: 1 },
    { type: "New ERP Type", rows: 1 },
  ]);
  assert.equal(parsed.summary.fgExcludedRowCount, 1);
  assert.equal(parsed.summary.unknownTypeRowCount, 1);
  assert.deepEqual(parsed.summary.unknownTypeValues, [{ type: "New ERP Type", rows: 1 }]);
  assert.equal(isLiveWorkType("FG Pending For Dispatch"), false);
  assert.equal(isLiveWorkType(null), true);
  assert.equal(isLiveWorkType("New ERP Type"), true);
});