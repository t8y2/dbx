import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = join(REPO_ROOT, "agents/scripts/build_offline_jdbc_payload.mjs");

test("builds a portable JDBC payload for all managed coordinates", () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-offline-jdbc-builder-test-"));
  try {
    const releaseDir = join(root, "release");
    const pluginZip = join(root, "plugin.zip");
    const artifact = join(root, "driver.jar");
    const resolver = join(root, "resolver.mjs");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(pluginZip, "plugin");
    writeFileSync(artifact, "driver");
    const digest = createHash("sha256").update("driver").digest("hex");
    writeFileSync(
      resolver,
      `#!/usr/bin/env node
const coordinate = process.argv[process.argv.indexOf("--coordinate") + 1];
process.stdout.write(JSON.stringify({
  coordinate,
  scope: "runtime",
  repositories: ["https://repo.maven.apache.org/maven2/"],
  artifacts: [{
    groupId: "test",
    artifactId: "driver",
    version: "1",
    classifier: "",
    extension: "jar",
    file: ${JSON.stringify(artifact)},
    size: 6,
    sha256: ${JSON.stringify(digest)},
  }],
}));
`,
    );
    chmodSync(resolver, 0o755);

    const result = spawnSync(process.execPath, [BUILDER, releaseDir, pluginZip, resolver], {
      encoding: "utf8",
      env: { ...process.env, DBX_OFFLINE_JDBC_MAVEN_CACHE: join(root, "cache") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const payloadDir = join(releaseDir, "offline-jdbc/jdbc");
    const manifest = JSON.parse(readFileSync(join(payloadDir, "offline-manifest.json"), "utf8"));
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.plugin_entry, "jdbc/plugin.zip");
    assert.deepEqual(
      manifest.bundles.map((bundle) => bundle.coordinate),
      [
        "io.prestosql:presto-jdbc:350",
        "org.apache.phoenix:phoenix-client-embedded-hbase-2.5:5.2.1",
        "ch.qos.reload4j:reload4j:1.2.26",
        "org.apache.phoenix:phoenix-queryserver-client:6.0.0",
      ],
    );
    for (const bundle of manifest.bundles) {
      const bundleManifest = JSON.parse(readFileSync(join(payloadDir, "maven", bundle.id, "manifest.json"), "utf8"));
      assert.equal(bundleManifest.coordinate, bundle.coordinate);
      assert.equal(bundleManifest.artifacts.length, 1);
      assert.equal(readFileSync(join(payloadDir, "maven", bundle.id, "jars/driver.jar"), "utf8"), "driver");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
