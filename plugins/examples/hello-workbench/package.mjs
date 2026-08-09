import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DBX_PLUGIN_OUTPUT_DIR ? path.resolve(process.env.DBX_PLUGIN_OUTPUT_DIR) : path.join(root, "dist");
const buildRoot = await mkdtemp(path.join(os.tmpdir(), "dbx-hello-package-"));
const stage = path.join(buildRoot, "stage");
const detectedTarget = platformTarget();
const target = process.env.DBX_PLUGIN_TARGET || detectedTarget;
if (target !== detectedTarget) throw new Error(`DBX_PLUGIN_TARGET ${target} does not match native build host ${detectedTarget}`);
const executableName = process.platform === "win32" ? "dbx-example-hello.exe" : "dbx-example-hello";
const backendTarget = path.join(buildRoot, "backend-target");
const packagerTarget = path.join(buildRoot, "packager-target");
const output = path.join(dist, `dbx.example.hello-1.0.0-${target}.dbxp`);
const artifactMetadata = output.replace(/\.dbxp$/, ".artifact.json");

if (process.env.DBX_PLUGIN_SIGNING_KEY || process.env.DBX_PLUGIN_SIGNING_KEY_ID) {
  throw new Error("package.mjs only builds unsigned review candidates; use repository-sign.mjs after review");
}

try {
  await mkdir(path.join(stage, "bin", target), { recursive: true });
  await mkdir(dist, { recursive: true });
  run("cargo", ["build", "--locked", "--release", "--manifest-path", path.join(root, "backend", "Cargo.toml")], { CARGO_TARGET_DIR: backendTarget });
  await cp(path.join(backendTarget, "release", executableName), path.join(stage, "bin", target, executableName));
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.entrypoints.backend = { executable: `bin/${target}/${executableName}` };
  await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(path.join(root, "assets"), path.join(stage, "assets"), { recursive: true });
  await cp(path.join(root, "ui"), path.join(stage, "ui"), { recursive: true });

  const packagerArgs = [
    "run",
    "--locked",
    "--release",
    "--manifest-path",
    path.join(root, "..", "..", "sdk", "packager", "Cargo.toml"),
    "--",
    stage,
    output,
    "--artifact-metadata",
    artifactMetadata,
    "--target",
    target,
    "--artifact-url",
    path.basename(output),
  ];
  run("cargo", packagerArgs, { CARGO_TARGET_DIR: packagerTarget });
  console.log(`Built unsigned candidate ${output}`);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function platformTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!os || !arch) throw new Error(`Unsupported plugin target: ${process.platform}-${process.arch}`);
  return `${os}-${arch}`;
}
