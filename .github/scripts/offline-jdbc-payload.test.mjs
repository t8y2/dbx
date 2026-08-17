import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = join(REPO_ROOT, "agents/scripts/build_offline_jdbc_payload.mjs");
const ZIP_BUILDER = join(REPO_ROOT, "agents/scripts/build_offline_zip.sh");
const RELEASE_VERIFIER = join(REPO_ROOT, "agents/scripts/verify_offline_jdbc_release.mjs");
const ASSET_MANIFEST = join(REPO_ROOT, "apps/desktop/src/lib/database/managedJdbcAssets.json");
const PLATFORMS = ["macos-aarch64", "macos-x64", "linux-x64", "linux-aarch64", "windows-x64", "windows-aarch64"];

function flattenBundles(manifest) {
  return Object.values(manifest.drivers).flatMap((driver) => Object.values(driver.bundles || {}));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("builds and verifies all platform ZIPs from the managed JDBC asset manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-offline-jdbc-builder-test-"));
  try {
    const releaseDir = join(root, "release");
    const pluginZip = join(root, "plugin.zip");
    const jarRoot = join(root, "jar");
    const artifact = join(root, "driver.jar");
    const resolver = join(root, "resolver.mjs");
    const testManifestPath = join(root, "managed-jdbc-assets.json");
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(join(jarRoot, "META-INF"), { recursive: true });
    writeFileSync(pluginZip, "plugin");
    writeFileSync(join(jarRoot, "META-INF/LICENSE"), "Apache License 2.0\n");
    writeFileSync(join(jarRoot, "META-INF/NOTICE"), "Test notice\n");
    run("zip", ["-qr", artifact, "."], { cwd: jarRoot });

    const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const productionManifest = JSON.parse(readFileSync(ASSET_MANIFEST, "utf8"));
    const testManifest = structuredClone(productionManifest);
    const resolverBundles = {};
    for (const bundle of flattenBundles(testManifest)) {
      bundle.artifact.file_name = "driver.jar";
      bundle.artifact.size = statSync(artifact).size;
      bundle.artifact.sha256 = digest;
      bundle.redistribution.license_entries = ["META-INF/LICENSE"];
      bundle.redistribution.notice_entries = ["META-INF/NOTICE"];
      resolverBundles[bundle.coordinate] = {
        coordinate: bundle.coordinate,
        scope: "runtime",
        repositories: [testManifest.repository],
        artifacts: [
          {
            groupId: bundle.artifact.group_id,
            artifactId: bundle.artifact.artifact_id,
            version: bundle.artifact.version,
            classifier: bundle.artifact.classifier,
            extension: bundle.artifact.extension,
            file: artifact,
            size: bundle.artifact.size,
            sha256: digest,
          },
        ],
      };
    }
    writeFileSync(testManifestPath, `${JSON.stringify(testManifest, null, 2)}\n`);
    writeFileSync(
      resolver,
      `#!/usr/bin/env node
const bundles = ${JSON.stringify(resolverBundles)};
const coordinate = process.argv[process.argv.indexOf("--coordinate") + 1];
if (!bundles[coordinate]) process.exit(2);
process.stdout.write(JSON.stringify(bundles[coordinate]));
`,
    );
    chmodSync(resolver, 0o755);

    run(process.execPath, [BUILDER, releaseDir, pluginZip, resolver, testManifestPath], {
      env: { ...process.env, DBX_OFFLINE_JDBC_MAVEN_CACHE: join(root, "cache") },
    });

    const payloadDir = join(releaseDir, "offline-jdbc/jdbc");
    const offlineManifest = JSON.parse(readFileSync(join(payloadDir, "offline-manifest.json"), "utf8"));
    assert.equal(offlineManifest.format_version, 1);
    assert.equal(offlineManifest.plugin_entry, "jdbc/plugin.zip");
    assert.equal(offlineManifest.third_party_entry, "jdbc/third-party-notices.json");
    assert.deepEqual(
      offlineManifest.bundles.map((bundle) => bundle.coordinate),
      flattenBundles(productionManifest).map((bundle) => bundle.coordinate),
    );
    for (const bundle of offlineManifest.bundles) {
      const bundleManifest = JSON.parse(readFileSync(join(payloadDir, "maven", bundle.id, "manifest.json"), "utf8"));
      assert.equal(bundleManifest.coordinate, bundle.coordinate);
      assert.equal(bundleManifest.artifacts.length, 1);
      assert.equal(bundleManifest.artifacts[0].sha256, digest);
    }

    writeFileSync(join(releaseDir, "agent-registry.json"), "{}\n");
    for (const platform of PLATFORMS) writeFileSync(join(releaseDir, `dbx-jre-21-${platform}.tar.zst`), platform);
    run("bash", [ZIP_BUILDER, releaseDir]);
    run(process.execPath, [RELEASE_VERIFIER, releaseDir, testManifestPath]);
    for (const platform of PLATFORMS) assert.equal(existsSync(join(releaseDir, `dbx-agents-offline-${platform}.zip`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
