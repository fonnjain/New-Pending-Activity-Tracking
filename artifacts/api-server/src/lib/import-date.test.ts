import assert from "node:assert/strict";
import test from "node:test";
import { resolveWipImportDate } from "./import-date";

test("uses the selected WIP report date over file and upload dates", () => {
  assert.equal(
    resolveWipImportDate("2026-08-17", "2026-08-23", "2026-08-23"),
    "2026-08-17",
  );
});

test("keeps the inferred and current-day fallbacks for uploads without a selection", () => {
  assert.equal(
    resolveWipImportDate(null, "2026-08-17", "2026-08-23"),
    "2026-08-17",
  );
  assert.equal(resolveWipImportDate(null, null, "2026-08-23"), "2026-08-23");
});