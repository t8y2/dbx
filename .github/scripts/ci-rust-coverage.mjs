import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rustGroups } from "./ci-config.mjs";
import { rustCommand } from "./ci-rust.mjs";

export function parseCoverage(output) {
  return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
    const [name, features] = line.split("|");
    assert.ok(features !== undefined, `Invalid Cargo tree output: ${line}`);
    return [name.split(" ")[0], features.split(",").filter(Boolean)];
  }));
}

export function assertCoverage(coverage) {
  const names = Object.values(rustGroups).flat();
  assert.equal(new Set(names).size, names.length, "Rust test groups overlap");
  assert.deepEqual(names.toSorted(), Object.keys(coverage.workspace).toSorted(), "Rust test groups must cover every workspace package");
  for (const [group, packages] of Object.entries(rustGroups)) {
    assert.deepEqual(Object.keys(coverage[group]).toSorted(), packages.toSorted(), `${group} selected the wrong packages`);
    for (const name of packages) {
      const missing = coverage.workspace[name].filter((feature) => !coverage[group][name].includes(feature));
      assert.deepEqual(missing, [], `${group}/${name} lost workspace features`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const coverage = {};
  for (const group of ["workspace", ...Object.keys(rustGroups)]) {
    const args = rustCommand("tree", group, "fast");
    args.push("--depth", "0", "--prefix", "none", "--format", "{p}|{f}");
    coverage[group] = parseCoverage(execFileSync("cargo", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }));
  }
  assertCoverage(coverage);
  console.log(JSON.stringify(coverage, null, 2));
}
