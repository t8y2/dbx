import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/plugin-release-reusable.yml", import.meta.url), "utf8");
const cacheScript = workflow.match(/^          node <<'NODE'\n([\s\S]*?)^          NODE\n/m)[1].replace(/^ {10}/gm, "");

function workflowStep(action) {
  const start = workflow.indexOf(`      - uses: ${action}\n`);
  assert.notEqual(start, -1, `Missing workflow action ${action}`);
  const nextStep = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, nextStep === -1 ? workflow.indexOf("\n  publish:", start) : nextStep);
}

function resolveCache(files, directory = ".") {
  const root = mkdtempSync(join(tmpdir(), "dbx-plugin-release-cache-"));
  try {
    const project = join(root, directory);
    mkdirSync(project, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(project, name), typeof contents === "string" ? contents : JSON.stringify(contents));
    }
    const output = join(root, "outputs");
    const result = spawnSync(process.execPath, ["-e", cacheScript], {
      cwd: project,
      env: { ...process.env, PROJECT_DIRECTORY: directory, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("plugins without Node dependencies do not request a dependency cache", () => {
  assert.deepEqual(resolveCache({}), { manager: "", cache: "", "dependency-path": "", "pnpm-version": "" });
});

test("npm caches use the package lockfile", () => {
  assert.deepEqual(resolveCache({ "package.json": {}, "package-lock.json": {} }), {
    manager: "npm",
    cache: "npm",
    "dependency-path": "package-lock.json",
    "pnpm-version": "",
  });
});

test("npm shrinkwrap takes precedence over package-lock", () => {
  const result = resolveCache({ "npm-shrinkwrap.json": {}, "package-lock.json": {} });
  assert.equal(result["dependency-path"], "npm-shrinkwrap.json");
});

test("pnpm uses the packageManager version rather than overriding it", () => {
  assert.deepEqual(resolveCache({ "package.json": { packageManager: "pnpm@9.15.9" }, "pnpm-lock.yaml": "" }), {
    manager: "pnpm",
    cache: "pnpm",
    "dependency-path": "pnpm-lock.yaml",
    "pnpm-version": "",
  });
});

test("lockfile-only pnpm projects receive an explicit bootstrap version", () => {
  assert.equal(resolveCache({ "pnpm-lock.yaml": "" })["pnpm-version"], "10.27.0");
});

test("declared npm projects do not accidentally use a leftover pnpm lock", () => {
  const result = resolveCache({ "package.json": { packageManager: "npm@10.9.0" }, "package-lock.json": {}, "pnpm-lock.yaml": "" });
  assert.equal(result.cache, "npm");
  assert.equal(result["dependency-path"], "package-lock.json");
});

test("pnpm projects without a committed lockfile can bootstrap without requesting a cache", () => {
  const result = resolveCache({ "package.json": { packageManager: "pnpm@10.27.0" } });
  assert.equal(result.manager, "pnpm");
  assert.equal(result.cache, "");
  assert.equal(result["dependency-path"], "");
});

test("unsupported package managers do not select the npm or pnpm cache", () => {
  const result = resolveCache({ "package.json": { packageManager: "yarn@4.0.0" }, "package-lock.json": {} });
  assert.equal(result.cache, "");
});

test("cache lockfile paths remain relative to the repository for nested projects", () => {
  assert.equal(resolveCache({ "pnpm-lock.yaml": "" }, "plugins/example")["dependency-path"], "plugins/example/pnpm-lock.yaml");
});

test("pnpm setup precedes setup-node cache restoration and respects nested package.json", () => {
  const pnpmIndex = workflow.indexOf("uses: pnpm/action-setup@v4");
  const nodeIndex = workflow.indexOf("uses: actions/setup-node@v4");
  assert.ok(pnpmIndex > 0 && pnpmIndex < nodeIndex);
  const pnpmStep = workflowStep("pnpm/action-setup@v4");
  assert.ok(pnpmStep.includes("package_json_file: ${{ inputs.working-directory }}/package.json"));
  assert.ok(pnpmStep.includes("run_install: false"));
  assert.ok(workflowStep("actions/setup-node@v4").includes("cache: ${{ steps.node-cache.outputs.cache }}"));
});

test("Go cache includes backend go.sum and is disabled when no checksum file exists", () => {
  const goStep = workflowStep("actions/setup-go@v5");
  assert.ok(goStep.includes("cache-dependency-path: ${{ inputs.working-directory }}/**/go.sum"));
  assert.ok(goStep.includes("cache: ${{ hashFiles(format('{0}/**/go.sum', inputs.working-directory)) != '' }}"));
  assert.ok(goStep.includes("if: inputs.go-version != ''"));
});

test("source-built CLI still gets Rust when the plugin does not need it", () => {
  const rustStep = workflowStep("dtolnay/rust-toolchain@stable");
  assert.ok(rustStep.includes("if: inputs.rust-toolchain != '' || (inputs.install-plugin-cli && inputs.install-plugin-cli-from-source)"));
  assert.ok(rustStep.includes("toolchain: ${{ inputs.rust-toolchain || 'stable' }}"));
});

test("builds remain parallel and publishing still waits for every platform", () => {
  assert.match(workflow, /strategy:\n\s+fail-fast: false/);
  assert.doesNotMatch(workflow, /max-parallel:/);
  assert.match(workflow, /publish:\n\s+name: Publish plugin release assets\n\s+needs: build/);
});
