import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CnbClient, pruneReleaseAssets } from "./sync-cnb-release.mjs";

const scriptPath = fileURLToPath(new URL("./sync-cnb-release.mjs", import.meta.url));

test("ensureRelease accepts an empty successful PATCH response", async (t) => {
  const release = { id: "release-1", tag_name: "agents-latest", assets: [] };
  const requests = [];
  const server = createServer((request, response) => {
    const bodyChunks = [];
    request.on("data", (chunk) => bodyChunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) : null,
      });
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
    isPrerelease: false,
  });

  assert.deepEqual(result, release);
  assert.deepEqual(requests, [
    { method: "GET", url: "/dbxio.com/dbx/-/releases/tags/agents-latest", body: null },
    {
      method: "PATCH",
      url: "/dbxio.com/dbx/-/releases/release-1",
      body: {
        name: "Latest agents",
        body: "Latest stable agent release",
        prerelease: false,
      },
    },
  ]);
});

test("metadata-only sync updates release without reading an assets directory", async (t) => {
  const release = { id: "release-2", tag_name: "v1.2.3", assets: [{ name: "large.dmg" }] };
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

  const tempDir = await mkdtemp(join(tmpdir(), "sync-cnb-release-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const releasePath = join(tempDir, "release.json");
  await writeFile(
    releasePath,
    JSON.stringify({ tagName: "v1.2.3", name: "DBX v1.2.3", body: "Stable", isPrerelease: false }),
  );

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "--github-release", releasePath, "--metadata-only"], {
      env: {
        ...process.env,
        CNB_API_BASE: `http://127.0.0.1:${address.port}`,
        CNB_REPOSITORY: "dbxio.com/dbx",
        CNB_TOKEN: "test-token",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Updated CNB release metadata for v1\.2\.3/);
  assert.deepEqual(requests, [
    { method: "GET", url: "/dbxio.com/dbx/-/releases/tags/v1.2.3" },
    { method: "PATCH", url: "/dbxio.com/dbx/-/releases/release-2" },
  ]);
});

test("pruneReleaseAssets deletes files missing from the source release", async () => {
  const deleted = [];
  const client = {
    async deleteAsset(releaseId, assetId) {
      deleted.push({ releaseId, assetId });
    },
  };

  await pruneReleaseAssets(
    client,
    {
      id: "release-latest",
      assets: [
        { id: "registry", name: "agent-registry.json" },
        { id: "old-jre", name: "dbx-jre-8-linux-x64.tar.gz" },
        { id: "old-driver", name: "dbx-agent-h2-0.1.0.jar" },
      ],
    },
    new Set(["agent-registry.json"]),
  );

  assert.deepEqual(deleted, [
    { releaseId: "release-latest", assetId: "old-jre" },
    { releaseId: "release-latest", assetId: "old-driver" },
  ]);
});

test("deleteAsset accepts CNB's empty successful response", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.statusCode = 204;
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

  await client.deleteAsset("release/latest", "asset old");

  assert.deepEqual(requests, [
    {
      method: "DELETE",
      url: "/dbxio.com/dbx/-/releases/release%2Flatest/assets/asset%20old",
    },
  ]);
});
