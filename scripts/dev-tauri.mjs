import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSigningIdentity, signDevelopmentBinary } from "./macos-dev-signing.mjs";

const entryPath = fileURLToPath(import.meta.url);

export function developmentArgs(args, platform = process.platform, executable = process.execPath, runner = entryPath) {
  if (platform !== "darwin") return ["dev", ...args];
  const separator = args.indexOf("--");
  const tauriArgs = separator < 0 ? args : args.slice(0, separator);
  const cargoArgs = separator < 0 ? [] : args.slice(separator + 1);
  const binarySeparator = cargoArgs.indexOf("--");
  const buildArgs = binarySeparator < 0 ? cargoArgs : cargoArgs.slice(0, binarySeparator);
  const binaryArgs = binarySeparator < 0 ? [] : cargoArgs.slice(binarySeparator);
  if ([...tauriArgs, ...buildArgs].includes("--release")) throw new Error("Use tauri build for release builds; the development signer must not sign release artifacts.");
  if (tauriArgs.some((arg) => arg === "-r" || arg === "--runner" || arg.startsWith("--runner="))) throw new Error("Custom Tauri runners bypass development signing; use the default Cargo runner.");
  const runnerValue = JSON.stringify([executable, runner, "--run-signed"]);
  const configs = ["aarch64-apple-darwin", "x86_64-apple-darwin"].flatMap((target) => ["--config", `target.${target}.runner=${runnerValue}`]);
  return ["dev", ...tauriArgs, "--", ...buildArgs, ...configs, ...binaryArgs];
}

function run(executable, args) {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === "--run-signed") {
    if (process.platform !== "darwin" || !args[1]) throw new Error("The signing runner requires a macOS development executable.");
    const binary = realpathSync.native(args[1]);
    if (path.basename(binary) !== "dbx" || path.basename(path.dirname(binary)) !== "debug") {
      throw new Error("The development signing runner only accepts a debug/dbx executable.");
    }
    signDevelopmentBinary(binary);
    run(binary, args.slice(2));
    return;
  }
  const tauriArgs = developmentArgs(args);
  if (process.platform === "darwin" && !args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg))) {
    for (const target of ["AARCH64_APPLE_DARWIN", "X86_64_APPLE_DARWIN"]) {
      if (process.env[`CARGO_TARGET_${target}_RUNNER`]) throw new Error(`Unset CARGO_TARGET_${target}_RUNNER before using the DBX development signing runner.`);
    }
    ensureSigningIdentity();
  }
  const tauri = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  run(process.execPath, [tauri, ...tauriArgs]);
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(entryPath)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
