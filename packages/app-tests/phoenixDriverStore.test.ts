import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("registers one Apache Phoenix JDBC row in Driver Manager", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.match(driverStore, /phoenixBuiltinDriverRow\(jdbcMavenBundles\.value, jdbcPluginStatus\.value\)/);
  assert.match(driverStore, /isManagedJdbcBuiltinDriver\(dbType: string\)/);
  assert.match(driverStore, /isPhoenixBuiltinDriver\(dbType\)/);
});

test("installs missing Phoenix bundles and uninstalls only exact managed bundles", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.match(driverStore, /for \(const coordinate of phoenixMissingMavenCoordinates\(jdbcMavenBundles\.value\)\)/);
  assert.match(driverStore, /installJdbcDriverFromMaven\(coordinate, \[PHOENIX_MAVEN_REPOSITORY\]\)/);
  assert.match(driverStore, /for \(const bundle of phoenixBuiltinDriverBundles\(jdbcMavenBundles\.value\)\)/);
  assert.match(driverStore, /deleteJdbcMavenBundle\(bundle\.id\)/);
});

test("routes Phoenix runtime failures back to its named Driver Manager row", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");

  assert.match(connectionDialog, /connectionErrorRawDetail\.value = message/);
  assert.match(connectionDialog, /isPhoenixDriverInstallError\(connectionErrorRawDetail\.value\)/);
  assert.match(connectionDialog, /isPhoenixConnection\.value \? agentDriverFocus\.value : \{ target: "tab", tab: "jdbc" \}/);
  assert.match(connectionDialog, /emit\('openDriverStore', agentDriverFocus\)/);
});

test("treats each Phoenix mode as one complete runtime in the connection selector", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");

  assert.match(connectionDialog, /phoenixManagedRuntimePaths\(jdbcMavenBundles\.value, phoenixConnectionMode\.value\)/);
  assert.match(connectionDialog, /label: t\("connection\.phoenixRuntimeOption"/);
  assert.match(connectionDialog, /\.filter\(\(path\) => path && !isPhoenixManagedMavenPath\(path\)\)/);
  assert.doesNotMatch(connectionDialog, /async function loadJdbcDrivers\(\) \{\s*if \(!isDesktop\) return;/);
});
