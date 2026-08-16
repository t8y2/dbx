#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ASSET_MANIFEST = join(REPO_ROOT, "apps/desktop/src/lib/database/managedJdbcAssets.json");
const PLATFORMS = ["macos-aarch64", "macos-x64", "linux-x64", "linux-aarch64", "windows-x64", "windows-aarch64"];

function fail(message) {
  throw new Error(message);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function filesBelow(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  visit(root);
  return files.sort();
}

function flattenBundles(manifest) {
  return Object.values(manifest.drivers).flatMap((driver) => Object.values(driver.bundles || {}));
}

async function validatePayload(payloadDir, assetManifestPath) {
  const assets = JSON.parse(readFileSync(assetManifestPath, "utf8"));
  const approved = flattenBundles(assets);
  const offline = JSON.parse(readFileSync(join(payloadDir, "offline-manifest.json"), "utf8"));
  const notices = JSON.parse(readFileSync(join(payloadDir, "third-party-notices.json"), "utf8"));
  if (offline.third_party_entry !== "jdbc/third-party-notices.json") fail("Offline JDBC third-party notice entry is missing");
  if (JSON.stringify(offline.bundles) !== JSON.stringify(approved.map(({ id, coordinate }) => ({ id, coordinate })))) {
    fail("Offline JDBC bundle list differs from the managed JDBC asset manifest");
  }
  if (notices.bundles.length !== approved.length) fail("Offline JDBC third-party notice list is incomplete");

  for (const bundle of approved) {
    const manifest = JSON.parse(readFileSync(join(payloadDir, "maven", bundle.id, "manifest.json"), "utf8"));
    if (manifest.coordinate !== bundle.coordinate || manifest.artifacts.length !== 1) fail(`Invalid offline JDBC bundle: ${bundle.coordinate}`);
    const artifact = manifest.artifacts[0];
    const jar = join(payloadDir, "maven", bundle.id, "jars", artifact.file_name);
    if (artifact.size !== statSync(jar).size || artifact.sha256 !== (await sha256(jar))) fail(`Invalid bundled JDBC artifact: ${bundle.coordinate}`);
    if (artifact.sha256 !== bundle.artifact.sha256 || artifact.size !== bundle.artifact.size) fail(`Unapproved bundled JDBC artifact: ${bundle.coordinate}`);
    const notice = notices.bundles.find((candidate) => candidate.id === bundle.id);
    if (!notice || JSON.stringify(notice.redistribution) !== JSON.stringify(bundle.redistribution)) fail(`Missing redistribution metadata: ${bundle.coordinate}`);
  }
}

async function main() {
  const [releaseArg, assetManifestArg] = process.argv.slice(2);
  if (!releaseArg) fail("Usage: verify_offline_jdbc_release.mjs <release-dir> [asset-manifest]");
  const releaseDir = resolve(releaseArg);
  const payloadDir = join(releaseDir, "offline-jdbc", "jdbc");
  const assetManifestPath = resolve(assetManifestArg || DEFAULT_ASSET_MANIFEST);
  if (!existsSync(payloadDir)) fail(`Offline JDBC payload not found: ${payloadDir}`);
  await validatePayload(payloadDir, assetManifestPath);

  const expectedFiles = filesBelow(payloadDir);
  const expectedHashes = new Map();
  for (const file of expectedFiles) expectedHashes.set(file, await sha256(join(payloadDir, file)));

  for (const platform of PLATFORMS) {
    const zip = join(releaseDir, `dbx-agents-offline-${platform}.zip`);
    if (!existsSync(zip)) fail(`Offline ZIP not found: ${zip}`);
    const extractionRoot = mkdtempSync(join(tmpdir(), `dbx-offline-verify-${platform}-`));
    try {
      const result = spawnSync("unzip", ["-q", zip, "-d", extractionRoot], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (result.error) fail(`Failed to unpack ${zip}: ${result.error.message}`);
      if (result.status !== 0) fail(`Failed to unpack ${zip}: ${(result.stderr || result.stdout).trim()}`);
      const extractedPayload = join(extractionRoot, "jdbc");
      const actualFiles = filesBelow(extractedPayload);
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail(`Incomplete jdbc/ directory in ${zip}`);
      for (const file of actualFiles) {
        if ((await sha256(join(extractedPayload, file))) !== expectedHashes.get(file)) fail(`JDBC payload checksum mismatch in ${zip}: ${file}`);
      }
    } finally {
      rmSync(extractionRoot, { recursive: true, force: true });
    }
    console.log(`Verified complete jdbc/ payload in dbx-agents-offline-${platform}.zip`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
