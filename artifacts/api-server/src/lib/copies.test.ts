import assert from "node:assert/strict";
import test from "node:test";
import { copyWeightedTotal, expandCopies } from "./copies";

test("expanded membership totals match compact copy-weighted totals", () => {
  const compactRows = [
    { id: "one", balanceWt: 1250, copies: 2 },
    { id: "two", balanceWt: 375, copies: 1 },
    { id: "three", balanceWt: 0, copies: 4 },
  ];

  const expandedRows = expandCopies(compactRows, (row) => ({
    id: row.id,
    balanceWt: row.balanceWt,
  }));
  const expandedTotal = expandedRows.reduce((total, row) => total + row.balanceWt, 0);
  const compactTotal = copyWeightedTotal(compactRows, (row) => row.balanceWt);

  assert.equal(expandedRows.length, 7);
  assert.equal(expandedTotal, 2875);
  assert.equal(compactTotal, expandedTotal);
});