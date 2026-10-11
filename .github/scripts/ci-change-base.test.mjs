import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changeBase } from "./ci-change-base.mjs";
import { changedPaths, planCi } from "./ci-plan.mjs";

function mergeFixture(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "dbx-ci-change-base-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, content) => {
    const filename = path.join(root, file);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  };
  const commit = (message) => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "CI Fixture");
  write("crates/dbx-core/tests/old.rs", "original source\n");
  write("crates/dbx-core/tests/deleted.rs", "removed source\n");
  write("crates/dbx-web/src/routes/transfer.rs", "original route\n");
  const staleBase = commit("baseline");
  git("checkout", "-b", "pull-request");
  git("mv", "crates/dbx-core/tests/old.rs", "crates/dbx-core/tests/renamed\nfile.rs");
  git("rm", "crates/dbx-core/tests/deleted.rs");
  write("crates/dbx-core/tests/runtime_diagnostic_history.rs", "diagnostic test\n");
  write("crates/dbx-web/src/routes/transfer.rs", "updated route\n");
  const pullRequestHead = commit("PR diagnostic changes");
  git("checkout", "main");
  write(".github/workflows/ci.yml", "main CI changes\n");
  write("agents/drivers/zookeeper/main.go", "main native Agent changes\n");
  write("agents/drivers/oceanbase-oracle/src/main/java/Agent.java", "main JDBC changes\n");
  const actualBase = commit("main advances while PR remains open");
  git("-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "pull-request", "-m", "synthetic PR test merge");
  return { directory, root, staleBase, actualBase, pullRequestHead };
}

test("PR routing uses the exact test merge first parent, excluding unrelated main changes", (context) => {
  const fixture = mergeFixture(context);
  const base = changeBase({ eventName: "pull_request", before: fixture.staleBase, root: fixture.root });
  assert.equal(base, fixture.actualBase);
  assert.notEqual(base, fixture.pullRequestHead);
  const files = changedPaths(base, fixture.root);
  assert.deepEqual(files.toSorted(), [
    "crates/dbx-core/tests/old.rs", "crates/dbx-core/tests/deleted.rs", "crates/dbx-core/tests/renamed\nfile.rs",
    "crates/dbx-core/tests/runtime_diagnostic_history.rs", "crates/dbx-web/src/routes/transfer.rs",
  ].toSorted());
  const metadata = {
    workspace_members: ["dbx-core", "dbx-web", "dbx"],
    packages: [
      { id: "dbx-core", name: "dbx-core", manifest_path: path.join(fixture.root, "crates/dbx-core/Cargo.toml"), dependencies: [] },
      { id: "dbx-web", name: "dbx-web", manifest_path: path.join(fixture.root, "crates/dbx-web/Cargo.toml"), dependencies: [{ name: "dbx-core" }] },
      { id: "dbx", name: "dbx", manifest_path: path.join(fixture.root, "src-tauri/Cargo.toml"), dependencies: [{ name: "dbx-core" }] },
    ],
  };
  const corrected = planCi({ files, metadata, root: fixture.root });
  assert.equal(corrected.rust_full, false);
  assert.deepEqual(corrected.rust_matrix.include.map((entry) => entry.group), ["application"]);
  assert.deepEqual(corrected.agent_rust.include, [{ driver: "duckdb" }]);
  assert.equal(corrected.agent_java, false);
  assert.deepEqual(corrected.agent_go.include, []);
  assert.deepEqual(corrected.agent_integration.include, []);
  assert.equal(corrected.windows_standard, true);
  assert.equal(corrected.windows_win7_bundle, false);
  const staleFiles = changedPaths(fixture.staleBase, fixture.root);
  assert.ok(staleFiles.includes(".github/workflows/ci.yml"));
  assert.ok(staleFiles.includes("agents/drivers/zookeeper/main.go"));
  const polluted = planCi({ files: staleFiles, metadata, root: fixture.root });
  assert.equal(polluted.rust_full, true);
  assert.equal(polluted.agent_java, true);
  assert.ok(polluted.agent_go.include.length > 0);
  assert.ok(polluted.agent_integration.include.length > 0);
});

test("a depth-two checkout preserves the PR parents and supports the base CLI", (context) => {
  const fixture = mergeFixture(context);
  const checkout = path.join(fixture.directory, "depth-two");
  execFileSync("git", ["clone", "--depth=2", pathToFileURL(fixture.root).href, checkout], { stdio: "pipe" });
  assert.equal(changeBase({ eventName: "pull_request", root: checkout }), fixture.actualBase);
  assert.deepEqual(changedPaths(fixture.actualBase, checkout), changedPaths(fixture.actualBase, fixture.root));
  const output = execFileSync(process.execPath, [path.join(import.meta.dirname, "ci-change-base.mjs")], {
    cwd: checkout, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", BEFORE_SHA: fixture.staleBase },
  });
  assert.equal(output.trim(), fixture.actualBase);
});

test("PR base detection rejects a nonmerge commit and a depth-one checkout", (context) => {
  const fixture = mergeFixture(context);
  const checkout = path.join(fixture.directory, "depth-one");
  execFileSync("git", ["clone", "--depth=1", pathToFileURL(fixture.root).href, checkout], { stdio: "pipe" });
  assert.throws(() => changeBase({ eventName: "pull_request", root: checkout }), /merge commit and both parents/);
  execFileSync("git", ["checkout", "--detach", fixture.pullRequestHead], { cwd: fixture.root, stdio: "pipe" });
  assert.throws(() => changeBase({ eventName: "pull_request", root: fixture.root }), /merge commit and both parents/);
});

test("push routing preserves the event before SHA even when HEAD is a merge", (context) => {
  const fixture = mergeFixture(context);
  assert.equal(changeBase({ eventName: "push", before: fixture.staleBase, root: fixture.root }), fixture.staleBase);
  assert.equal(changeBase({ eventName: "push", before: fixture.pullRequestHead, root: fixture.root }), fixture.pullRequestHead);
  for (const before of [undefined, "", "0".repeat(40)]) {
    assert.equal(changeBase({ eventName: "push", before }), null);
  }
  for (const before of ["not-a-ref", "HEAD", "a".repeat(39), "a".repeat(41)]) {
    assert.throws(() => changeBase({ eventName: "push", before }), /Invalid push base SHA/);
  }
});
