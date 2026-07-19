#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platformPackages = {
  "darwin-arm64": ["@dbx-app/mcp-darwin-arm64", "dbx-mcp"],
  "darwin-x64": ["@dbx-app/mcp-darwin-x64", "dbx-mcp"],
  "linux-arm64": ["@dbx-app/mcp-linux-arm64-gnu", "dbx-mcp"],
  "linux-x64": ["@dbx-app/mcp-linux-x64-gnu", "dbx-mcp"],
  "win32-arm64": ["@dbx-app/mcp-win32-arm64", "dbx-mcp.exe"],
  "win32-x64": ["@dbx-app/mcp-win32-x64", "dbx-mcp.exe"],
};

function resolveBinary() {
  if (process.env.DBX_MCP_BINARY) {
    return process.env.DBX_MCP_BINARY;
  }
  const platform = `${process.platform}-${process.arch}`;
  const target = platformPackages[platform];
  if (!target) {
    throw new Error(`DBX MCP does not provide a Rust binary for ${platform}.`);
  }
  const [packageName, binaryName] = target;
  let manifest;
  try {
    manifest = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `The optional package ${packageName} was not installed. Reinstall @dbx-app/mcp-server without --no-optional.`,
    );
  }
  const binary = join(dirname(manifest), "bin", binaryName);
  if (!existsSync(binary)) {
    throw new Error(`The DBX MCP binary is missing from ${packageName}.`);
  }
  return binary;
}

try {
  if (process.argv[2] === "--verify-platform") {
    const platform = `${process.platform}-${process.arch}`;
    if (!platformPackages[platform]) {
      throw new Error(`DBX MCP does not provide a Rust binary for ${platform}.`);
    }
    process.exit(0);
  }
  const binary = resolveBinary();
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`Failed to start DBX MCP: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
