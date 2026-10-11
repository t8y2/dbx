import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { goAgents, integrationCases, rustGroups } from "./ci-config.mjs";
import { cargoMetadata, changedPaths, planCi } from "./ci-plan.mjs";
import { rustCommand } from "./ci-rust.mjs";
import { gateFailures } from "./ci-gate.mjs";
import { assertCoverage, parseCoverage } from "./ci-rust-coverage.mjs";

const root = "/fixture";
const graph = {
  "dbx-types": [], "dbx-platform": [], "dbx-formats": [], "dbx-sql-core": ["dbx-types"],
  "dbx-sql-dialect": ["dbx-types"], "dbx-sql-data": ["dbx-sql-core", "dbx-sql-dialect", "dbx-types"],
  "dbx-sql-schema": ["dbx-sql-core", "dbx-sql-dialect", "dbx-types"],
  "dbx-sql": ["dbx-sql-core", "dbx-sql-data", "dbx-sql-dialect", "dbx-sql-schema", "dbx-types"],
  "dbx-ai-provider": ["dbx-platform"], "dbx-plugin-runtime": ["dbx-platform", "dbx-types"],
  "dbx-driver-support": ["dbx-platform", "dbx-types"],
  "dbx-driver-agent": ["dbx-platform", "dbx-sql-core", "dbx-types"],
  "dbx-driver-elasticsearch": ["dbx-driver-support", "dbx-types"],
  "dbx-driver-mongodb": ["dbx-driver-support", "dbx-types"],
  "dbx-driver-mysql": ["dbx-driver-support", "dbx-sql-core", "dbx-sql-dialect", "dbx-types"],
  "dbx-driver-postgres": ["dbx-driver-support", "dbx-sql-core", "dbx-types"],
  "dbx-driver-redis": ["dbx-driver-support", "dbx-types"],
  "dbx-driver-sqlserver": ["dbx-driver-support", "dbx-sql-core", "dbx-sql-data", "dbx-types"],
  "dbx-sqlite-worker": [], "dbx-drivers": ["dbx-driver-agent", "dbx-driver-elasticsearch", "dbx-driver-mongodb",
    "dbx-driver-mysql", "dbx-driver-postgres", "dbx-driver-redis", "dbx-driver-sqlserver", "dbx-driver-support",
    "dbx-platform", "dbx-sql-core", "dbx-sql-data", "dbx-sql-dialect", "dbx-types", "dbx-sqlite-worker"],
  "dbx-core": ["dbx-drivers", "dbx-sql", "dbx-types", "dbx-platform", "dbx-ai-provider", "dbx-plugin-runtime", "dbx-formats"],
  "dbx-mcp": ["dbx-core"], "dbx-cli": ["dbx-core", "dbx-mcp"], "dbx-web": ["dbx-core", "dbx-mcp"], "dbx": ["dbx-core", "dbx-mcp", "dbx-tauri-consul", "dbx-tauri-schema"],
  "dbx-tauri-consul": ["dbx-core"], "dbx-tauri-schema": ["dbx-core"],
};
const metadata = {
  workspace_members: Object.keys(graph),
  packages: Object.entries(graph).map(([name, dependencies]) => ({
    id: name, name, manifest_path: `${root}/${name === "dbx" ? "src-tauri" : `crates/${name}`}/Cargo.toml`,
    dependencies: dependencies.map((dependency) => ({ name: dependency })),
  })),
};
const plan = (files, options = {}) => planCi({ files, metadata, root, ...options });
const groups = (result) => result.rust_matrix.include.map((entry) => entry.group);

test("the planner uses the runner stable Cargo only for metadata", () => {
  let invocation;
  const result = cargoMetadata("/workspace", (command, args, options) => {
    invocation = { command, args, options };
    return '{"packages":[],"workspace_members":[]}';
  });
  assert.deepEqual(result, { packages: [], workspace_members: [] });
  assert.equal(invocation.command, "cargo");
  assert.deepEqual(invocation.args, ["+stable", "metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"]);
  assert.equal(invocation.options.cwd, "/workspace");
});
const routedJobs = { frontend: "frontend", packages: "packages", "github-scripts": "github_scripts",
  "windows-standard-check": "windows_standard", "windows-win7-bundle": "windows_win7_bundle",
  "duckdb-windows-driver": "duckdb_windows", jdbc: "jdbc", "offline-jdbc-release": "offline_jdbc", "nix-packaging": "nix" };

test("only an exact contributor snapshot diff skips desktop frontend validation", () => {
  for (const eventName of ["pull_request", "push"]) {
    assert.equal(plan(["docs/data/contributors.json"], { eventName }).contributor_snapshot_only, true);
    for (const files of [null, [], ["docs/lib/contributorActivity.test.ts"],
      ["docs/data/contributors.json", "apps/desktop/src/main.ts"],
      ["docs/data/contributors.json", "docs/lib/contributorActivity.ts"],
      ["docs/data/contributors.json", "Cargo.lock"]]) {
      assert.equal(plan(files, { eventName }).contributor_snapshot_only, false);
    }
  }
});

test("foundation changes select transitive consumers and standalone DuckDB", () => {
  const result = plan(["crates/dbx-types/src/lib.rs"]);
  assert.deepEqual(groups(result), ["foundation", "drivers", "application"]);
  for (const name of ["dbx-types", "dbx-sql", "dbx-drivers", "dbx-core", "dbx-web", "dbx-cli", "dbx-mcp", "dbx"]) {
    assert.ok(result.affected_packages.includes(name), name);
  }
  assert.deepEqual(result.agent_rust.include, [{ driver: "duckdb" }]);
  assert.equal(result.duckdb_changed, true);
  assert.equal(result.duckdb_windows, false);
  assert.equal(result.rust_groups_known, true);
  assert.equal(result.agent_java, false);
});

test("core and consumer changes do not pull unrelated foundation test groups", () => {
  assert.deepEqual(groups(plan(["crates/dbx-core/src/query/mod.rs"])), ["application"]);
  const cli = plan(["crates/dbx-cli/src/main.rs"]);
  assert.deepEqual(groups(cli), ["application"]);
  assert.equal(cli.agents, false);
  assert.deepEqual(groups(plan(["crates/dbx-driver-postgres/src/postgres.rs"])), ["drivers", "application"]);
});

test("Win7 candidate follows the desktop package dependency graph", () => {
  assert.equal(plan(["crates/dbx-core/src/query/mod.rs"]).windows_win7_candidate, true);
  assert.equal(plan(["crates/dbx-drivers/src/lib.rs"]).windows_win7_candidate, true);
  assert.equal(plan(["crates/dbx-cli/src/main.rs"]).windows_win7_candidate, false);
});

test("ordinary desktop Rust changes keep Windows compilation without full Win7 packaging", () => {
  for (const file of ["crates/dbx-core/src/query/mod.rs", "crates/dbx-core/tests/runtime_diagnostic_history.rs",
    "crates/dbx-drivers/src/lib.rs", "crates/dbx-driver-postgres/src/postgres.rs", "crates/dbx-driver-mysql/tests/query.rs",
    "src-tauri/src/commands/query.rs", "crates/dbx-tauri-consul/src/lib.rs", "crates/dbx-tauri-schema/src/lib.rs"]) {
    const result = plan([file]);
    assert.equal(result.windows_standard, true, file);
    assert.equal(result.windows_win7_bundle, false, file);
  }
  for (const file of ["crates/dbx-cli/src/main.rs", "crates/dbx-web/src/routes/transfer.rs", "docs/README.md"]) {
    const result = plan([file]);
    assert.equal(result.windows_standard, false, file);
    assert.equal(result.windows_win7_bundle, false, file);
  }
});

test("old Win7 Rust paths remain candidates through the dependency graph", () => {
  for (const file of [
    "src-tauri/src/commands/update.rs",
    "crates/dbx-core/src/host/update.rs",
    "crates/dbx-driver-postgres/src/postgres.rs",
    "crates/dbx-platform/src/lib.rs",
  ]) {
    assert.equal(plan([file]).windows_win7_candidate, true, file);
  }
});

test("Win7 infrastructure changes remain candidates outside the Cargo graph", () => {
  for (const file of [
    ".github/scripts/assert-win7-pe-compat.ps1",
    ".github/scripts/assert-webview2-win7-loader.ps1",
    ".github/scripts/assert-win7-installer-content.ps1",
    ".github/scripts/assert-webview2-win7-runtime.ps1",
    ".github/scripts/prepare-webview2-win7-loader.ps1",
    ".github/scripts/prepare-webview2-win7-runtime.ps1",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "src-tauri/tauri.webview2-win7-fixed.conf.json",
    "src-tauri/build.rs",
    "src-tauri/windows/nsis/installer.nsi",
    "vendor/wry/src/lib.rs",
    "vendor/webview2-com-sys/src/lib.rs",
    "vendor/ctor/src/lib.rs",
    "vendor/dirs-sys/src/lib.rs",
    "vendor/pageant/src/lib.rs",
    ".cargo/config.toml",
    "rust-toolchain.toml",
    ".github/fixtures/win7-imports/dll.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.windows.conf.json",
    "src-tauri/src/commands/update.rs",
    "crates/dbx-core/src/host/update.rs",
    "crates/dbx-platform/src/lib.rs",
  ]) {
    const result = plan([file]);
    assert.equal(result.windows_win7_candidate, true, file);
    assert.equal(result.windows_standard, true, file);
    assert.equal(result.windows_win7_bundle, true, file);
  }
});

test("Win7 dependency inputs fail open", () => {
  for (const file of ["Cargo.toml", "Cargo.lock", "src-tauri/Cargo.toml", "crates/dbx-cli/Cargo.toml"]) {
    assert.equal(plan([file]).windows_win7_candidate, true, file);
    assert.equal(plan([file]).windows_standard, true, file);
    assert.equal(plan([file]).windows_win7_bundle, true, file);
  }
});

test("unknown Rust changes and unknown diffs remain Win7 candidates", () => {
  for (const files of [["crates/new-engine/src/lib.rs"], null]) {
    const result = plan(files);
    assert.equal(result.windows_win7_candidate, true);
    assert.equal(result.windows_standard, true);
    assert.equal(result.windows_win7_bundle, true);
  }
  const fixture = structuredClone(metadata);
  fixture.workspace_members.push("new-engine");
  fixture.packages.push({ id: "new-engine", name: "new-engine", manifest_path: `${root}/crates/new-engine/Cargo.toml`, dependencies: [] });
  const result = plan(["crates/dbx-web/src/lib.rs"], { metadata: fixture });
  assert.equal(result.windows_standard, true);
  assert.equal(result.windows_win7_bundle, true);
  assert.equal(result.windows_win7_reasons.unknown_member, true);
  assert.equal(plan(["docs/README.md"], { metadata: fixture }).windows_win7_bundle, false);
});

test("unrelated CI inputs do not become Win7 candidates through full Rust coverage", () => {
  const result = plan([".github/scripts/ci-gate.mjs"]);
  assert.equal(result.rust_full, true);
  assert.equal(result.windows_win7_candidate, false);
});

test("Win7 affected packages stay independent from full Rust coverage", () => {
  const result = plan([".github/scripts/ci-gate.mjs"]);
  assert.ok(result.affected_packages.includes("dbx"));
  assert.deepEqual(result.windows_win7_affected_packages, []);
});

test("Win7 candidate reports each routing reason", () => {
  assert.equal(plan([".github/scripts/assert-win7-pe-compat.ps1"]).windows_win7_reasons.infrastructure, true);
  assert.equal(plan(["Cargo.lock"]).windows_win7_reasons.dependency_input, true);
  assert.equal(plan(["crates/dbx-core/src/lib.rs"]).windows_win7_reasons.desktop_dependency, true);
  assert.equal(plan(["crates/new-engine/src/lib.rs"]).windows_win7_reasons.unknown_rust, true);
  assert.deepEqual(plan(["crates/dbx-cli/src/main.rs"]).windows_win7_reasons, {
    infrastructure: false,
    dependency_input: false,
    desktop_dependency: false,
    unknown_rust: false,
    unknown_member: false,
  });
});

test("code generation and test-only dependencies participate in impact analysis", () => {
  assert.deepEqual(groups(plan(["plugins/connection-types/postgres.yaml"])), ["foundation", "drivers", "application"]);
  assert.deepEqual(groups(plan(["plugins/dialects/postgres.yaml"])), ["foundation", "drivers", "application"]);
  const fixture = structuredClone(metadata);
  fixture.packages.find((pkg) => pkg.name === "dbx-types").dependencies.push({ name: "dbx-formats", kind: "dev" });
  assert.ok(plan(["crates/dbx-formats/src/lib.rs"], { metadata: fixture }).affected_packages.includes("dbx-types"));
});

for (const file of ["Cargo.toml", "Cargo.lock", ".cargo/config.toml", "rust-toolchain.toml", "vendor/wry/src/lib.rs",
  "crates/dbx-sql/Cargo.toml", ".github/workflows/ci.yml", ".github/scripts/ci-plan.mjs", ".github/scripts/ci-gate.test.mjs"]) {
  test(`shared input ${file} retains full workspace and Agent coverage`, () => {
    const result = plan([file]);
    assert.deepEqual(groups(result), ["workspace"]);
    assert.equal(result.rust_full, true);
    assert.equal(result.agent_go.include.length, goAgents.length);
    assert.equal(result.agent_rust.include.length, 2);
    assert.equal(result.agent_integration.include.length, 16);
    assert.equal(result.agent_java, true);
    assert.equal(result.duckdb_windows, true);
  });
}

test("main and unknown graph changes fail open to full test coverage", () => {
  assert.deepEqual(groups(plan(["crates/dbx-core/src/lib.rs"], { eventName: "push" })), ["workspace"]);
  assert.deepEqual(groups(plan(["crates/new-engine/src/lib.rs"])), ["workspace"]);
  assert.deepEqual(groups(plan(null)), ["workspace"]);
  const fixture = structuredClone(metadata);
  fixture.packages.push({ name: "new-member", id: "new-member", manifest_path: `${root}/crates/new-member/Cargo.toml`, dependencies: [] });
  fixture.workspace_members.push("new-member");
  assert.deepEqual(groups(plan(["crates/dbx-core/src/lib.rs"], { metadata: fixture })), ["workspace"]);
  assert.equal(plan(["crates/dbx-core/src/lib.rs"], { metadata: fixture }).rust_groups_known, false);
  assert.deepEqual(groups(plan(["scripts/core-architecture.test.mjs"])), ["workspace"]);
});

test("unrelated docs skip Rust and Agents without inventing a matrix row", () => {
  const result = plan(["docs/README.md"]);
  assert.equal(result.rust, false);
  assert.equal(result.agents, false);
  assert.equal(result.fast, false);
  assert.deepEqual(result.rust_matrix, { include: [] });
});

for (const driver of ["duckdb", "tdengine", ...goAgents.map((entry) => entry.driver)]) {
  test(`native ${driver} changes only select their Agent tests and live cases`, () => {
    const result = plan([`agents/drivers/${driver}/source`], { agentsChanged: true });
    assert.equal(result.rust, false);
    assert.equal(result.agent_java, false);
    assert.ok([...result.agent_go.include, ...result.agent_rust.include].every((entry) => entry.driver === driver));
    assert.ok(result.agent_integration.include.every((entry) => entry.driver === driver));
  });
}

test("known JDBC driver changes only select Java agent tests", () => {
  const result = plan(["agents/drivers/oceanbase-oracle/src/main/java/Agent.java"], {
    agentsChanged: true,
    javaDrivers: ["oceanbase-oracle", "dameng"],
  });
  assert.equal(result.rust, false);
  assert.equal(result.agents, true);
  assert.equal(result.agent_java, true);
  assert.equal(result.agent_go.include.length, 0);
  assert.equal(result.agent_rust.include.length, 0);
  assert.equal(result.agent_integration.include.length, 0);
  assert.equal(result.duckdb_changed, false);
  assert.equal(result.fast, true);
});

test("shared Agent inputs and unknown native modules never silently lose coverage", () => {
  for (const file of ["agents/common/src/main/java/Protocol.java", "agents/scripts/validate_agents.py", "agents/build.gradle",
    "agents/drivers/new-driver/main.go", "crates/dbx-driver-agent/assets/agent-protocol-v2.json", ".github/workflows/agents-release.yml"]) {
    const result = plan([file]);
    assert.equal(result.agent_go.include.length, goAgents.length, file);
    assert.equal(result.agent_integration.include.length, 16, file);
    assert.equal(result.agent_java, true, file);
  }
  const fallback = plan(["future-agent-filter-input"], { agentsChanged: true });
  assert.equal(fallback.agent_go.include.length, goAgents.length);
  assert.equal(fallback.agent_integration.include.length, 16);
  assert.equal(fallback.agent_java, true);
});

test("the independent live matrix preserves every old version and authentication case", () => {
  assert.deepEqual(integrationCases.map((entry) => `${entry.scenario}:${entry.version}`), [
    "zookeeper:3.4.14", "zookeeper:3.5.5", "zookeeper:3.7.0", "zookeeper:3.9.5", "zookeeper-sasl:3.7.0",
    "rocketmq:4.9.8", "rocketmq:5.3.1", "tdengine:2.4.0.14", "tdengine:2.6.0.34", "tdengine:3.0.7.1",
    "tdengine:3.3.6.13", "tdengine:3.4.2.2", "cassandra:3.11.19", "cassandra:5.0.6", "rabbitmq:3.13", "rabbitmq:4.3",
  ]);
  assert.equal(integrationCases.find((entry) => entry.version === "3.4.2.2").image, "tdengine/tsdb:3.4.2.2");
  assert.deepEqual(goAgents.filter((entry) => entry.race).map((entry) => entry.driver), ["rocketmq", "zookeeper"]);
});

test("test groups partition every current workspace package exactly once", () => {
  const selected = Object.values(rustGroups).flat();
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.toSorted(), Object.keys(graph).toSorted());
});

test("Rust groups cover the actual workspace metadata, including extracted Tauri crates", () => {
  const repository = path.resolve(import.meta.dirname, "../..");
  const actual = cargoMetadata(repository);
  const members = actual.packages.filter((pkg) => actual.workspace_members.includes(pkg.id)).map((pkg) => pkg.name);
  assert.deepEqual(Object.values(rustGroups).flat().toSorted(), members.toSorted());
  const result = planCi({ files: ["crates/dbx-core/tests/runtime_diagnostic_history.rs", "crates/dbx-web/src/routes/transfer.rs"],
    metadata: actual, root: repository });
  assert.equal(result.rust_groups_known, true);
  assert.equal(result.rust_full, false);
  assert.deepEqual(groups(result), ["application"]);
  assert.deepEqual(result.agent_rust.include, [{ driver: "duckdb" }]);
  assert.equal(result.agent_java, false);
  assert.equal(result.agent_go.include.length, 0);
  assert.equal(result.agent_integration.include.length, 0);
});

test("workspace Cargo flags preserve full versus fast coverage and strict clippy", () => {
  for (const mode of ["fast", "full"]) {
    const command = rustCommand("test", "workspace", mode);
    assert.deepEqual(command.slice(0, 3), ["nextest", "run", "--no-fail-fast"]);
    const features = command.at(-1).split(",");
    assert.ok(command.includes("--workspace"));
    assert.ok(command.includes("--locked"));
    for (const pkg of ["dbx", "dbx-core", "dbx-web"]) {
      for (const feature of ["duckdb-sidecar", "dynamodb", "mq-admin", "sqlite-sqlcipher"]) assert.ok(features.includes(`${pkg}/${feature}`));
      assert.equal(features.includes(`${pkg}/system-fonts`), mode === "full");
    }
    assert.deepEqual(rustCommand("clippy", "workspace", mode).slice(-3), ["--", "-D", "warnings"]);
    assert.equal(rustCommand("clippy", "workspace", mode)[0], "clippy");
  }
  for (const group of Object.keys(rustGroups)) assert.ok(rustCommand("test", group, "fast").includes("--package"));
  assert.throws(() => rustCommand("test", "unknown", "full"));
  assert.throws(() => rustCommand("clippy", "foundation", "full"));
});

test("nextest, doctests and coverage select identical packages and features in every Rust lane", () => {
  for (const group of ["workspace", ...Object.keys(rustGroups)]) {
    for (const mode of ["fast", "full"]) {
      const nextest = rustCommand("test", group, mode);
      const doctest = rustCommand("doctest", group, mode);
      assert.deepEqual(nextest.slice(0, 3), ["nextest", "run", "--no-fail-fast"]);
      const selection = nextest.slice(3).filter((argument) => argument !== "--timings");
      assert.deepEqual(doctest, ["test", "--doc", ...selection]);
      assert.deepEqual(rustCommand("tree", group, mode), ["tree", ...selection]);
      assert.ok(nextest.includes("--timings"));
      assert.ok(rustCommand("clippy", "workspace", mode).includes("--timings"));
      assert.ok(nextest.includes("--no-default-features"));
      assert.ok(nextest.includes("--locked"));
    }
  }
  assert.throws(() => rustCommand("doctest", "unknown", "full"));
  assert.throws(() => rustCommand("doctest", "workspace", "unknown"));
  assert.throws(() => rustCommand("unknown", "workspace", "full"));
});

function results(files) {
  const selected = plan(files);
  return { changes: { result: "success", outputs: { plan: JSON.stringify(selected) } },
    "fast-checks": { result: selected.fast ? "success" : "skipped" },
    "rust-fmt-clippy": { result: selected.rust ? "success" : "skipped" }, "rust-test": { result: selected.rust ? "success" : "skipped" },
    "agent-checks": { result: selected.agents ? "success" : "skipped" }, "agent-java": { result: selected.agent_java ? "success" : "skipped" },
    "agent-go": { result: selected.agent_go_changed ? "success" : "skipped" },
    "agent-rust": { result: selected.agent_rust_changed ? "success" : "skipped" },
    "agent-integration": { result: selected.agent_integration_changed ? "success" : "skipped" } };
}

test("gates accept only successful selected jobs and intentionally skipped unselected jobs", () => {
  for (const files of [["docs/README.md"], ["Cargo.lock"], ["agents/drivers/rabbitmq/main.go"]]) {
    for (const mode of ["rust", "agents"]) assert.deepEqual(gateFailures(results(files), mode), []);
  }
  for (const result of ["skipped", "failure", "cancelled", undefined]) {
    const needs = results(["Cargo.lock"]);
    needs["rust-test"].result = result;
    assert.ok(gateFailures(needs, "rust").length);
    needs["agent-integration"].result = result;
    assert.ok(gateFailures(needs, "agents").length);
  }
  const needs = results(["docs/README.md"]);
  needs["agent-go"].result = "cancelled";
  assert.ok(gateFailures(needs, "agents").length);
  needs.changes.result = "failure";
  assert.ok(gateFailures(needs, "rust").length);
  assert.ok(gateFailures({ changes: { result: "success", outputs: { plan: "{}" } } }, "rust").length);
  assert.ok(gateFailures({ changes: { result: "success", outputs: { plan: "null" } } }, "rust").length);
});

test("the frontend gate checks every selected frontend job", () => {
  const needs = results(["docs/README.md"]);
  needs.changes.outputs.frontend = "true";
  for (const job of ["frontend-checks", "frontend-typecheck", "frontend-test"]) {
    needs[job] = { result: "success" };
  }
  assert.deepEqual(gateFailures(needs, "frontend"), []);
  needs["frontend-test"].result = "failure";
  assert.ok(gateFailures(needs, "frontend").length);
  needs.changes.outputs.frontend = "false";
  for (const job of ["frontend-checks", "frontend-typecheck", "frontend-test"]) {
    needs[job] = { result: "skipped" };
  }
  assert.deepEqual(gateFailures(needs, "frontend"), []);
});

test("git diff routing includes both sides of renames, deleted files, and unusual filenames", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dbx-ci-plan-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "CI Fixture");
    writeFileSync(path.join(directory, "old.rs"), "unchanged source\n");
    writeFileSync(path.join(directory, "deleted.rs"), "gone\n");
    git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture baseline");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.rs", "renamed\nfile.rs"); git("rm", "deleted.rs");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture change");
    assert.deepEqual(changedPaths(base, directory).toSorted(), ["old.rs", "deleted.rs", "renamed\nfile.rs"].toSorted());
    assert.equal(changedPaths("0".repeat(40), directory), null);
    assert.throws(() => changedPaths("not-a-ref", directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the final gate rejects absent routing outputs and skipped selected jobs", () => {
  const needs = results(["docs/README.md"]);
  needs.rust = needs.agents = { result: "success" };
  for (const [job, output] of Object.entries(routedJobs)) {
    needs[job] = { result: "skipped" };
    needs.changes.outputs[output] = "false";
  }
  assert.deepEqual(gateFailures(needs, "all"), []);
  needs["windows-standard-check"].result = "failure";
  assert.ok(gateFailures(needs, "all").length);
  needs["windows-standard-check"].result = "skipped";
  needs.changes.outputs.frontend = "true";
  assert.ok(gateFailures(needs, "all").length);
  needs.frontend.result = "success";
  assert.deepEqual(gateFailures(needs, "all"), []);
  delete needs.changes.outputs.nix;
  assert.ok(gateFailures(needs, "all").length);
});

test("the final gate requires both Windows jobs when the bundle routing is selected", () => {
  const needs = results(["docs/README.md"]);
  needs.rust = needs.agents = { result: "success" };
  for (const [job, output] of Object.entries(routedJobs)) {
    needs[job] = { result: "skipped" };
    needs.changes.outputs[output] = "false";
  }
  needs.changes.outputs.windows_win7_bundle = "true";
  needs.changes.outputs.windows_standard = "true";
  needs["windows-standard-check"].result = "success";
  needs["windows-win7-bundle"].result = "success";
  assert.deepEqual(gateFailures(needs, "all"), []);

  needs["windows-standard-check"].result = "skipped";
  assert.ok(gateFailures(needs, "all").length);
  needs["windows-standard-check"].result = "success";
  needs["windows-win7-bundle"].result = "skipped";
  assert.ok(gateFailures(needs, "all").length);
});

test("the final gate independently requires standard Windows compilation without Win7 packaging", () => {
  const needs = results(["crates/dbx-core/src/query/mod.rs"]);
  const selected = plan(["crates/dbx-core/src/query/mod.rs"]);
  needs.rust = needs.agents = { result: "success" };
  for (const [job, output] of Object.entries(routedJobs)) {
    needs.changes.outputs[output] = String(selected[output] ?? false);
    needs[job] = { result: selected[output] ? "success" : "skipped" };
  }
  assert.equal(needs.changes.outputs.windows_standard, "true");
  assert.equal(needs.changes.outputs.windows_win7_bundle, "false");
  assert.deepEqual(gateFailures(needs, "all"), []);
  for (const result of ["failure", "skipped", "cancelled"]) {
    needs["windows-standard-check"].result = result;
    assert.ok(gateFailures(needs, "all").some((failure) => failure.includes("windows-standard-check")));
  }
  needs["windows-standard-check"].result = "success";
  delete needs.changes.outputs.windows_standard;
  assert.ok(gateFailures(needs, "all").length);
});

test("coverage audit rejects lost features, omitted packages, and overlapping group selection", () => {
  const coverage = { workspace: Object.fromEntries(Object.keys(graph).map((name) => [name, ["fixture"]])),
    ...Object.fromEntries(Object.entries(rustGroups).map(([group, packages]) => [group, Object.fromEntries(packages.map((name) => [name, ["fixture"]]))])) };
  assertCoverage(coverage);
  const lost = structuredClone(coverage);
  lost.foundation["dbx-types"] = [];
  assert.throws(() => assertCoverage(lost), /lost workspace features/);
  const missing = structuredClone(coverage);
  delete missing.drivers["dbx-drivers"];
  assert.throws(() => assertCoverage(missing), /wrong packages/);
  const overlap = structuredClone(coverage);
  overlap.foundation["dbx-core"] = ["fixture"];
  assert.throws(() => assertCoverage(overlap), /wrong packages/);
  assert.deepEqual(parseCoverage("dbx-core v0.1.0 (/fixture)|default,openapi\n"), { "dbx-core": ["default", "openapi"] });
});
