#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformPackages = {
  "darwin-arm64": ["@dbx-app/plugin-cli-darwin-arm64", "dbx-plugin"],
  "darwin-x64": ["@dbx-app/plugin-cli-darwin-x64", "dbx-plugin"],
  "linux-arm64": ["@dbx-app/plugin-cli-linux-arm64-gnu", "dbx-plugin"],
  "linux-x64": ["@dbx-app/plugin-cli-linux-x64-gnu", "dbx-plugin"],
  "win32-arm64": ["@dbx-app/plugin-cli-win32-arm64", "dbx-plugin.exe"],
  "win32-x64": ["@dbx-app/plugin-cli-win32-x64", "dbx-plugin.exe"],
};

function platformTarget() {
  const platform = `${process.platform}-${process.arch}`;
  const target = platformPackages[platform];
  if (!target) {
    throw new Error(`DBX Plugin CLI does not provide a binary for ${platform}.`);
  }
  return target;
}

function resolveBinary() {
  if (process.env.DBX_PLUGIN_CLI_BINARY) {
    if (!existsSync(process.env.DBX_PLUGIN_CLI_BINARY)) {
      throw new Error(`DBX_PLUGIN_CLI_BINARY does not exist: ${process.env.DBX_PLUGIN_CLI_BINARY}`);
    }
    return process.env.DBX_PLUGIN_CLI_BINARY;
  }

  const [packageName, binaryName] = platformTarget();
  let manifest;
  try {
    manifest = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `The optional package ${packageName} was not installed. Reinstall @dbx-app/plugin-cli without --no-optional.`,
    );
  }

  const binary = join(dirname(manifest), "bin", binaryName);
  if (!existsSync(binary)) {
    throw new Error(`The DBX Plugin CLI binary is missing from ${packageName}.`);
  }
  return binary;
}

function bundledSdkRoot() {
  const sdkRoot = join(packageRoot, "sdk-root");
  const rustManifest = join(sdkRoot, "plugins", "sdk", "rust", "dbx-plugin-sdk", "Cargo.toml");
  const goManifest = join(sdkRoot, "plugins", "sdk", "go", "dbx-plugin-sdk", "go.mod");
  return existsSync(rustManifest) && existsSync(goManifest) ? sdkRoot : undefined;
}

try {
  if (process.argv[2] === "--verify-platform") {
    platformTarget();
    process.exit(0);
  }

  const binary = resolveBinary();
  const env = { ...process.env };
  delete env.DBX_PLUGIN_CLI_BINARY;
  if (!env.DBX_PLUGIN_SDK_ROOT) {
    const sdkRoot = bundledSdkRoot();
    if (sdkRoot) env.DBX_PLUGIN_SDK_ROOT = sdkRoot;
  }

  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", env });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
