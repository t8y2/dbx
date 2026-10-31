#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2] || "";
const root = resolve(process.argv[3] || fileURLToPath(new URL("../..", import.meta.url)));
const match = /^v(\d+\.\d+\.\d+)(-beta\.\d{8}\.\d+)?$/.exec(tag);
if (!match) {
  console.error("Usage: set-release-version.mjs <vX.Y.Z[ -beta.YYYYMMDD.N]> [repository_root]");
  process.exit(1);
}

const version = `${match[1]}${match[2] || ""}`;
const jsonFiles = ["package.json", "src-tauri/tauri.conf.json"];
const cargoFiles = ["src-tauri/Cargo.toml", "crates/dbx-web/Cargo.toml"];

for (const relativePath of jsonFiles) {
  const path = resolve(root, relativePath);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

for (const relativePath of cargoFiles) {
  const path = resolve(root, relativePath);
  const source = readFileSync(path, "utf8");
  const pattern = /^(version\s*=\s*")[^"]+(")/m;
  if (!pattern.test(source)) throw new Error(`Package version declaration not found in ${relativePath}.`);
  const updated = source.replace(pattern, `$1${version}$2`);
  writeFileSync(path, updated);
}

const lockPath = resolve(root, "Cargo.lock");
const lockSource = readFileSync(lockPath, "utf8");
let lockUpdated = lockSource;
for (const packageName of ["dbx", "dbx-web"]) {
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = ")[^\\n"]+(")`);
  if (!pattern.test(lockUpdated)) throw new Error(`${packageName} package version was not found in Cargo.lock.`);
  lockUpdated = lockUpdated.replace(pattern, `$1${version}$2`);
}
writeFileSync(lockPath, lockUpdated);

for (const relativePath of [...jsonFiles, ...cargoFiles, "Cargo.lock"]) {
  if (!readFileSync(resolve(root, relativePath), "utf8").includes(version)) {
    throw new Error(`Release version ${version} was not written to ${relativePath}.`);
  }
}

console.log(`Prepared release version ${version}.`);
