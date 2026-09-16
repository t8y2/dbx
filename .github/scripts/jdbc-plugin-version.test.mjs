import assert from "node:assert/strict";
import test from "node:test";

import { evaluateJdbcPluginReleaseBump } from "./bump-jdbc-plugin-version.mjs";
import { evaluateJdbcPluginVersionChange, jdbcGradleVersion } from "./check-jdbc-plugin-version.mjs";

const buildGradle = `plugins {
    id 'java'
}

version = '0.1.26'
`;
const manifestJson = `${JSON.stringify({ version: "0.1.26" }, null, 2)}\n`;

test("reads the JDBC plugin version from Gradle", () => {
  assert.equal(jdbcGradleVersion(buildGradle), "0.1.26");
});

test("checks Gradle and manifest versions together", () => {
  assert.deepEqual(
    evaluateJdbcPluginVersionChange({ headGradleVersion: "0.1.26", headManifestVersion: "0.1.26" }),
    [],
  );
  assert.match(
    evaluateJdbcPluginVersionChange({ headGradleVersion: "0.1.27", headManifestVersion: "0.1.26" })[0],
    /build\.gradle is 0\.1\.27/,
  );
});

test("bumps Gradle and manifest versions for JDBC source changes", () => {
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles: ["plugins/jdbc/build.gradle", "plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java"],
    buildGradle,
    manifestJson,
  });

  assert.equal(result.changed, true);
  assert.equal(result.oldVersion, "0.1.26");
  assert.equal(result.newVersion, "0.1.27");
  assert.match(result.buildGradle, /version = '0\.1\.27'/);
  assert.equal(JSON.parse(result.manifestJson).version, "0.1.27");
});

test("keeps an explicit Gradle version change", () => {
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles: ["plugins/jdbc/build.gradle", "plugins/jdbc/manifest.json"],
    buildGradle,
    manifestJson,
  });

  assert.equal(result.changed, false);
  assert.equal(result.newVersion, "0.1.26");
});
