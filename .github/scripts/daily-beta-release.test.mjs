import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/daily-beta-release.yml", import.meta.url), "utf8");
const script = workflow.match(/        run: \|\n((?:          [^\n]*\n|\n)*)/)[1].replace(/^ {10}/gm, "");

function runDaily(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dbx-daily-beta-test-"));
  const statePath = join(root, "state.json");
  const gh = join(root, "gh");
  writeFileSync(statePath, JSON.stringify({ calls: [] }));
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_GH_STATE, "utf8"));
state.calls.push(args);
const save = () => fs.writeFileSync(process.env.MOCK_GH_STATE, JSON.stringify(state));
save();
if (args[0] === "release" && args[1] === "view") {
  if (args[2] === "--repo") { console.log("v0.6.59"); process.exit(0); }
  process.exit(1);
}
if (args[0] === "api" && args[1]?.includes("/git/ref/tags/")) {
  process.exit(process.env.MOCK_ORPHAN_TAG && args[1].endsWith(".1") ? 0 : 1);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
  state.tag = args.find(arg => arg.startsWith("ref=refs/tags/"))?.slice("ref=refs/tags/".length);
  state.sha = args.find(arg => arg.startsWith("sha="))?.slice(4);
  save(); process.exit(state.tag && state.sha === process.env.GITHUB_SHA ? 0 : 1);
}
if (args[0] === "release" && args[1] === "create") {
  if (!state.tag || args[2] !== state.tag || !args.includes("--verify-tag")) process.exit(1);
  state.release = args[2]; save(); process.exit(0);
}
if (args[0] === "workflow" && args[1] === "run") {
  const ref = args[args.indexOf("--ref") + 1];
  if (!state.release || ref !== state.tag || !args.includes("release_tag=" + ref)) process.exit(1);
  if (process.env.GH_TOKEN !== "test-dispatch-token") process.exit(1);
  state.dispatched = ref; save(); process.exit(0);
}
process.exit(1);
`);
  chmodSync(gh, 0o755);
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      MOCK_GH_STATE: statePath,
      GITHUB_REPOSITORY: "example/dbx",
      GITHUB_SHA: "a".repeat(40),
      REQUESTED_BASE_VERSION: "0.6.60",
      FORCE_BUILD: "",
      GH_TOKEN: "test-release-token",
      RELEASE_WORKFLOW_TOKEN: "test-dispatch-token",
      ...options,
    },
  });
  return { ...result, state: JSON.parse(readFileSync(statePath, "utf8")) };
}

test("daily beta creates a real tag before creating the draft and dispatching its build", () => {
  const result = runDaily();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.state.dispatched, /^v0\.6\.60-beta\.\d{8}\.1$/);
  assert.equal(result.state.sha, "a".repeat(40));
});

test("daily beta skips a tag left behind without a release", () => {
  const result = runDaily({ MOCK_ORPHAN_TAG: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.state.dispatched, /^v0\.6\.60-beta\.\d{8}\.2$/);
});

test("daily beta refuses to create refs when the workflow dispatch token is absent", () => {
  const result = runDaily({ RELEASE_WORKFLOW_TOKEN: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /MCP_RELEASE_TOKEN is required/);
  assert.equal(result.state.tag, undefined);
  assert.equal(result.state.release, undefined);
});
