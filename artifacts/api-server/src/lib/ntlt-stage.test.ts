import assert from "node:assert/strict";
import test from "node:test";
import { classifyNtltStage } from "@workspace/domain";

test("BL Job Card WIP is an explicit NTLT stage exception", () => {
  assert.equal(
    classifyNtltStage({
      activity: "BL",
      jobCardType: "Job Card WIP",
      jobCardStatus: "Authorized",
    }),
    "unclassified",
  );
});

test("blank-activity Job Card WIP is an explicit NTLT stage exception", () => {
  assert.equal(
    classifyNtltStage({
      activity: null,
      jobCardType: "Job Card WIP",
      jobCardStatus: "Authorized",
    }),
    "unclassified",
  );
});

test("Job Card Not Started remains the approved NTLT Not Started stage", () => {
  assert.equal(
    classifyNtltStage({
      activity: "BL",
      jobCardType: "Job Card Not Started",
      jobCardStatus: "Initial",
    }),
    "notStarted",
  );
});