import assert from "node:assert/strict";
import test from "node:test";
import {
  getSingleRouteParam,
} from "./route-boundaries";
import { hasReportDate } from "./previous-import-condition";

test("narrows a route parameter to one string without coercing arrays", () => {
  assert.equal(getSingleRouteParam("user-123"), "user-123");
  assert.equal(getSingleRouteParam(""), "");
  assert.equal(getSingleRouteParam(["user-123"]), null);
  assert.equal(getSingleRouteParam(undefined), null);
});

test("only a non-null report date can form a predecessor comparison", () => {
  assert.equal(hasReportDate("2026-08-24"), true);
  assert.equal(hasReportDate(null), false);
});