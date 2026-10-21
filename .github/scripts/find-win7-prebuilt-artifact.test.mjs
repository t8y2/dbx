import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findMainArtifact, selectMainArtifact } from "./find-win7-prebuilt-artifact.mjs";

const repositoryId = 1224172037;
const name = "win7-aws-lc-test";
const artifact = (id, branch, headRepositoryId = repositoryId) => ({
  name,
  expired: false,
  created_at: `2026-10-17T00:00:0${id}Z`,
  workflow_run: {
    id,
    head_branch: branch,
    repository_id: repositoryId,
    head_repository_id: headRepositoryId,
  },
});

test("artifact lookup ignores PR and fork artifacts", () => {
  const selected = selectMainArtifact([
    artifact(1, "main"),
    artifact(2, "feature"),
    artifact(3, "main", 999),
    { ...artifact(4, "main"), expired: true },
    artifact(5, "main"),
  ], name, repositoryId);
  assert.equal(selected.workflow_run.id, 5);
});

test("artifact lookup requests the exact name", async () => {
  const selected = await findMainArtifact({
    name,
    repository: "t8y2/dbx",
    repositoryId,
    token: "synthetic",
    request: async (url, options) => {
      assert.equal(url.searchParams.get("name"), name);
      assert.equal(options.headers.Authorization, "Bearer synthetic");
      return { ok: true, json: async () => ({ artifacts: [artifact(6, "main")] }) };
    },
  });
  assert.equal(selected.workflow_run.id, 6);
});

test("artifact lookup reports API errors", async () => {
  await assert.rejects(
    findMainArtifact({
      name,
      repository: "t8y2/dbx",
      repositoryId,
      token: "synthetic",
      request: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});

test("artifact lookup has a help command", () => {
  const script = fileURLToPath(new URL("./find-win7-prebuilt-artifact.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: {} });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
