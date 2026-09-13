import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const packagePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist", `dbx.example.hello-1.0.0-${platformTarget()}.dbxp`);
const ownedBuildRoot = process.env.CARGO_TARGET_DIR ? null : await mkdtemp(path.join(os.tmpdir(), "dbx-plugin-smoke-"));
const cargoTarget = process.env.CARGO_TARGET_DIR || path.join(ownedBuildRoot, "cargo-target");

try {
  if (!process.argv[2]) run(process.execPath, [path.join(root, "package.mjs")]);
  run("cargo", ["run", "--locked", "-p", "dbx-core", "--no-default-features", "--example", "plugin_package_smoke", "--", packagePath], {
    CARGO_TARGET_DIR: cargoTarget,
  });
} finally {
  if (ownedBuildRoot) await rm(ownedBuildRoot, { recursive: true, force: true });
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function platformTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!os || !arch) throw new Error(`Unsupported plugin target: ${process.platform}-${process.arch}`);
  return `${os}-${arch}`;
}
