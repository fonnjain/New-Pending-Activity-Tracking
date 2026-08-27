import assert from "node:assert/strict";
import test from "node:test";
import {
  canFinalizeEvidenceOutcome,
  evidenceKindForDetectedFileType,
  shouldDiscardStagingForWipReset,
} from "./upload-stage-evidence";

test("retains evidence for files whose type cannot be determined", () => {
  assert.equal(evidenceKindForDetectedFileType("wip"), "wip");
  assert.equal(evidenceKindForDetectedFileType("order-review"), "order-review");
  assert.equal(evidenceKindForDetectedFileType("unknown"), "unknown");
  assert.equal(evidenceKindForDetectedFileType("malformed"), "unknown");
});

test("WIP reset never discards an Order Review slot solely because it is malformed", () => {
  assert.equal(shouldDiscardStagingForWipReset("wip", "unknown"), true);
  assert.equal(shouldDiscardStagingForWipReset("order-review", "unknown"), false);
  assert.equal(shouldDiscardStagingForWipReset("order-review", "wip"), false);
  assert.equal(shouldDiscardStagingForWipReset(null, "wip"), true);
  assert.equal(shouldDiscardStagingForWipReset(null, "unknown"), false);
});

test("only an undecided record accepts a non-import terminal outcome", () => {
  assert.equal(canFinalizeEvidenceOutcome(null, "refused"), true);
  assert.equal(canFinalizeEvidenceOutcome(null, "skipped"), true);
  assert.equal(canFinalizeEvidenceOutcome(null, "expired"), true);
  assert.equal(canFinalizeEvidenceOutcome("refused", "skipped"), false);
  assert.equal(canFinalizeEvidenceOutcome("skipped", "expired"), false);
  assert.equal(canFinalizeEvidenceOutcome("expired", "refused"), false);
});

test("a later successful commit can finalize provisional evidence", () => {
  assert.equal(canFinalizeEvidenceOutcome(null, "imported"), true);
  assert.equal(canFinalizeEvidenceOutcome("refused", "imported"), true);
  assert.equal(canFinalizeEvidenceOutcome("skipped", "imported"), true);
  assert.equal(canFinalizeEvidenceOutcome("expired", "imported"), true);
});