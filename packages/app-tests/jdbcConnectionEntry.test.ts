import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("keeps JDBC outside the database picker and exposes a dedicated entry", () => {
  const content = source("apps/desktop/src/components/connection/ConnectionDialog.vue");
  const optionsStart = content.indexOf("const dbOptions: DbOption[] = [");
  const optionsEnd = content.indexOf("const dbCategories", optionsStart);
  const pickerToolbar = content.indexOf("sm:justify-between");
  const searchInput = content.indexOf('v-model="dbSearchQuery"', pickerToolbar);
  const jdbcEntry = content.indexOf("data-jdbc-connection-entry", pickerToolbar);

  assert.notEqual(optionsStart, -1);
  assert.notEqual(optionsEnd, -1);
  assert.equal(content.slice(optionsStart, optionsEnd).includes('{ value: "jdbc"'), false);
  assert.ok(pickerToolbar < searchInput && searchInput < jdbcEntry);
  assert.match(content.slice(jdbcEntry, jdbcEntry + 400), /goToConnectionStep\('jdbc'\)/);
});

test("opens driver management on the JDBC tab from JDBC connection settings", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");
  const appDialogs = source("apps/desktop/src/components/layout/AppDialogs.vue");
  const app = source("apps/desktop/src/App.vue");
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.equal(connectionDialog.match(/emit\('openDriverStore', \{ target: 'tab', tab: 'jdbc' \}\)/g)?.length, 2);
  assert.match(appDialogs, /@open-driver-store="emit\('openDriverStore', \$event\)"/);
  assert.match(app, /openDriverStorePage\(\$event\)/);
  assert.match(app, /v-model:active-tab="driverStoreActiveTab"/);
  assert.match(driverStore, /"update:activeTab": \[tab: "agent" \| "jdbc" \| "storage" \| "runtime"\]/);
});

test("resets the driver management tab after the page is closed", () => {
  const app = source("apps/desktop/src/App.vue");
  const closeStart = app.indexOf("function closeDriverStorePage() {");
  const closeEnd = app.indexOf("\n}", closeStart);

  assert.notEqual(closeStart, -1);
  assert.notEqual(closeEnd, -1);
  assert.match(app.slice(closeStart, closeEnd), /driverStoreActiveTab\.value = "agent"/);
});
