import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { goAgents, integrationCases } from "./ci-config.mjs";
import { lockfileManifests } from "./ci-lockfiles.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const environmentKeys = ["CGO_ENABLED", "GOOS", "GOARCH", "GONOSUMDB", "DBX_ZOOKEEPER_TEST_CONNECT_STRING",
  "DBX_ZOOKEEPER_TEST_AUTH_SCHEME", "DBX_ZOOKEEPER_TEST_USERNAME", "DBX_ZOOKEEPER_TEST_PASSWORD", "TDENGINE_INTEGRATION",
  "TDENGINE_TEST_HOST", "TDENGINE_TEST_PORT", "CASSANDRA_TEST_HOST", "CASSANDRA_TEST_PORT", "RABBITMQ_INTEGRATION",
  "RABBITMQ_USERNAME", "RABBITMQ_PASSWORD"];

function withToolStubs(run, extraEnv = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "dbx-ci-execution-"));
  const binaries = path.join(directory, "bin");
  mkdirSync(binaries);
  const log = path.join(directory, "commands.jsonl");
  const stub = path.join(binaries, "stub.cjs");
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = Object.fromEntries(${JSON.stringify(environmentKeys)}.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
fs.appendFileSync(process.env.CI_STUB_LOG, JSON.stringify({tool,args,cwd:process.cwd(),env})+'\\n');
if (process.env.CI_STUB_FAIL === tool) process.exit(23);
if (tool === 'docker' && args.includes('taos')) console.log('| ready |');
`, { mode: 0o755 });
  for (const name of ["docker", "go", "cargo", "timeout", "curl", "sleep", "bash"]) symlinkSync(stub, path.join(binaries, name));
  try {
    const env = { ...process.env, ...extraEnv, TMPDIR: directory, CI_STUB_LOG: log, PATH: `${binaries}${path.delimiter}${process.env.PATH}` };
    return run(env, () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const agent of goAgents) {
  test(`Go job preserves ${agent.driver} tests and target builds without executing compilers`, () => withToolStubs((env, commands) => {
    const result = spawnSync("/bin/bash", [".github/scripts/ci-agent-go.sh", agent.driver, agent.binary, String(agent.race)], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const invocations = commands();
    assert.deepEqual(invocations[0].args, agent.race ? ["test", "-race", "./..."] : ["test", "./..."]);
    assert.ok(invocations.every((entry) => entry.cwd === path.join(root, "agents/drivers", agent.driver)));
    const builds = invocations.slice(1);
    assert.equal(builds.length, agent.driver === "zookeeper" ? 6 : 1);
    for (const build of builds) {
      assert.deepEqual(build.args.slice(0, 3), ["build", "-trimpath", "-ldflags=-s -w"]);
      assert.equal(build.env.CGO_ENABLED, "0");
    }
    if (agent.driver === "zookeeper") assert.deepEqual(builds.map((entry) => `${entry.env.GOOS}/${entry.env.GOARCH}`),
      ["darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64", "windows/arm64", "windows/amd64"]);
    else assert.ok(builds[0].args.includes(`/tmp/dbx-agent-${agent.binary}-linux-x64`));
    if (agent.driver === "xugu") assert.ok(invocations.every((entry) => entry.env.GONOSUMDB === "gitee.com/XuguDB/go-xugu-driver"));
  }));
}

for (const entry of integrationCases) {
  test(`live matrix retains ${entry.scenario}/${entry.version} commands without starting any container`, () => withToolStubs((env, commands) => {
    const result = spawnSync("/bin/bash", [".github/scripts/ci-agent-integration.sh", entry.scenario, entry.version, entry.image ?? ""], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const invocations = commands();
    if (entry.scenario === "rocketmq") {
      assert.ok(invocations.some((call) => call.tool === "bash" && call.args.at(-1) === entry.version));
      return;
    }
    const start = invocations.find((call) => call.tool === "docker" && call.args[0] === "run");
    assert.ok(start, "starts the selected container");
    const expectedImage = entry.image ?? (entry.scenario.startsWith("zookeeper") ? `zookeeper:${entry.version}`
      : entry.scenario === "rabbitmq" ? `rabbitmq:${entry.version}-management` : `cassandra:${entry.version}`);
    assert.equal(start.args.at(-1), expectedImage);
    const last = invocations.at(-1);
    assert.equal(last.tool, "docker");
    assert.deepEqual(last.args.slice(0, 2), ["rm", "-fv"]);
    const tests = invocations.filter((call) => ["go", "cargo"].includes(call.tool));
    assert.ok(tests.length);
    if (entry.scenario === "zookeeper") {
      assert.equal(tests.length, entry.version === "3.7.0" ? 2 : 1);
      assert.ok(tests[0].args.includes("^TestZooKeeperIntegration$"));
      if (entry.version === "3.7.0") assert.ok(tests[1].args.includes("^TestZooKeeperLargeChildrenIntegration$"));
    } else if (entry.scenario === "zookeeper-sasl") {
      assert.equal(tests[0].env.DBX_ZOOKEEPER_TEST_AUTH_SCHEME, "sasl_digest");
      assert.equal(tests[0].env.DBX_ZOOKEEPER_TEST_USERNAME, "dbx");
      assert.ok(start.args.some((arg) => arg.includes("sessionRequireClientSASLAuth=true")));
    } else if (entry.scenario === "tdengine") {
      assert.deepEqual(tests[0].args, ["nextest", "run", "--manifest-path", "drivers/tdengine/Cargo.toml", "--locked", "--test", "live", "--no-capture", "--no-fail-fast"]);
      assert.equal(tests[0].env.TDENGINE_INTEGRATION, "1");
      assert.equal(tests[0].env.TDENGINE_TEST_PORT, "6041");
    } else if (entry.scenario === "cassandra") assert.ok(tests[0].args.includes("^TestCassandraIntegration$"));
    else {
      assert.ok(tests[0].args.includes("^TestRabbitMQIntegration$"));
      assert.equal(tests[0].env.RABBITMQ_INTEGRATION, "1");
      assert.ok(start.args.includes("999:999"));
      assert.ok(start.args.includes("/var/lib/rabbitmq:rw,exec,uid=999,gid=999,mode=700"));
    }
  }));
}

test("failed live tests stay failed and still clean their container", () => withToolStubs((env, commands) => {
  const result = spawnSync("/bin/bash", [".github/scripts/ci-agent-integration.sh", "cassandra", "5.0.6"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 23);
  assert.deepEqual(commands().at(-1).args.slice(0, 2), ["rm", "-fv"]);
}, { CI_STUB_FAIL: "go" }));

test("failed nextest live tests propagate failure and still clean their container", () => withToolStubs((env, commands) => {
  const result = spawnSync("/bin/bash", [".github/scripts/ci-agent-integration.sh", "tdengine", "3.4.2.2"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 23);
  assert.deepEqual(commands().find((command) => command.tool === "cargo").args.slice(0, 2), ["nextest", "run"]);
  assert.deepEqual(commands().at(-1).args.slice(0, 2), ["rm", "-fv"]);
}, { CI_STUB_FAIL: "cargo" }));

test("lock preflight resolves full graphs, keeps --locked and propagates failures", () => {
  const plan = { rust: true, agent_rust: { include: [{ driver: "duckdb" }, { driver: "tdengine" }] } };
  assert.deepEqual(lockfileManifests(plan), ["Cargo.toml", "agents/drivers/duckdb/Cargo.toml", "agents/drivers/tdengine/Cargo.toml"]);
  assert.throws(() => lockfileManifests({ rust: false, agent_rust: { include: [{ driver: "../../unknown" }] } }));
  for (const failure of ["", "cargo"]) withToolStubs((env, commands) => {
    const result = spawnSync(process.execPath, [".github/scripts/ci-lockfiles.mjs"], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, failure ? 23 : 0, result.stderr);
    assert.equal(commands().length, failure ? 1 : 3);
    for (const command of commands()) {
      assert.equal(command.args[0], "metadata");
      assert.ok(command.args.includes("--locked"));
      assert.ok(!command.args.includes("--no-deps"));
    }
  }, { CI_PLAN: JSON.stringify(plan), CI_STUB_FAIL: failure });
});
