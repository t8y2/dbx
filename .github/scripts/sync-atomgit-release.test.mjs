import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { AtomGitClient, atomGitAssets, uploadResultSucceeded } from "./sync-atomgit-release.mjs";

test("uploadResultSucceeded rejects AtomGit callback errors returned with HTTP success", () => {
  assert.equal(uploadResultSucceeded({ status: 0, stdout: "success", stderr: "" }), true);
  assert.equal(
    uploadResultSucceeded({
      status: 0,
      stdout: JSON.stringify({ message: "Fail to read response body", code: "CallBack.0002" }),
      stderr: "",
    }),
    false,
  );
});

test("atomGitAssets preserves attachment ids required for replacement", () => {
  assert.deepEqual(
    atomGitAssets({ assets: [{ id: 118266, name: "agent-registry.json" }] }),
    new Map([["agent-registry.json", { id: 118266, name: "agent-registry.json" }]]),
  );
});

test("deleteAsset removes an existing release attachment by id", async (t) => {
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
  const client = new AtomGitClient({
    apiBase: `http://127.0.0.1:${address.port}`,
    token: "test-token",
    owner: "t8y2",
    repo: "dbx",
  });

  await client.deleteAsset("agents-latest", 118266);
  assert.deepEqual(requests, [
    {
      method: "DELETE",
      url: "/repos/t8y2/dbx/releases/agents-latest/attach_files/118266",
    },
  ]);
});
