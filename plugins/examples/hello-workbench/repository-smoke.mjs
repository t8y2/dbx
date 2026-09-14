import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(root, "..", "..", "..");
const target = platformTarget();
const temporary = await mkdtemp(path.join(os.tmpdir(), "dbx-plugin-repository-smoke-"));
const candidateDirectory = path.join(temporary, "candidates");
const candidate = path.join(candidateDirectory, `dbx.example.hello-1.0.0-${target}.dbxp`);
const keyFile = path.join(temporary, "repository-key.env");
const signed = path.join(temporary, `dbx.example.hello-1.0.0-${target}.signed.dbxp`);

try {
  run(process.execPath, [path.join(root, "package.mjs")], { DBX_PLUGIN_OUTPUT_DIR: candidateDirectory });
  run(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      path.join(repositoryRoot, "plugins", "sdk", "cli", "Cargo.toml"),
      "--",
      "keygen",
      "example-repository-smoke",
      "--output",
      keyFile,
    ],
    { CARGO_TARGET_DIR: path.join(temporary, "cli-target") },
  );
  const signingEnvironment = await readEnvironmentFile(keyFile);
  run(process.execPath, [path.join(root, "repository-sign.mjs"), candidate, signed], {
    ...signingEnvironment,
    DBX_PLUGIN_TARGET: target,
    DBX_PLUGIN_SKIP_EXAMPLE_CATALOG: "1",
  });
  run(process.execPath, [path.join(root, "smoke.mjs"), signed], {
    CARGO_TARGET_DIR: path.join(temporary, "core-target"),
    DBX_PLUGIN_SMOKE_TRUSTED_KEYS_JSON: JSON.stringify({
      [signingEnvironment.DBX_PLUGIN_SIGNING_KEY_ID]: signingEnvironment.DBX_PLUGIN_SIGNING_PUBLIC_KEY,
    }),
  });
  console.log("Repository signing smoke passed: candidate -> repository signature -> trusted install -> lifecycle -> uninstall");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function readEnvironmentFile(file) {
  const environment = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const match = /^export ([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) environment[match[1]] = match[2];
  }
  for (const name of ["DBX_PLUGIN_SIGNING_KEY", "DBX_PLUGIN_SIGNING_KEY_ID", "DBX_PLUGIN_SIGNING_PUBLIC_KEY"]) {
    if (!environment[name]) throw new Error(`Generated repository key file is missing ${name}`);
  }
  return environment;
}

function platformTarget() {
  const osName = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const architecture = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!osName || !architecture) throw new Error(`Unsupported plugin target: ${process.platform}-${process.arch}`);
  return `${osName}-${architecture}`;
}
