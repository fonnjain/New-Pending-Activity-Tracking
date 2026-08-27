import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { collapseOrderRows } from "./dispatch";
import { normalizeProject } from "./parse";
import {
  compareOrderReviewCumulativeProgress,
  classifyCumulativeRegressionProjects,
  parseOrderReview,
  type OrderReviewProjectCumulativeRow,
} from "./parse-order-review";

function buildOrphanBlockWorkbook(): Buffer {
  const width = 23;
  const row = (cells: Record<number, string | number> = {}) =>
    Array.from({ length: width }, (_, index) => cells[index] ?? "");

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    row({ 2: "Tower Type", 5: "Order Qty", 9: "WO Order Qty", 11: "Progress", 16: "Progress" }),
    row({
      5: "Sets",
      6: "Weight (MT)",
      9: "Weight (MT)",
      11: "Release (MT)",
      16: "Despatch (MT)",
    }),
    row({ 0: "Project Code : 868" }),
    // A real single-structure block whose Tower Type Code (column C) is blank.
    row({ 5: 1, 6: 63.882, 9: 63.882, 11: 12.5, 16: 4.25 }),
    row({ 0: "Sub Total" }),
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "OrderReview");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

test("retains a numeric Order Review row with a blank Tower Type", () => {
  const parsed = parseOrderReview(buildOrphanBlockWorkbook());

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.summary.rowsRead, 1);
  assert.equal(parsed.summary.rowsKept, 1);
  assert.equal(parsed.summary.projectsFound, 1);
  assert.equal(parsed.summary.missingStructure, 0);
  assert.equal(parsed.summary.totalWeightMt, 63.882);
  assert.equal(parsed.rows[0]?.project, "868");
  assert.equal(parsed.rows[0]?.structure, "");
  assert.equal(parsed.rows[0]?.woOrderQtyMt, 63.882);
  assert.equal(parsed.rows[0]?.fileDespatchMt, 4.25);
});

test("compacts blank-Tower-Type rows for persistence by project", () => {
  const parsed = parseOrderReview(buildOrphanBlockWorkbook());
  const repeated = {
    ...parsed.rows[0]!,
    sets: 2,
    weightMt: 10,
    woOrderQtyMt: 10,
    releaseMt: 3,
    fileDespatchMt: 1,
  };
  const compacted = collapseOrderRows([...parsed.rows, repeated]);
  const retained = compacted.get("868\u0001");

  assert.equal(compacted.size, 1);
  assert.ok(retained);
  assert.equal(retained.structure, "");
  assert.equal(retained.sets, 3);
  assert.equal(retained.weightMt, 73.882);
  assert.equal(retained.woOrderQtyMt, 73.882);
  assert.equal(retained.releaseMt, 15.5);
  assert.equal(retained.fileDespatchMt, 5.25);
});

function buildSpacedProjectWorkbook(): Buffer {
  const width = 23;
  const row = (cells: Record<number, string | number> = {}) =>
    Array.from({ length: width }, (_, index) => cells[index] ?? "");

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    row({ 2: "Tower Type", 5: "Order Qty", 9: "WO Order Qty", 11: "Progress", 16: "Progress" }),
    row({
      5: "Sets",
      6: "Weight (MT)",
      9: "Weight (MT)",
      11: "Release (MT)",
      16: "Despatch (MT)",
    }),
    row({ 0: "Project Code : RAILWAY BATCH 10" }),
    row({ 2: "T1", 5: 1, 6: 10, 9: 10, 11: 5, 16: 4 }),
    row({ 0: "Project Code : RAILWAY BATCH 11" }),
    row({ 2: "T2", 5: 1, 6: 12, 9: 12, 11: 6, 16: 3 }),
    row({ 0: "Sub Total" }),
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "OrderReview");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

test("keeps meaningful spaces in Order Review project banners", () => {
  assert.equal(normalizeProject("  -907.0  "), "907");

  const parsed = parseOrderReview(buildSpacedProjectWorkbook());
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(
    [...new Set(parsed.rows.map((row) => row.project))],
    ["RAILWAY BATCH 10", "RAILWAY BATCH 11"],
  );
  assert.equal(parsed.rows[0]?.fileDespatchMt, 4);
  assert.equal(parsed.rows[1]?.fileDespatchMt, 3);
});

function cumulativeRow(
  project: string,
  values: Partial<Omit<OrderReviewProjectCumulativeRow, "project">> = {},
): OrderReviewProjectCumulativeRow {
  return {
    project,
    woOrderQtyMt: 0,
    releaseMt: 0,
    fabMt: 0,
    galvMt: 0,
    inspectionMt: 0,
    fileDespatchMt: 0,
    ...values,
  };
}

test("blocks each cumulative progress rollback but warns for qualifying disappearing projects", () => {
  const comparison = compareOrderReviewCumulativeProgress(
    [
      // Project 100 remains in the file but every protected total went backwards.
      cumulativeRow("100", {
        woOrderQtyMt: 20,
        releaseMt: 11,
        fabMt: 8,
        galvMt: 7,
        inspectionMt: 6,
        fileDespatchMt: 5,
      }),
      // Project 300 is new and must not be compared to zero.
      cumulativeRow("300", { woOrderQtyMt: 2, releaseMt: 2 }),
    ],
    [
      // Multiple structures must be summed before project-level comparison.
      cumulativeRow("100", {
        woOrderQtyMt: 10,
        releaseMt: 5,
        fabMt: 4,
        galvMt: 3,
        inspectionMt: 3,
        fileDespatchMt: 2,
      }),
      cumulativeRow("100", {
        woOrderQtyMt: 10,
        releaseMt: 8,
        fabMt: 6,
        galvMt: 5,
        inspectionMt: 4,
        fileDespatchMt: 4,
      }),
      // Project 200 was removed while dispatched. Project 201 remains outstanding.
      cumulativeRow("200", { woOrderQtyMt: 10, fileDespatchMt: 3 }),
      cumulativeRow("201", { woOrderQtyMt: 10, fileDespatchMt: 0 }),
      // A completed zero-only project may disappear without a warning.
      cumulativeRow("400", { woOrderQtyMt: 0, fileDespatchMt: 0 }),
    ],
  );

  assert.equal(comparison.hasBaseline, true);
  assert.deepEqual(comparison.regressions, [
    {
      project: "100",
      column: "releaseMt",
      label: "Progress Release",
      previousMt: 13,
      currentMt: 11,
      differenceMt: -2,
    },
    {
      project: "100",
      column: "fabMt",
      label: "Progress Fabrication",
      previousMt: 10,
      currentMt: 8,
      differenceMt: -2,
    },
    {
      project: "100",
      column: "galvMt",
      label: "Progress Galvanising",
      previousMt: 8,
      currentMt: 7,
      differenceMt: -1,
    },
    {
      project: "100",
      column: "inspectionMt",
      label: "Progress Inspection",
      previousMt: 7,
      currentMt: 6,
      differenceMt: -1,
    },
    {
      project: "100",
      column: "fileDespatchMt",
      label: "Progress Despatch",
      previousMt: 6,
      currentMt: 5,
      differenceMt: -1,
    },
  ]);
  assert.deepEqual(comparison.missingProjects, [
    { project: "200", storedDespatchMt: 3, outstandingMt: 7 },
    { project: "201", storedDespatchMt: 0, outstandingMt: 10 },
  ]);
});

test("does not invent a regression for the first Order Review", () => {
  const comparison = compareOrderReviewCumulativeProgress(
    [cumulativeRow("100", { releaseMt: 5, fileDespatchMt: 2 })],
    null,
  );

  assert.equal(comparison.hasBaseline, false);
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.missingProjects, []);
});

test("uses the named 0.001 MT tolerance boundary for every cumulative column", () => {
  const comparison = compareOrderReviewCumulativeProgress(
    [cumulativeRow("837", {
      releaseMt: 10.999,
      fabMt: 10.999,
      galvMt: 10.999,
      inspectionMt: 10.999,
      fileDespatchMt: 10.999,
    })],
    [cumulativeRow("837", {
      releaseMt: 11,
      fabMt: 11,
      galvMt: 11,
      inspectionMt: 11,
      fileDespatchMt: 11,
    })],
  );

  assert.deepEqual(comparison.regressions, []);

  const aboveTolerance = compareOrderReviewCumulativeProgress(
    [cumulativeRow("837", { fabMt: 10.9989 })],
    [cumulativeRow("837", { fabMt: 11 })],
  );
  assert.equal(aboveTolerance.regressions.length, 1);
  assert.equal(aboveTolerance.regressions[0]?.column, "fabMt");
  assert.ok((aboveTolerance.regressions[0]?.differenceMt ?? 0) < -0.001);
});

test("classifies blocking regressions without changing the guard", () => {
  const previous = [
    cumulativeRow("CANCELLED", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 10,
      galvMt: 10,
      inspectionMt: 10,
      fileDespatchMt: 10,
    }),
    cumulativeRow("CORRECTION", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 8,
      galvMt: 7,
      inspectionMt: 6,
      fileDespatchMt: 5,
    }),
    cumulativeRow("UNKNOWN", { woOrderQtyMt: 10, releaseMt: 10, fabMt: 8 }),
  ];
  const incoming = [
    cumulativeRow("CANCELLED"),
    cumulativeRow("CORRECTION", {
      woOrderQtyMt: 10,
      releaseMt: 9,
      fabMt: 8,
      galvMt: 7,
      inspectionMt: 6,
      fileDespatchMt: 5,
    }),
    cumulativeRow("UNKNOWN", { woOrderQtyMt: 8, releaseMt: 9, fabMt: 8 }),
  ];
  const comparison = compareOrderReviewCumulativeProgress(incoming, previous);
  const details = classifyCumulativeRegressionProjects(
    incoming,
    previous,
    comparison.regressions,
  );

  assert.deepEqual(
    details.map((detail) => [detail.project, detail.classification]),
    [
      ["CANCELLED", "cancellation-transfer"],
      ["CORRECTION", "correction"],
      ["UNKNOWN", "scope-reduction"],
    ],
  );
  assert.equal(comparison.regressions.length, 7);
  assert.ok(
    details.find((detail) => detail.project === "CORRECTION")?.unchangedColumns
      .some((column) => column.label === "WO Order Qty"),
  );
});

test("classifies end-at-zero cancellations even when a cumulative column was already zero", () => {
  const previous = [
    cumulativeRow("ZEROED-LATE", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 10,
      galvMt: 10,
      inspectionMt: 10,
      fileDespatchMt: 0,
    }),
    cumulativeRow("ZEROED-EARLY", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 10,
      galvMt: 10,
      inspectionMt: 0,
      fileDespatchMt: 0,
    }),
  ];
  const incoming = [
    cumulativeRow("ZEROED-LATE"),
    cumulativeRow("ZEROED-EARLY"),
  ];
  const comparison = compareOrderReviewCumulativeProgress(incoming, previous);
  const details = classifyCumulativeRegressionProjects(
    incoming,
    previous,
    comparison.regressions,
  );

  assert.deepEqual(
    details.map((detail) => [detail.project, detail.classification]),
    [
      ["ZEROED-EARLY", "cancellation-transfer"],
      ["ZEROED-LATE", "cancellation-transfer"],
    ],
  );
});

test("classifies a non-zero work-order reduction separately from cancellations", () => {
  const previous = [
    cumulativeRow("SCOPE", {
      woOrderQtyMt: 370.608,
      releaseMt: 374.7,
      fabMt: 374.7,
      galvMt: 374.7,
      inspectionMt: 364.005,
      fileDespatchMt: 271.432,
    }),
  ];
  const incoming = [
    cumulativeRow("SCOPE", {
      woOrderQtyMt: 357.143,
      releaseMt: 361.237,
      fabMt: 361.237,
      galvMt: 361.237,
      inspectionMt: 350.615,
      fileDespatchMt: 261.205,
    }),
  ];
  const comparison = compareOrderReviewCumulativeProgress(incoming, previous);
  const details = classifyCumulativeRegressionProjects(
    incoming,
    previous,
    comparison.regressions,
  );

  assert.equal(details[0]?.classification, "scope-reduction");
});

test("keeps the four signature classifications mutually exclusive", () => {
  const previous = [
    cumulativeRow("A", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 10,
      galvMt: 10,
      inspectionMt: 10,
      fileDespatchMt: 0,
    }),
    cumulativeRow("B", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 8,
      galvMt: 7,
      inspectionMt: 6,
      fileDespatchMt: 5,
    }),
    cumulativeRow("D", {
      woOrderQtyMt: 10,
      releaseMt: 10,
      fabMt: 10,
      galvMt: 10,
      inspectionMt: 10,
      fileDespatchMt: 5,
    }),
  ];
  const incoming = [
    cumulativeRow("A"),
    cumulativeRow("B", {
      woOrderQtyMt: 10,
      releaseMt: 9,
      fabMt: 8,
      galvMt: 7,
      inspectionMt: 6,
      fileDespatchMt: 5,
    }),
    cumulativeRow("D", {
      woOrderQtyMt: 8,
      releaseMt: 8,
      fabMt: 8,
      galvMt: 8,
      inspectionMt: 8,
      fileDespatchMt: 4,
    }),
  ];
  const comparison = compareOrderReviewCumulativeProgress(incoming, previous);
  const details = classifyCumulativeRegressionProjects(
    incoming,
    previous,
    comparison.regressions,
  );

  assert.deepEqual(
    details.map((detail) => [detail.project, detail.classification]),
    [
      ["A", "cancellation-transfer"],
      ["B", "correction"],
      ["D", "scope-reduction"],
    ],
  );
});