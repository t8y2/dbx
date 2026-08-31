import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("renders registered managed JDBC rows in Driver Manager", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.match(driverStore, /managedJdbcDriverRows\(jdbcMavenBundles\.value, jdbcPluginStatus\.value\)/);
  assert.match(driverStore, /isManagedJdbcBuiltinDriver\(dbType: string\)/);
  assert.match(driverStore, /isManagedJdbcDriver\(dbType\)/);
});

test("dispatches install and uninstall through the shared managed JDBC lifecycle", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.match(driverStore, /installRegisteredManagedJdbcDriver\(dbType, jdbcMavenBundles\.value, jdbcPluginStatus\.value, api\)/);
  assert.match(driverStore, /uninstallRegisteredManagedJdbcDriver\(dbType, jdbcMavenBundles\.value, api\)/);
});

test("routes managed product runtime failures back to the registered Driver Manager row", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");

  assert.match(connectionDialog, /connectionErrorRawDetail\.value = message/);
  assert.match(connectionDialog, /isRegisteredJdbcProductRuntimeInstallError\(form\.value, connectionErrorRawDetail\.value\)/);
  assert.match(connectionDialog, /isJdbcProductConnection\.value \? agentDriverFocus\.value : \{ target: "tab", tab: "jdbc" \}/);
  assert.match(connectionDialog, /emit\('openDriverStore', agentDriverFocus\)/);
});

test("treats each registered product mode as one complete runtime in the connection selector", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");

  assert.match(connectionDialog, /jdbcProductManagedRuntimePaths\(productProfile, jdbcMavenBundles\.value, productMode\.id\)/);
  assert.match(connectionDialog, /label: t\(productProfile\.runtimeLabelKey/);
  assert.match(connectionDialog, /!isJdbcProductManagedMavenPath\(activeJdbcProductProfile\.value!, path\)/);
  assert.doesNotMatch(connectionDialog, /async function loadJdbcDrivers\(\) \{\s*if \(!isDesktop\) return;/);
});

test("keeps product-specific branches out of generic integration files", () => {
  for (const file of ["apps/desktop/src/components/connection/ConnectionDialog.vue", "apps/desktop/src/components/config/DriverStoreDialog.vue", "apps/desktop/src/App.vue"]) {
    const contents = source(file);
    assert.doesNotMatch(contents, /from ["']@\/lib\/database\/phoenix/);
    assert.doesNotMatch(contents, /PHOENIX_DRIVER_PROFILE/);
    assert.doesNotMatch(contents, /isPhoenix|ensurePhoenix|phoenixConnectionMode/);
  }
});
