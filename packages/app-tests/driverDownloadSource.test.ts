import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("shares the configured download source with agent driver management", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");
  const backendApi = source("apps/desktop/src/lib/backend/api.ts");

  assert.match(driverStore, /driverStoreTab === 'agent' && !isWeb/);
  assert.match(driverStore, /:model-value="settingsStore\.editorSettings\.updateDownloadSource"/);
  assert.match(driverStore, /settingsStore\.updateEditorSettings\(\{ updateDownloadSource: value \}\)/);
  assert.match(driverStore, /void forceRefresh\(\)\.catch\(\(\) => undefined\)/);

  assert.match(backendApi, /backend\.listInstalledAgents\(useSettingsStore\(\)\.editorSettings\.updateDownloadSource\)/);
  assert.match(backendApi, /backend\.installAgent\(dbType, useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
  assert.match(backendApi, /backend\.upgradeAllAgents\(useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
  assert.match(backendApi, /backend\.reinstallJre\(jreKey, useSettingsStore\(\)\.editorSettings\.updateDownloadSource(?:, operationId)?\)/);
});
