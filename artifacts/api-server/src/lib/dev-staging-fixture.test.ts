import assert from "node:assert/strict";
import test from "node:test";
import {
  DEV_STAGING_ADMIN_EMAIL,
  DEV_STAGING_FIXTURE_PROJECT,
  DEV_STAGING_FIXTURE_ROW_HASH,
  isDevelopmentStagingFixturePoolRow,
} from "./dev-staging-fixture";

test("development staging fixture uses reserved non-production identifiers", () => {
  assert.match(DEV_STAGING_ADMIN_EMAIL, /@local\.invalid$/);
  assert.match(DEV_STAGING_FIXTURE_PROJECT, /^__DEV_E2E_/);
  assert.match(DEV_STAGING_FIXTURE_ROW_HASH, /^[a-f0-9]{64}$/);
});

test("fixture cleanup never accepts a same-project row with another identity", () => {
  assert.equal(
    isDevelopmentStagingFixturePoolRow(
      DEV_STAGING_FIXTURE_PROJECT,
      DEV_STAGING_FIXTURE_ROW_HASH,
    ),
    true,
  );
  assert.equal(
    isDevelopmentStagingFixturePoolRow(
      DEV_STAGING_FIXTURE_PROJECT,
      "0".repeat(64),
    ),
    false,
  );
});