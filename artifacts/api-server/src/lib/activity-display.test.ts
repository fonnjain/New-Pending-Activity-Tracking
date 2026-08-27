import assert from "node:assert/strict";
import test from "node:test";
import {
  activityDisplayKeyForRecord,
  INCOMPLETE_WIP_ACTIVITY_LABEL,
  isIncompleteBlankActivityWip,
} from "@workspace/domain";

test("separates only incomplete blank-activity Job Card WIP from Finished Goods", () => {
  assert.equal(
    activityDisplayKeyForRecord({
      category: "TLT",
      jobCardType: "Job Card WIP",
      activity: "",
      jobCardNo: "",
    }),
    INCOMPLETE_WIP_ACTIVITY_LABEL,
  );

  assert.equal(
    activityDisplayKeyForRecord({
      category: "TLT",
      jobCardType: "FG Pending for Dispatch",
      activity: "",
      jobCardNo: null,
    }),
    "Finished Goods (FG)",
  );
});

test("does not alter the display key for WIP rows with a job card or activity", () => {
  const blankActivityWithJobCard = {
    category: "TLT",
    jobCardType: "Job Card WIP",
    activity: "",
    jobCardNo: "JC-100",
  };
  const populatedActivityWithoutJobCard = {
    category: "TLT",
    jobCardType: "Job Card WIP",
    activity: "Q",
    jobCardNo: "",
  };

  assert.equal(isIncompleteBlankActivityWip(blankActivityWithJobCard), false);
  assert.equal(activityDisplayKeyForRecord(blankActivityWithJobCard), "Finished Goods (FG)");
  assert.equal(isIncompleteBlankActivityWip(populatedActivityWithoutJobCard), false);
  assert.equal(activityDisplayKeyForRecord(populatedActivityWithoutJobCard), "Q");
});