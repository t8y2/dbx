import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const { evaluateJdbcPluginReleaseBump } = await importScript(".github/scripts/bump-jdbc-plugin-version.mjs");
const { evaluateJdbcPluginVersionChange } = await importScript(".github/scripts/check-jdbc-plugin-version.mjs");
const { augmentLatestJsonWithJdbcPlugin } = await importScript(".github/scripts/augment-latest-json-jdbc-plugin.mjs");

function importScript(path: string): Promise<Record<string, unknown>> {
  const source = readFileSync(resolve(path), "utf8").replace(/^#!.*\r?\n/, "");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("allows JDBC plugin runtime changes without a manual version bump before release", () => {
  assert.deepEqual(
    evaluateJdbcPluginVersionChange({
      changedFiles: ["plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java"],
      basePomVersion: "0.1.1",
      baseManifestVersion: "0.1.1",
      headPomVersion: "0.1.1",
      headManifestVersion: "0.1.1",
    }),
    [],
  );
});

test("allows JDBC plugin runtime changes when pom and manifest versions are bumped together", () => {
  assert.deepEqual(
    evaluateJdbcPluginVersionChange({
      changedFiles: ["plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java"],
      basePomVersion: "0.1.1",
      baseManifestVersion: "0.1.1",
      headPomVersion: "0.1.2",
      headManifestVersion: "0.1.2",
    }),
    [],
  );
});

test("does not require a JDBC plugin version bump for docs or release packaging changes", () => {
  assert.deepEqual(
    evaluateJdbcPluginVersionChange({
      changedFiles: ["plugins/jdbc/README.md", "plugins/jdbc/package.sh"],
      basePomVersion: "0.1.1",
      baseManifestVersion: "0.1.1",
      headPomVersion: "0.1.1",
      headManifestVersion: "0.1.1",
    }),
    [],
  );
});

test("requires JDBC plugin pom and manifest versions to match", () => {
  assert.deepEqual(
    evaluateJdbcPluginVersionChange({
      changedFiles: ["plugins/jdbc/manifest.json"],
      basePomVersion: "0.1.1",
      baseManifestVersion: "0.1.1",
      headPomVersion: "0.1.2",
      headManifestVersion: "0.1.1",
    }),
    ["JDBC plugin version mismatch: pom.xml is 0.1.2 but manifest.json is 0.1.1."],
  );
});

test("auto bumps JDBC plugin patch version when runtime files changed for release", () => {
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles: ["plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java"],
    pomXml: "<project><version>0.1.9</version></project>",
    manifestJson: '{ "version": "0.1.9" }',
  });

  assert.equal(result.changed, true);
  assert.equal(result.oldVersion, "0.1.9");
  assert.equal(result.newVersion, "0.1.10");
  assert.match(result.pomXml, /<version>0\.1\.10<\/version>/);
  assert.match(result.manifestJson, /"version": "0\.1\.10"/);
});

test("does not auto bump JDBC plugin again when release range already includes a version bump", () => {
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles: ["plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java", "plugins/jdbc/pom.xml", "plugins/jdbc/manifest.json"],
    pomXml: "<project><version>0.1.10</version></project>",
    manifestJson: '{ "version": "0.1.10" }',
  });

  assert.equal(result.changed, false);
  assert.equal(result.oldVersion, "0.1.10");
  assert.equal(result.newVersion, "0.1.10");
});

test("does not auto bump JDBC plugin version for release packaging-only changes", () => {
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles: ["plugins/jdbc/README.md", "plugins/jdbc/package.sh"],
    pomXml: "<project><version>0.1.9</version></project>",
    manifestJson: '{ "version": "0.1.9" }',
  });

  assert.equal(result.changed, false);
  assert.equal(result.oldVersion, "0.1.9");
  assert.equal(result.newVersion, "0.1.9");
});

test("auto bump refuses mismatched JDBC plugin source versions", () => {
  assert.throws(
    () =>
      evaluateJdbcPluginReleaseBump({
        changedFiles: ["plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java"],
        pomXml: "<project><version>0.1.9</version></project>",
        manifestJson: '{ "version": "0.1.8" }',
      }),
    /JDBC plugin version mismatch/,
  );
});

test("adds JDBC plugin metadata to latest.json without disturbing updater fields", () => {
  const result = augmentLatestJsonWithJdbcPlugin({
    latestJson: JSON.stringify({
      version: "0.5.12",
      notes: "Release notes",
      platforms: {
        "darwin-aarch64": {
          signature: "sig",
          url: "https://example.com/app.dmg",
        },
      },
    }),
    jdbcVersion: "0.1.3",
    protocolVersion: 1,
    url: "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip",
  });
  const parsed = JSON.parse(result);

  assert.equal(parsed.version, "0.5.12");
  assert.equal(parsed.platforms["darwin-aarch64"].signature, "sig");
  assert.deepEqual(parsed.jdbc_plugin, {
    version: "0.1.3",
    protocol_version: 1,
    url: "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip",
  });
});
