import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CnbClient } from "./sync-cnb-release.mjs";

test("ensureRelease accepts an empty successful PATCH response", async (t) => {
  const release = { id: "release-1", tag_name: "agents-latest", assets: [] };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(release));
      return;
    }
    if (request.method === "PATCH") {
      response.statusCode = 200;
      response.end();
      return;
    }
    response.statusCode = 500;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new CnbClient({
    apiBase: `http://127.0.0.1:${address.port}`,
    repository: "dbxio.com/dbx",
    token: "test-token",
  });

  const result = await client.ensureRelease("agents-latest", {
    name: "Latest agents",
    body: "Latest stable agent release",
  });

  assert.deepEqual(result, release);
  assert.deepEqual(requests, [
    { method: "GET", url: "/dbxio.com/dbx/-/releases/tags/agents-latest" },
    { method: "PATCH", url: "/dbxio.com/dbx/-/releases/release-1" },
  ]);
});
