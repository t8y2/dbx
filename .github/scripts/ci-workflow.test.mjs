import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
function job(name) {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const pattern = /^  ([\w-]+):\s*$/gm;
  const definitions = [...jobs.matchAll(pattern)];
  const index = definitions.findIndex((match) => match[1] === name);
  assert.ok(index >= 0, `missing job ${name}`);
  return jobs.slice(definitions[index].index, definitions[index + 1]?.index ?? jobs.length);
}

test("fast checks run format and contracts before graph resolution or compilation", () => {
  const fast = job("fast-checks");
  for (const command of ["cargo fmt --check", "node --test scripts/core-architecture.test.mjs",
    "node scripts/sync-connection-types.mjs --check", "node .github/scripts/ci-lockfiles.mjs", "node .github/scripts/ci-rust-coverage.mjs"]) assert.ok(fast.includes(command));
  assert.ok(fast.indexOf("cargo fmt --check") < fast.indexOf("ci-lockfiles.mjs"));
  assert.doesNotMatch(fast, /cargo (?:test|build|clippy)/);
  assert.ok(fast.includes("needs.changes.outputs.rust_groups_known == 'true'"));
});

test("Agent and Rust matrices are bounded and do not cancel sibling failures", () => {
  for (const [name, output, parallel] of [["rust-test", "rust_matrix", 3], ["agent-rust", "agent_rust", 2],
    ["agent-go", "agent_go", 8], ["agent-integration", "agent_integration", 8]]) {
    const content = job(name);
    assert.match(content, /fail-fast: false/);
    assert.ok(content.includes(`max-parallel: ${parallel}`));
    assert.ok(content.includes(`fromJSON(needs.changes.outputs.${output})`));
    assert.match(content, /if: needs\.changes\.outputs\.[\w_]+ == 'true'/);
    if (name.startsWith("agent-")) assert.ok(content.includes("needs: [changes, fast-checks, agent-checks]"));
  }
});

test("stable Rust, Agent and overall gates always inspect selected upstream results", () => {
  for (const [name, mode, dependencies] of [["rust", "rust", ["fast-checks", "rust-fmt-clippy", "rust-test"]],
    ["agents", "agents", ["fast-checks", "agent-checks", "agent-rust", "agent-go", "agent-integration", "agent-java"]],
    ["ci", "all", ["rust", "agents", "frontend", "packages", "windows-win7-bundle", "duckdb-windows-driver", "nix-packaging"]]]) {
    const content = job(name);
    assert.match(content, /if: always\(\)/);
    assert.ok(content.includes(`node .github/scripts/ci-gate.mjs ${mode}`));
    assert.ok(content.includes("${{ toJSON(needs) }}"));
    for (const dependency of dependencies) assert.match(content, new RegExp(`^      - ${dependency}$`, "m"));
  }
});

test("every old Agent stage has an independent owner and Java packaging remains strict", () => {
  assert.ok(job("agent-checks").includes("python3 -m unittest discover"));
  assert.ok(job("agent-checks").includes("python3 scripts/validate_agents.py"));
  assert.ok(job("agent-checks").includes("bump-agent-versions.test.mjs"));
  assert.ok(job("agent-java").includes("./gradlew test shadowJar --continue"));
  assert.ok(job("agent-java").includes("python3 scripts/validate_agent_jars.py"));
  assert.ok(job("agent-rust").includes('cargo test --manifest-path "drivers/$DRIVER/Cargo.toml" --locked'));
  assert.ok(job("agent-rust").includes("cargo build --manifest-path drivers/tdengine/Cargo.toml --locked --release --bin dbx-tdengine-driver"));
  assert.ok(job("agent-go").includes("ci-agent-go.sh"));
  assert.ok(job("agent-integration").includes("ci-agent-integration.sh"));
  assert.ok(job("agent-integration").includes("Setup RocketMQ server Java"));
  assert.ok(job("agent-integration").includes("if: matrix.scenario == 'rocketmq'"));
  assert.ok(job("agent-integration").includes('java-version: "21"'));
  for (const name of ["agent-rust", "agent-go", "agent-integration", "agent-java"]) assert.doesNotMatch(job(name), /continue-on-error: true/);
});

test("the planner uses the exact event base and preserves a single workflow cancellation scope", () => {
  const changes = job("changes");
  assert.ok(changes.includes("github.event.pull_request.base.sha || github.event.before"));
  assert.ok(changes.includes("node .github/scripts/ci-plan.mjs"));
  for (const flag of ["rust", "rust_full", "rust_matrix", "agents", "agent_go", "agent_rust", "agent_integration", "plan"]) {
    assert.ok(changes.includes(`steps.plan.outputs.${flag}`));
  }
  assert.ok(workflow.includes("group: ${{ github.workflow }}-${{ github.ref }}"));
  assert.ok(workflow.includes("cancel-in-progress: true"));
});
