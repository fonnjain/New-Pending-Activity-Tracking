import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import app from "../app";
import {
  DEV_STAGING_ADMIN_EMAIL,
  seedDevelopmentStagingAdmin,
} from "./dev-staging-fixture";

const fixturePath = fileURLToPath(
  new URL("./__fixtures__/dev-staging-lifecycle.csv", import.meta.url),
);

interface EvidenceRow {
  stagingId: string;
  sourceFilename: string;
  outcome: string | null;
  importId: number | null;
  importDeletedAt: string | null;
  importDeletionScope: string | null;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine integration-test port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test(
  "development fixture preserves staged-upload evidence across refusal, import deletion, and cleanup",
  { timeout: 180_000 },
  async (t) => {
    assert.equal(process.env.NODE_ENV, "development");
    assert.equal(process.env.DEV_STAGING_FIXTURE_ENABLED, "true");
    assert.ok(process.env.AUTH_PASSWORD, "AUTH_PASSWORD must be configured as a development secret");

    await seedDevelopmentStagingAdmin();
    const server = createServer(app);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}/api`;
    let cookie = "";
    let malformedStageId: string | null = null;
    let validStageId: string | null = null;
    let importId: number | null = null;

    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    };
    const jsonRequest = (path: string, body: unknown, method = "POST") =>
      request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const stage = async (filename: string, data: string, reportDate: string) => {
      const form = new FormData();
      form.set("file", new Blob([data], { type: "text/csv" }), filename);
      form.set("expectedType", "wip");
      form.set("reportDate", reportDate);
      const response = await request("/imports/stage", { method: "POST", body: form });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ stagingId: string }>;
    };
    const evidenceFor = async (stagingId: string) => {
      const response = await request("/imports/stage-evidence");
      assert.equal(response.status, 200);
      const rows = await response.json() as EvidenceRow[];
      const row = rows.find((entry) => entry.stagingId === stagingId);
      assert.ok(row, `Evidence must exist for staging id ${stagingId}`);
      return row;
    };

    try {
      const login = await jsonRequest("/auth/login", {
        email: DEV_STAGING_ADMIN_EMAIL,
        password: process.env.AUTH_PASSWORD,
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert.ok(cookie, "Login must set an authenticated session cookie");

      const validCsv = await readFile(fixturePath, "utf8");
      const malformedCsv = validCsv.replace("Activity,Operation", "Missing Activity,Operation");
      const malformed = await stage(
        "dev-staging-malformed.csv",
        malformedCsv,
        "2099-12-28",
      );
      malformedStageId = malformed.stagingId;

      const refused = await jsonRequest("/imports/commit", {
        stagingId: malformedStageId,
        expectedType: "wip",
      });
      assert.equal(refused.status, 400);
      const discardMalformed = await request(`/imports/stage/${malformedStageId}`, {
        method: "DELETE",
      });
      assert.equal(discardMalformed.status, 204);
      const refusedEvidence = await evidenceFor(malformedStageId);
      assert.equal(refusedEvidence.outcome, "refused");

      const valid = await stage(
        "dev-staging-lifecycle.csv",
        validCsv,
        "2099-12-28",
      );
      validStageId = valid.stagingId;
      const validation = await jsonRequest("/imports/validate", { stagingId: validStageId });
      assert.equal(validation.status, 200);
      const committed = await jsonRequest("/imports/commit", {
        stagingId: validStageId,
        expectedType: "wip",
      });
      assert.equal(committed.status, 201);
      const committedBody = await committed.json() as { import?: { id?: number } };
      importId = committedBody.import?.id ?? null;
      assert.ok(importId, "Commit must return the test import id");
      assert.equal((await evidenceFor(validStageId)).outcome, "imported");

      const deletedImport = await request(`/imports/${importId}`, { method: "DELETE" });
      assert.equal(deletedImport.status, 204);
      importId = null;
      const importedEvidence = await evidenceFor(validStageId);
      assert.equal(importedEvidence.outcome, "imported");
      assert.ok(importedEvidence.importDeletedAt);
      assert.equal(importedEvidence.importDeletionScope, "single import deletion");

      const cleanup = await jsonRequest("/auth/dev-staging-fixture-cleanup", {});
      assert.equal(cleanup.status, 200);
      assert.deepEqual(await cleanup.json(), { deletedPoolRows: 1 });
    } finally {
      if (malformedStageId) {
        await request(`/imports/stage/${malformedStageId}`, { method: "DELETE" });
      }
      if (validStageId) {
        await request(`/imports/stage/${validStageId}`, { method: "DELETE" });
      }
      if (importId) {
        await request(`/imports/${importId}`, { method: "DELETE" });
      }
      await jsonRequest("/auth/dev-staging-fixture-cleanup", {});
      await close(server);
    }
  },
);