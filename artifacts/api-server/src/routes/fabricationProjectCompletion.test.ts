import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { desc } from "drizzle-orm";
import { db, importsTable } from "@workspace/db";
import app from "../app";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine test server port"));
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
  "Fabrication Completion honors selected import IDs and rejects invalid selections",
  { timeout: 60_000 },
  async (t) => {
    const imports = await db
      .select({ id: importsTable.id })
      .from(importsTable)
      .orderBy(desc(importsTable.id))
      .limit(2);
    if (imports.length < 2) {
      t.skip("requires two committed WIP imports");
      return;
    }

    const nonLatestImport = imports[1]!;
    const missingImportId = imports[0]!.id + 1_000_000;
    const server = createServer(app);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}/api/reports/fabrication-project-completion-tlt`;

    try {
      const selectedResponse = await fetch(`${baseUrl}?importId=${nonLatestImport.id}`);
      const selected = await selectedResponse.json() as { importId?: number };
      assert.equal(selectedResponse.status, 200);
      assert.equal(selected.importId, nonLatestImport.id);

      const missingResponse = await fetch(`${baseUrl}?importId=${missingImportId}`);
      const missing = await missingResponse.json() as { importId?: number; available?: boolean };
      assert.equal(missingResponse.status, 404);
      assert.equal(missing.importId, missingImportId);
      assert.equal(missing.available, false);

      const fractionalResponse = await fetch(`${baseUrl}?importId=1.5`);
      assert.equal(fractionalResponse.status, 400);
    } finally {
      await close(server);
    }
  },
);