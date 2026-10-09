import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    // A superseded run must not leave a failing gate behind: when the workflow is
    // cancelled the selected upstream jobs are cancelled too, and `always()` alone
    // would still run the gate and report those cancellations as failures.
    assert.match(content, /if: always\(\) && !cancelled\(\)/);
    assert.ok(content.includes(`node .github/scripts/ci-gate.mjs ${mode}`));
    assert.ok(content.includes("${{ toJSON(needs) }}"));
    assert.ok(content.includes("uses: actions/checkout@v7"));
    assert.doesNotMatch(content, /actions\/setup-node|name: Setup Node\.js/);
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

test("shared Rust caches publish only complete builds outside the old cache namespace", () => {
  for (const name of ["packages", "rust-fmt-clippy", "rust-test", "agent-rust", "agent-integration"]) {
    const content = job(name);
    assert.ok(content.includes("prefix-key: v1-rust-complete"), name);
    assert.ok(content.includes("cache-on-failure: false"), name);
    assert.doesNotMatch(content, /cache-on-failure: true/);
    assert.ok(content.includes("save-if: ${{ github.ref == 'refs/heads/main'"), name);
  }
});

test("main and fork Rust jobs use the same rust-cache fingerprint", () => {
  const stableCacheEnvironment = /- name: Rust cache\s+env:\s+RUST_FEATURE_MODE: ""\s+RUST_TEST_GROUP: ""\s+uses: swatinem\/rust-cache@v2/;
  for (const name of ["packages", "rust-fmt-clippy", "rust-test", "agent-rust"]) {
    const content = job(name);
    assert.match(content, stableCacheEnvironment);
    assert.match(content, /^      RUSTC_WRAPPER: sccache$/m);
    assert.ok(content.includes('version: "v0.16.0"'));
    assert.doesNotMatch(content, /RUSTC_WRAPPER: ""|CC: ""|CXX: ""/);
  }
});

test("S3 and secretless Rust jobs export identical compiler wrappers", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "dbx-ci-sccache-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const compiler = "/opt/hostedtoolcache/sccache/0.16.0/x64/sccache";
  const backend = {
    SCCACHE_BUCKET: "test-bucket",
    SCCACHE_ENDPOINT: "https://cache.example.test",
    SCCACHE_REGION: "test-region",
    SCCACHE_S3_KEY_PREFIX: "test-prefix",
    SCCACHE_S3_USE_SSL: "true",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
  };
  for (const name of ["packages", "rust-fmt-clippy", "rust-test", "agent-rust"]) {
    const setup = job(name).match(/- name: Configure sccache\n([\s\S]*?)(?=\n      - name: Rust cache)/)?.[1];
    assert.ok(setup, name);
    assert.doesNotMatch(setup, /^\s+if:/m);
    const script = setup.match(/        run: \|\n([\s\S]*)/)[1].split("\n").map((line) => line.slice(10)).join("\n");
    for (const remote of [true, false]) {
      const output = path.join(directory, `${name}-${remote}.env`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_ENV: output,
          SCCACHE_PATH: compiler,
          CACHE_BUCKET: remote ? backend.SCCACHE_BUCKET : "",
          CACHE_ENDPOINT: remote ? backend.SCCACHE_ENDPOINT : "",
          CACHE_REGION: remote ? backend.SCCACHE_REGION : "",
          CACHE_KEY_PREFIX: remote ? backend.SCCACHE_S3_KEY_PREFIX : "",
          CACHE_ACCESS_KEY_ID: remote ? backend.AWS_ACCESS_KEY_ID : "",
          CACHE_SECRET_ACCESS_KEY: remote ? backend.AWS_SECRET_ACCESS_KEY : "",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      const exported = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      assert.deepEqual(exported, {
        ...(remote ? backend : {}),
        SCCACHE_IDLE_TIMEOUT: "0",
        CC: `${compiler} cc`,
        CXX: `${compiler} c++`,
      }, `${name}: ${remote ? "S3" : "local"}`);
    }
  }
});

test("Rust build timings remain available after failures without waiting for cancelled runs", () => {
  for (const [name, artifact, location] of [
    ["rust-fmt-clippy", "DBX-clippy-cargo-timings", "target/cargo-timings/"],
    ["rust-test", "DBX-rust-${{ matrix.group }}-cargo-timings", "target/cargo-timings/"],
    ["agent-rust", "DBX-agent-${{ matrix.driver }}-cargo-timings", "agents/drivers/${{ matrix.driver }}/target/cargo-timings/"],
  ]) {
    const content = job(name);
    assert.match(content, /name: Upload Rust Cargo timings\s+if: always\(\) && !cancelled\(\)\s+uses: actions\/upload-artifact@v6/);
    assert.ok(content.includes(`name: ${artifact}`));
    assert.ok(content.includes(`path: ${location}`));
    assert.ok(content.includes("retention-days: 3"));
    assert.ok(content.includes("if-no-files-found: ignore"));
  }
  assert.ok(job("agent-rust").includes('--manifest-path "drivers/$DRIVER/Cargo.toml" --locked --no-fail-fast --timings'));
});

test("Linux Rust dependency installs bound apt mirror stalls", () => {
  for (const name of ["packages", "rust-fmt-clippy", "rust-test", "agent-rust"]) {
    const content = job(name);
    assert.equal((content.match(/sudo timeout --kill-after=30s 10m apt-get/g) ?? []).length, 2);
    for (const option of ["Acquire::Retries=3", "Acquire::http::Timeout=30", "Acquire::https::Timeout=30"]) {
      assert.ok(content.includes(option));
    }
  }
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
  assert.ok(win7.includes("sccache --show-stats"));
  for (const flag of ["-Z host-config", "-Z target-applies-to-host", "-Z build-std=std,panic_abort"]) assert.ok(win7.includes(flag));
  assert.ok(win7.includes("--config .github/fixtures/win7-host-repro-config.toml"));
  const hostConfig = readFileSync(new URL("../fixtures/win7-host-repro-config.toml", import.meta.url), "utf8");
  assert.ok(hostConfig.includes("target-applies-to-host = false"));
  assert.ok(hostConfig.includes('[host.x86_64-pc-windows-msvc]'));
  assert.ok(hostConfig.includes('rustflags = ["-Clink-arg=/Brepro"]'));
  assert.ok(win7.includes("--timings"));
  assert.ok(win7.includes("name: DBX-win7-cargo-timings"));
  assert.ok(win7.includes("path: target/cargo-timings/"));
  assert.ok(win7.includes("name: Measure dbx library command registry expansion"));
  assert.ok(win7.includes("if: vars.WIN7_REGISTRY_AB == 'true'"));
  assert.ok(win7.includes("--package dbx"));
  assert.ok(win7.includes("--lib"));
  assert.ok(win7.includes('$env:RUSTC_WRAPPER = ""'));
  assert.ok(win7.includes('Measure-Registry "full" $fullCommandCount'));
  assert.ok(win7.includes('Measure-Registry "half" $keptCommandCount'));
  assert.ok(win7.includes('"-Zdump-mono-stats=$outputDir"'));
  assert.ok(win7.includes('"-Zdump-mono-stats-format=json"'));
  assert.ok(win7.includes("git restore --source=HEAD -- $sourcePath"));
  assert.ok(win7.includes("name: DBX-win7-dbx-lib-command-registry-ab"));
  assert.ok(win7.includes("if: always() && vars.WIN7_REGISTRY_AB == 'true'"));
  assert.ok(win7.includes("path: ${{ runner.temp }}/dbx-lib-command-registry-ab/"));
  assert.ok(win7.includes("retention-days: 3"));
  assert.ok(win7.indexOf("name: Build DBX for Windows 7") < win7.indexOf("name: Measure dbx library command registry expansion"));
  assert.ok(win7.indexOf("name: Measure dbx library command registry expansion") < win7.indexOf("name: Upload dbx library command registry A/B"));
  assert.doesNotMatch(win7, /^\s+(?:CC|CXX):/m);
});

test("Win7 TLS cache keys ignore the workspace lockfile", () => {
  const win7 = job("windows-win7-bundle");
  assert.ok(win7.includes("hashFiles('.github/fixtures/win7-aws-lc-cache/Cargo.toml', '.github/fixtures/win7-aws-lc-cache/Cargo.lock')"));
  assert.ok(win7.includes("hashFiles('.github/fixtures/win7-openssl-cache/Cargo.toml', '.github/fixtures/win7-openssl-cache/Cargo.lock')"));
  assert.doesNotMatch(win7, /key: win7-(?:aws-lc|openssl).*hashFiles\('Cargo\.lock'/);
});

test("the planner uses the exact event base and preserves a single workflow cancellation scope", () => {
  const changes = job("changes");
  assert.ok(changes.includes("github.event.pull_request.base.sha || github.event.before"));
  assert.ok(changes.includes('git fetch --no-tags --depth=1 origin "$BASE_SHA"'));
  assert.ok(changes.includes("base: ${{ steps.change-base.outputs.sha }}"));
  assert.ok(changes.includes("BASE_SHA: ${{ steps.change-base.outputs.sha }}"));
  assert.ok(changes.includes("node .github/scripts/ci-plan.mjs"));
  assert.doesNotMatch(changes, /fetch-depth:\s*0/);
  assert.doesNotMatch(changes, /dtolnay\/rust-toolchain/);
  for (const flag of ["rust", "rust_full", "rust_matrix", "agents", "agent_go", "agent_rust", "agent_integration",
    "windows_win7_candidate", "windows_win7_affected_packages", "windows_win7_reasons", "plan"]) {
    assert.ok(changes.includes(`steps.plan.outputs.${flag}`));
  }
  assert.ok(changes.includes("WIN7_CURRENT: ${{ steps.filter.outputs.windows_win7_bundle }}"));
  assert.ok(workflow.includes("group: ${{ github.workflow }}-${{ github.ref }}"));
  assert.ok(workflow.includes("cancel-in-progress: true"));
});
