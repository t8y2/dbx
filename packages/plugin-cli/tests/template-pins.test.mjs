import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function filesUnder(relativeDirectory) {
  const root = join(repositoryRoot, relativeDirectory);
  const files = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push(relative(repositoryRoot, path));
  }
  return files;
}

test("the CLI crate version matches the published launcher version", () => {
  const cargoVersion = read("plugins/sdk/cli/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1];
  assert.equal(cargoVersion, version);
});

test("the copyable release workflow pins the released CLI tag", () => {
  const workflow = read("plugins/sdk/templates/github/plugin-release.yml");
  assert.match(workflow, new RegExp(`plugin-release-reusable\\.yml@plugin-cli-v${version.replaceAll(".", "\\.")}\\b`));
  assert.match(workflow, new RegExp(`plugin-cli-version: ${version.replaceAll(".", "\\.")}\\b`));
});

test("the reusable workflow defaults to the released CLI tag", () => {
  const workflow = read(".github/workflows/plugin-release-reusable.yml");
  assert.match(workflow, new RegExp(`default: plugin-cli-v${version.replaceAll(".", "\\.")}\\b`));
  assert.match(workflow, new RegExp(`default: "${version.replaceAll(".", "\\.")}"`));
});

test("no scaffolded artifact references a plugin-sdk-v1 ref", () => {
  const candidates = [
    ...filesUnder("plugins/sdk/cli/templates"),
    ...filesUnder("plugins/sdk/templates"),
    ".github/workflows/plugin-release-reusable.yml",
  ];
  for (const candidate of candidates) {
    assert.doesNotMatch(read(candidate), /plugin-sdk-v1/, `${candidate} references the removed plugin-sdk-v1 ref`);
  }
});
