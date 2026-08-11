import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const driverStoreSource = readFileSync(path.resolve("apps/desktop/src/components/config/DriverStoreDialog.vue"), "utf8");

function buttonOpeningTag(clickHandler: string): string {
  const click = `@click="${clickHandler}"`;
  const clickIndex = driverStoreSource.indexOf(click);
  assert.notEqual(clickIndex, -1, `missing button for ${clickHandler}`);
  const startIndex = driverStoreSource.lastIndexOf("<Button", clickIndex);
  const endIndex = driverStoreSource.indexOf(">", clickIndex);
  assert.notEqual(startIndex, -1, `missing button start for ${clickHandler}`);
  assert.notEqual(endIndex, -1, `missing button end for ${clickHandler}`);
  return driverStoreSource.slice(startIndex, endIndex + 1);
}

test("keeps Agent offline packages out of the JDBC tab", () => {
  const agentOfflineButton = buttonOpeningTag("importOfflineZip");

  assert.match(agentOfflineButton, /v-if="driverStoreTab === 'agent'"/);
  assert.match(driverStoreSource, /api\.importAgentsFromZip\(selected, activeAgentOperationId\.value\)/);
});

test("keeps local JDBC plugin installation available after installation", () => {
  const jdbcPluginLocalButton = buttonOpeningTag("installJdbcPluginLocal");

  assert.doesNotMatch(jdbcPluginLocalButton, /v-if=/);
  assert.match(jdbcPluginLocalButton, /:disabled="isInstallingJdbcPlugin \|\| isUninstallingJdbcPlugin"/);
  assert.match(driverStoreSource, /api\.installJdbcPluginLocal\(selected\)/);
});
