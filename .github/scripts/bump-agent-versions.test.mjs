import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateAgentVersionBump, resolveAgentReleaseBaseline, shouldBuildAgentJre } from "./bump-agent-versions.mjs";

const moduleExists = (path) => path === "agents/drivers/duckdb";

test("keeps the manually registered first DuckDB driver version", () => {
  const result = evaluateAgentVersionBump({
    versions: { duckdb: "0.1.0" },
    prevVersions: {},
    changedFiles: ["agents/versions.json", "agents/drivers/duckdb/src/main.rs"],
    moduleExists,
    readModuleFile: () => "",
  });

  assert.equal(result.versions.duckdb, "0.1.0");
  assert.equal(result.changed, false);
  assert.match(result.logs.join("\n"), /new module version kept at 0\.1\.0/);
});

test("bumps DuckDB after its initial release", () => {
  const result = evaluateAgentVersionBump({
    versions: { duckdb: "0.1.0" },
    changedFiles: ["agents/drivers/duckdb/src/main.rs"],
    moduleExists,
    readModuleFile: () => "",
  });

  assert.equal(result.versions.duckdb, "0.1.1");
});

test("bumps the native RabbitMQ agent from its Go directory", () => {
  const result = evaluateAgentVersionBump({
    versions: { rabbitmq: "0.1.0" },
    changedFiles: ["agents/drivers/rabbitmq/main.go"],
    moduleExists: (path) => path === "agents/drivers/rabbitmq",
    readModuleFile: () => "",
  });

  assert.equal(result.versions.rabbitmq, "0.1.1");
});

test("bumps the native Vastbase agent from its independent Go directory", () => {
  const result = evaluateAgentVersionBump({
    versions: { vastbase: "0.1.37" },
    changedFiles: ["agents/drivers/vastbase-go/main.go"],
    moduleExists: (path) => path === "agents/drivers/vastbase-go",
    readModuleFile: () => "",
  });

  assert.equal(result.versions.vastbase, "0.1.38");
  assert.deepEqual(result.nativeModules, ["vastbase"]);
});

test("bumps Cassandra from its native Go source directory", () => {
  const result = evaluateAgentVersionBump({
    versions: { cassandra: "0.1.37" },
    changedFiles: ["agents/drivers/cassandra-go/main.go"],
    moduleExists: (path) => path === "agents/drivers/cassandra-go",
    readModuleFile: () => "",
  });

  assert.equal(result.versions.cassandra, "0.1.38");
  assert.deepEqual(result.nativeModules, ["cassandra"]);
});

test("builds a manually versioned module even without runtime file changes", () => {
  const result = evaluateAgentVersionBump({
    versions: { duckdb: "0.1.1" },
    prevVersions: { duckdb: "0.1.0" },
    changedFiles: ["agents/versions.json"],
    moduleExists,
    readModuleFile: () => "",
  });

  assert.deepEqual(result.changedModules, ["duckdb"]);
  assert.deepEqual(result.nativeModules, ["duckdb"]);
  assert.deepEqual(result.reusedModules, []);
  assert.equal(result.versions.duckdb, "0.1.1");
});

test("builds only common-dependent Java modules for a shared runtime change", () => {
  const existing = new Set([
    "agents/drivers/access",
    "agents/drivers/access/build.gradle",
    "agents/drivers/mongodb",
    "agents/drivers/mongodb/build.gradle",
  ]);
  const result = evaluateAgentVersionBump({
    versions: { access: "0.1.0", mongodb: "0.1.0" },
    changedFiles: ["agents/common/src/main/java/com/dbx/Agent.java"],
    legacyStandaloneModules: new Set(["mongodb"]),
    moduleExists: (path) => existing.has(path),
    readModuleFile: () => "",
  });

  assert.deepEqual(result.changedModules, ["access"]);
  assert.deepEqual(result.javaModules, ["access"]);
  assert.deepEqual(result.reusedModules, ["mongodb"]);
  assert.equal(result.versions.access, "0.1.1");
  assert.equal(result.versions.mongodb, "0.1.0");
});

test("rebuilds JREs only for the first migration or release recipe changes", () => {
  assert.equal(shouldBuildAgentJre(["agents/drivers/access/src/main/java/Agent.java"]), false);
  assert.equal(shouldBuildAgentJre([".github/workflows/agents-release.yml"]), true);
  assert.equal(shouldBuildAgentJre([], true), true);
});

test("uses the first post-tag version sync as the effective release baseline", () => {
  const repository = createRepository({ kingbase: "0.1.0" });
  git(repository, ["tag", "agents-v0.2.72"]);

  writeVersions(repository, { kingbase: "0.1.1" });
  commitAll(repository, "chore: bump module versions [skip ci]");
  const syncCommit = git(repository, ["rev-parse", "HEAD"]);

  writeFileSync(join(repository, "agents/drivers/kingbase-go/kingbase_metadata.go"), "package main\n\nconst fixed = true\n");
  commitAll(repository, "fix(kingbase): export primary key columns");

  const baseline = resolveAgentReleaseBaseline({
    prevTag: "agents-v0.2.72",
    gitOutput: (args) => git(repository, args),
  });

  assert.equal(baseline.versionsRef, syncCommit);
  assert.deepEqual(baseline.versions, { kingbase: "0.1.1" });
  assert.deepEqual(baseline.changedFiles, ["agents/drivers/kingbase-go/kingbase_metadata.go"]);

  const result = evaluateAgentVersionBump({
    versions: { kingbase: "0.1.1" },
    prevVersions: baseline.versions,
    changedFiles: baseline.changedFiles,
    moduleExists: (path) => path === "agents/drivers/kingbase-go",
    readModuleFile: () => "",
  });
  assert.equal(result.versions.kingbase, "0.1.2");
  assert.deepEqual(result.nativeModules, ["kingbase"]);
});

test("keeps versions.json publish-relevant when it changes after the sync commit", () => {
  const repository = createRepository({ duckdb: "0.1.0" });
  git(repository, ["tag", "agents-v0.2.72"]);

  writeVersions(repository, { duckdb: "0.1.1" });
  commitAll(repository, "chore: bump module versions [skip ci]");
  writeVersions(repository, { duckdb: "0.1.2" });
  commitAll(repository, "chore: adjust DuckDB agent version");

  const baseline = resolveAgentReleaseBaseline({
    prevTag: "agents-v0.2.72",
    gitOutput: (args) => git(repository, args),
  });

  assert.equal(baseline.versionsChangedAfterSync, true);
  assert.deepEqual(baseline.versions, { duckdb: "0.1.1" });
  assert.deepEqual(baseline.changedFiles, ["agents/versions.json"]);
});

function createRepository(versions) {
  const repository = mkdtempSync(join(tmpdir(), "dbx-agent-release-"));
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "DBX Test"]);
  git(repository, ["config", "user.email", "dbx-test@example.com"]);
  mkdirSync(join(repository, "agents/drivers/kingbase-go"), { recursive: true });
  mkdirSync(join(repository, "agents/drivers/duckdb"), { recursive: true });
  writeVersions(repository, versions);
  writeFileSync(join(repository, "agents/drivers/kingbase-go/kingbase_metadata.go"), "package main\n");
  writeFileSync(join(repository, "agents/drivers/duckdb/Cargo.toml"), "[package]\nname = \"duckdb-test\"\n");
  commitAll(repository, "feat(agents): initial release state");
  return repository;
}

function writeVersions(repository, versions) {
  mkdirSync(join(repository, "agents"), { recursive: true });
  writeFileSync(join(repository, "agents/versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
}

function commitAll(repository, message) {
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", message]);
}

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}
