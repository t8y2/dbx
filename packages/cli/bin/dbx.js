#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platformPackages = {
  "darwin-arm64": "@dbx-app/cli-darwin-arm64",
  "darwin-x64": "@dbx-app/cli-darwin-x64",
  "linux-arm64": "@dbx-app/cli-linux-arm64-gnu",
  "linux-x64": "@dbx-app/cli-linux-x64-gnu",
  "win32-arm64": "@dbx-app/cli-win32-arm64",
  "win32-x64": "@dbx-app/cli-win32-x64",
};

const platformKey = `${process.platform}-${process.arch}`;
const packageName = platformPackages[platformKey];
if (!packageName) {
  console.error(`Unsupported platform: ${platformKey}`);
  process.exit(1);
}

let binary;
try {
  const packageJson = require.resolve(`${packageName}/package.json`);
  binary = join(dirname(packageJson), "bin", process.platform === "win32" ? "dbx.exe" : "dbx");
} catch {
  console.error(`The optional package ${packageName} was not installed. Reinstall @dbx-app/cli without --no-optional.`);
  process.exit(1);
}

if (!existsSync(binary)) {
  console.error(`DBX CLI binary was not found at ${binary}`);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", env: process.env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
