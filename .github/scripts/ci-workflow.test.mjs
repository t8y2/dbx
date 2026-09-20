import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
function job(name, content = workflow) {
  const jobs = content.slice(content.indexOf("\njobs:\n") + 7);
  const pattern = /^  ([\w-]+):\s*$/gm;
  const definitions = [...jobs.matchAll(pattern)];
  const index = definitions.findIndex((match) => match[1] === name);
  assert.ok(index >= 0, `missing job ${name}`);
  return jobs.slice(definitions[index].index, definitions[index + 1]?.index ?? jobs.length);
}

test("fast checks run format and contracts before graph resolution or compilation", () => {
  const fast = job("fast-checks");
  for (const command of ["cargo fmt --check", "node --test scripts/core-architecture.test.mjs", "node scripts/sync-connection-types.mjs --check", "node .github/scripts/ci-lockfiles.mjs", "node .github/scripts/ci-rust-coverage.mjs"]) assert.ok(fast.includes(command));
  assert.ok(fast.indexOf("cargo fmt --check") < fast.indexOf("ci-lockfiles.mjs"));
  assert.doesNotMatch(fast, /cargo (?:test|build|clippy)/);
  assert.ok(fast.includes("needs.changes.outputs.rust_groups_known == 'true'"));
});

test("Agent and Rust matrices are bounded and do not cancel sibling failures", () => {
  for (const [name, output, parallel] of [
    ["rust-test", "rust_matrix", 3],
    ["agent-rust", "agent_rust", 2],
    ["agent-go", "agent_go", 8],
    ["agent-integration", "agent_integration", 8],
  ]) {
    const content = job(name);
    assert.match(content, /fail-fast: false/);
    assert.ok(content.includes(`max-parallel: ${parallel}`));
    assert.ok(content.includes(`fromJSON(needs.changes.outputs.${output})`));
    assert.match(content, /if: needs\.changes\.outputs\.[\w_]+ == 'true'/);
    if (name.startsWith("agent-")) assert.ok(content.includes("needs: [changes, fast-checks, agent-checks]"));
  }
});

test("stable Rust, Agent and overall gates always inspect selected upstream results", () => {
  for (const [name, mode, dependencies] of [
    ["rust", "rust", ["fast-checks", "rust-fmt-clippy", "rust-test"]],
    ["agents", "agents", ["fast-checks", "agent-checks", "agent-rust", "agent-go", "agent-integration", "agent-java"]],
    ["frontend", "frontend", ["frontend-checks", "frontend-typecheck", "frontend-test"]],
    ["ci", "all", ["rust", "agents", "frontend", "packages", "windows-standard-check", "windows-win7-bundle", "duckdb-windows-driver", "nix-packaging"]],
  ]) {
    const content = job(name);
    assert.match(content, /if: always\(\)/);
    assert.ok(content.includes(`node .github/scripts/ci-gate.mjs ${mode}`));
    assert.ok(content.includes("${{ toJSON(needs) }}"));
    for (const dependency of dependencies) assert.match(content, new RegExp(`^      - ${dependency}$`, "m"));
  }
});

test("frontend tests use two shards on separate runners", () => {
  const content = job("frontend-test");
  assert.match(content, /fail-fast: false/);
  assert.match(content, /shard: \[1, 2\]/);
  assert.ok(content.includes("--shard=${{ matrix.shard }}/2"));
  assert.ok(content.includes("--reporter=github-actions"));
  assert.ok(content.includes("ci-vitest-file-timing-reporter.mjs"));
  assert.doesNotMatch(job("frontend-typecheck"), /vitest|oxfmt|oxlint/);
});

test("every old Agent stage has an independent owner and Java packaging remains strict", () => {
  assert.ok(job("agent-checks").includes("python3 -m unittest discover"));
  assert.ok(job("agent-checks").includes("python3 scripts/validate_agents.py"));
  assert.ok(job("agent-checks").includes("bump-agent-versions.test.mjs"));
  assert.ok(job("agent-java").includes("./gradlew test shadowJar --continue"));
  assert.ok(job("agent-java").includes("python3 scripts/validate_agent_jars.py"));
  assert.ok(job("agent-rust").includes('cargo nextest run --manifest-path "drivers/$DRIVER/Cargo.toml" --locked --no-fail-fast'));
  assert.ok(job("agent-rust").includes('cargo test --doc --manifest-path "drivers/$DRIVER/Cargo.toml" --locked'));
  assert.ok(job("agent-rust").includes("cargo build --manifest-path drivers/tdengine/Cargo.toml --locked --release --bin dbx-tdengine-driver"));
  assert.ok(job("agent-go").includes("ci-agent-go.sh"));
  assert.ok(job("agent-integration").includes("ci-agent-integration.sh"));
  assert.ok(job("agent-integration").includes("Setup RocketMQ server Java"));
  assert.ok(job("agent-integration").includes("if: matrix.scenario == 'rocketmq'"));
  assert.ok(job("agent-integration").includes('java-version: "21"'));
  for (const name of ["agent-rust", "agent-go", "agent-integration", "agent-java"]) assert.doesNotMatch(job(name), /continue-on-error: true/);
});

test("native Rust driver caches exclude failed build artifacts", () => {
  const content = job("agent-rust");
  assert.ok(content.includes("shared-key: ci-agent-rust-v2-${{ matrix.driver }}"));
  assert.ok(content.includes("cache-on-failure: false"));
});

test("Rust test jobs install pinned nextest and retain separate doctests", () => {
  const pluginDevHost = readFileSync(new URL("../workflows/plugin-dev-host.yml", import.meta.url), "utf8");
  const pluginRelease = readFileSync(new URL("../workflows/plugin-cli-release.yml", import.meta.url), "utf8");
  const consumers = [job("packages"), job("rust-test"), job("agent-rust"), job("agent-integration"), job("test", pluginDevHost), job("prepare", pluginRelease)];
  for (const content of consumers) {
    assert.ok(content.includes("uses: taiki-e/install-action@9114bf4d891761788c546334fd37538eae1bf8b3"));
    assert.ok(content.includes("tool: cargo-nextest@0.9.137"));
    assert.doesNotMatch(content, /cargo test (?!.*--doc)/);
    const testCommand = content.indexOf("cargo nextest run") >= 0 ? "cargo nextest run" : content.includes("pnpm test:packages") ? "pnpm test:packages" : content.includes("ci-rust.mjs test") ? "ci-rust.mjs test" : "ci-agent-integration.sh";
    assert.ok(content.indexOf("tool: cargo-nextest@0.9.137") < content.indexOf(testCommand));
  }
  assert.ok(job("rust-test").includes('ci-rust.mjs doctest "$RUST_TEST_GROUP" "$RUST_FEATURE_MODE"'));
  for (const content of [job("test", pluginDevHost), job("prepare", pluginRelease)]) {
    assert.ok(content.includes("cargo nextest run --locked --manifest-path plugins/sdk/cli/Cargo.toml --no-fail-fast"));
    assert.ok(content.includes("cargo test --doc --locked --manifest-path plugins/sdk/cli/Cargo.toml"));
  }
  assert.match(job("agent-integration"), /name: Install nextest\s+if: matrix\.driver == 'tdengine'/);
});

test("local Rust entrypoints and live TDengine tests use nextest", () => {
  const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");
  assert.ok(makefile.includes("RUST_MIN_STACK=8388608 cargo nextest run --no-default-features --features sqlite-bundled --no-fail-fast"));
  assert.ok(makefile.includes("RUST_MIN_STACK=8388608 cargo test --doc --no-default-features --features sqlite-bundled"));
  const cli = JSON.parse(readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"));
  assert.equal(cli.scripts.test, "cargo nextest run -p dbx-cli --no-default-features --no-fail-fast");
  const integration = readFileSync(new URL("./ci-agent-integration.sh", import.meta.url), "utf8");
  assert.ok(integration.includes("cargo nextest run --manifest-path drivers/tdengine/Cargo.toml --locked --test live --no-capture --no-fail-fast"));
  assert.doesNotMatch(integration, /cargo test/);
});

test("DuckDB Windows builds persist Rust and C++ compiler results", () => {
  const content = job("duckdb-windows-driver");
  assert.ok(content.includes('SCCACHE_GHA_ENABLED: "true"'));
  assert.ok(content.includes('CC: "sccache cl.exe"'));
  assert.ok(content.includes('CXX: "sccache cl.exe"'));
  assert.ok(content.includes("0b201ec74fa43914dc39ae48a89fd1d8cb592756"));
  assert.ok(content.includes("fc920bf0ec8de6ee65d409111f7ec508035751ba"));
  assert.ok(content.includes('version: "v0.16.0"'));
});

test("Windows compatibility jobs cache Rust compilation without wrapping C or C++", () => {
  assert.ok(job("changes").includes("'vendor/webview2-com-sys/**'"));
  const standard = job("windows-standard-check");
  assert.ok(standard.includes("needs.changes.outputs.windows_win7_bundle == 'true'"));
  assert.ok(standard.includes("RUSTC_WRAPPER: sccache"));
  assert.ok(standard.includes('SCCACHE_GHA_ENABLED: "true"'));
  assert.ok(standard.includes("SCCACHE_GHA_VERSION: windows-standard-v1"));
  assert.ok(standard.includes("fc920bf0ec8de6ee65d409111f7ec508035751ba"));
  assert.ok(standard.includes('version: "v0.16.0"'));
  assert.ok(standard.includes("cargo check --locked --package dbx --no-default-features --target x86_64-pc-windows-msvc"));
  assert.ok(standard.includes("sccache --show-stats"));

  const win7 = job("windows-win7-bundle");
  assert.doesNotMatch(win7, /x86_64-pc-windows-msvc|Setup Rust for standard Windows/);
  for (const setting of ["RUSTC_WRAPPER: sccache", 'SCCACHE_GHA_ENABLED: "true"', "SCCACHE_GHA_VERSION: win7-webview2-1.0.902.49-v1", 'SCCACHE_IDLE_TIMEOUT: "0"', 'CARGO_PROFILE_RELEASE_LTO: "off"', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "8"']) assert.ok(win7.includes(setting));
  assert.ok(win7.includes("fc920bf0ec8de6ee65d409111f7ec508035751ba"));
  assert.ok(win7.includes('version: "v0.16.0"'));
  assert.ok(win7.includes("--timings"));
  assert.ok(win7.includes("name: DBX-win7-cargo-timings"));
  assert.ok(win7.includes("path: target/cargo-timings/"));
  assert.doesNotMatch(win7, /^\s+(?:CC|CXX):/m);
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
