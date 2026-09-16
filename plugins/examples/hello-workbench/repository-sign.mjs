import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.DBX_PLUGIN_TARGET || platformTarget();
const candidate = path.resolve(process.argv[2] || path.join(root, "dist", `dbx.example.hello-1.0.0-${target}.dbxp`));
const signed = path.resolve(
  process.argv[3] || path.join(root, "dist", `dbx.example.hello-1.0.0-${target}.signed.dbxp`),
);
const metadata = signed.replace(/\.dbxp$/, ".artifact.json");
const keyId = process.env.DBX_PLUGIN_SIGNING_KEY_ID;
const buildRoot = await mkdtemp(path.join(os.tmpdir(), "dbx-repository-sign-"));

if (!process.env.DBX_PLUGIN_SIGNING_KEY || !keyId) {
  throw new Error("Repository signing requires DBX_PLUGIN_SIGNING_KEY and DBX_PLUGIN_SIGNING_KEY_ID");
}

try {
  run(
    "cargo",
    [
      "run",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(root, "..", "..", "sdk", "packager", "Cargo.toml"),
      "--",
      "sign",
      candidate,
      signed,
      "--key-id",
      keyId,
      "--artifact-metadata",
      metadata,
      "--target",
      target,
      "--artifact-url",
      `../hello-workbench/dist/${path.basename(signed)}`,
    ],
    { CARGO_TARGET_DIR: path.join(buildRoot, "cargo-target") },
  );

  if (process.env.DBX_PLUGIN_SKIP_EXAMPLE_CATALOG !== "1") await updateExampleCatalog(metadata);
  console.log(`Repository-signed ${signed}`);
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

async function updateExampleCatalog(metadataPath) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const artifact = JSON.parse(await readFile(metadataPath, "utf8"));
  const catalogPath = path.join(root, "..", "marketplace", "catalog.example.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const plugin = catalog.plugins.find((entry) => entry.id === manifest.id);
  const version = plugin?.versions.find((entry) => entry.version === manifest.version);
  if (!version) throw new Error(`Example marketplace catalog is missing ${manifest.id} ${manifest.version}`);
  plugin.name = manifest.name;
  plugin.description = manifest.description || "";
  plugin.publisher = manifest.publisher;
  plugin.permissions = [...(manifest.permissions || [])];
  plugin.latestVersion = manifest.version;
  const existingIndex = version.artifacts.findIndex((entry) => entry.target === artifact.target);
  if (existingIndex >= 0) version.artifacts[existingIndex] = artifact;
  else version.artifacts.push(artifact);
  version.artifacts.sort((left, right) => left.target.localeCompare(right.target));
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}
