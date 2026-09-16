#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ASSET_MANIFEST = join(REPO_ROOT, "apps/desktop/src/lib/database/managedJdbcAssets.json");

function fail(message) {
  throw new Error(message);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function loadAssetManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.format_version !== 1) fail(`Unsupported managed JDBC asset manifest version: ${manifest.format_version}`);
  if (!manifest.repository || !manifest.drivers || typeof manifest.drivers !== "object") fail("Invalid managed JDBC asset manifest");

  const bundles = Object.values(manifest.drivers).flatMap((driver) => Object.values(driver.bundles || {}));
  if (bundles.length === 0) fail("Managed JDBC asset manifest contains no bundles");
  const ids = new Set();
  const coordinates = new Set();
  for (const bundle of bundles) {
    if (!bundle.id || !bundle.coordinate || !bundle.artifact || !bundle.redistribution) fail("Managed JDBC bundle is incomplete");
    if (ids.has(bundle.id)) fail(`Duplicate managed JDBC bundle id: ${bundle.id}`);
    if (coordinates.has(bundle.coordinate)) fail(`Duplicate managed JDBC coordinate: ${bundle.coordinate}`);
    ids.add(bundle.id);
    coordinates.add(bundle.coordinate);
  }
  return { manifest, bundles };
}

function resolveBundle(resolver, coordinate, localRepository, repositories) {
  const javaToolOptions = [
    process.env.JAVA_TOOL_OPTIONS,
    "-Djava.net.preferIPv4Stack=true",
    "-Daether.connector.connectTimeout=30000",
    "-Daether.connector.requestTimeout=300000",
  ]
    .filter(Boolean)
    .join(" ");
  const args = ["resolve", "--coordinate", coordinate, "--local-repo", localRepository];
  for (const repository of repositories) args.push("--repo", repository);
  const result = spawnSync(resolver, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: javaToolOptions },
  });
  if (result.error) fail(`Failed to start JDBC Maven resolver for ${coordinate}: ${result.error.message}`);
  if (result.status !== 0) fail(`Failed to resolve ${coordinate}: ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Failed to parse Maven resolver output for ${coordinate}: ${error.message}`);
  }
}

function artifactIdentity(artifact) {
  return [artifact.groupId, artifact.artifactId, artifact.version, artifact.classifier || "", artifact.extension].join(":");
}

function expectedArtifactIdentity(artifact) {
  return [artifact.group_id, artifact.artifact_id, artifact.version, artifact.classifier || "", artifact.extension].join(":");
}

function jarEntries(path) {
  const result = spawnSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) fail(`Failed to inspect JDBC JAR ${path}: ${result.error.message}`);
  if (result.status !== 0) fail(`Failed to inspect JDBC JAR ${path}: ${(result.stderr || result.stdout).trim()}`);
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

async function validateAndCopyBundle(bundle, resolved, mavenDir) {
  const resolvedArtifacts = (resolved.artifacts || []).filter((artifact) => String(artifact.extension).toLowerCase() === "jar");
  const identities = new Set(resolvedArtifacts.map(artifactIdentity));
  if (identities.size !== resolvedArtifacts.length) fail(`Maven resolver returned duplicate JAR artifacts for ${bundle.coordinate}`);
  if (resolvedArtifacts.length !== 1) {
    fail(`Resolved dependency set changed for ${bundle.coordinate}: expected 1 approved shaded JAR, received ${resolvedArtifacts.length}`);
  }

  const resolvedArtifact = resolvedArtifacts[0];
  const approved = bundle.artifact;
  if (artifactIdentity(resolvedArtifact) !== expectedArtifactIdentity(approved)) {
    fail(`Resolved artifact identity does not match the approved asset for ${bundle.coordinate}`);
  }
  if (!existsSync(resolvedArtifact.file)) fail(`Resolved artifact does not exist: ${resolvedArtifact.file}`);
  if (basename(resolvedArtifact.file) !== approved.file_name) fail(`Resolved artifact file name does not match the approved asset for ${bundle.coordinate}`);

  const actualSize = statSync(resolvedArtifact.file).size;
  const actualDigest = await sha256(resolvedArtifact.file);
  if (Number(resolvedArtifact.size) !== actualSize || String(resolvedArtifact.sha256).toLowerCase() !== actualDigest) {
    fail(`Maven resolver metadata mismatch: ${resolvedArtifact.file}`);
  }
  if (approved.size !== actualSize || approved.sha256.toLowerCase() !== actualDigest) {
    fail(`Resolved artifact checksum is not approved for redistribution: ${bundle.coordinate}`);
  }

  const entries = jarEntries(resolvedArtifact.file);
  for (const entry of [...bundle.redistribution.license_entries, ...bundle.redistribution.notice_entries]) {
    if (!entries.has(entry)) fail(`Approved license/notice entry is missing from ${bundle.coordinate}: ${entry}`);
  }

  const bundleDir = join(mavenDir, bundle.id);
  const jarsDir = join(bundleDir, "jars");
  mkdirSync(jarsDir, { recursive: true });
  copyFileSync(resolvedArtifact.file, join(jarsDir, approved.file_name));
  const artifact = {
    group_id: approved.group_id,
    artifact_id: approved.artifact_id,
    version: approved.version,
    classifier: approved.classifier || "",
    extension: approved.extension,
    file_name: approved.file_name,
    path: "",
    size: actualSize,
    sha256: actualDigest,
  };
  const bundleManifest = {
    id: bundle.id,
    coordinate: bundle.coordinate,
    scope: resolved.scope || "runtime",
    repositories: resolved.repositories?.length ? resolved.repositories : [],
    installed_at: "",
    path: "",
    artifacts: [artifact],
  };
  writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(bundleManifest, null, 2)}\n`);
  return artifact;
}

async function main() {
  const [releaseArg, pluginZipArg, resolverArg, assetManifestArg] = process.argv.slice(2);
  if (!releaseArg || !pluginZipArg || !resolverArg) {
    fail("Usage: build_offline_jdbc_payload.mjs <release-dir> <jdbc-plugin-zip> <maven-resolver> [asset-manifest]");
  }

  const releaseDir = resolve(releaseArg);
  const pluginZip = resolve(pluginZipArg);
  const resolver = resolve(resolverArg);
  const assetManifestPath = resolve(assetManifestArg || DEFAULT_ASSET_MANIFEST);
  if (!existsSync(pluginZip)) fail(`JDBC plugin ZIP not found: ${pluginZip}`);
  if (!existsSync(resolver)) fail(`JDBC Maven resolver not found: ${resolver}`);
  if (!existsSync(assetManifestPath)) fail(`Managed JDBC asset manifest not found: ${assetManifestPath}`);
  const { manifest: assetManifest, bundles } = loadAssetManifest(assetManifestPath);

  const payloadDir = join(releaseDir, "offline-jdbc", "jdbc");
  const mavenDir = join(payloadDir, "maven");
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(mavenDir, { recursive: true });
  copyFileSync(pluginZip, join(payloadDir, "plugin.zip"));

  const externalCache = process.env.DBX_OFFLINE_JDBC_MAVEN_CACHE?.trim();
  const resolverRepository = process.env.DBX_OFFLINE_JDBC_MAVEN_REPOSITORY?.trim() || assetManifest.repository;
  const workDir = externalCache ? null : mkdtempSync(join(tmpdir(), "dbx-offline-jdbc-"));
  const localRepository = externalCache ? resolve(externalCache) : join(workDir, "maven-cache");
  mkdirSync(localRepository, { recursive: true });
  const manifestBundles = [];
  const notices = [];
  try {
    for (const bundle of bundles) {
      console.log(`Resolving offline JDBC bundle ${bundle.coordinate}`);
      const resolved = resolveBundle(resolver, bundle.coordinate, localRepository, [resolverRepository]);
      const artifact = await validateAndCopyBundle(bundle, resolved, mavenDir);
      manifestBundles.push({ id: bundle.id, coordinate: bundle.coordinate });
      notices.push({ id: bundle.id, coordinate: bundle.coordinate, artifact, redistribution: bundle.redistribution });
      console.log(`Prepared ${bundle.coordinate} (approved SHA-256 ${artifact.sha256})`);
    }
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }

  writeFileSync(
    join(payloadDir, "third-party-notices.json"),
    `${JSON.stringify({ format_version: 1, bundles: notices }, null, 2)}\n`,
  );
  writeFileSync(
    join(payloadDir, "offline-manifest.json"),
    `${JSON.stringify({ format_version: 1, plugin_entry: "jdbc/plugin.zip", third_party_entry: "jdbc/third-party-notices.json", bundles: manifestBundles }, null, 2)}\n`,
  );
  console.log(`Prepared offline JDBC payload in ${payloadDir}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
