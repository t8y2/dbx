import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("Driver Manager exposes an install-status filter next to search", () => {
  const driverStore = source("apps/desktop/src/components/config/DriverStoreDialog.vue");

  assert.match(driverStore, /data-driver-status-filter/);
  assert.match(driverStore, /driverStatusFilter = ref<DriverInstallStatusFilter>\("all"\)/);
  assert.match(driverStore, /partitionDriversByInstallStatus\(builtinDriverRows\.value, driverStatusFilter\.value\)/);
  assert.match(driverStore, /upgradeAllDriverTypes\(builtinDriverRows\.value, driverStatusFilter\.value\)/);
  assert.match(driverStore, /if \(!upgradeAllMatchesFullUpdateSet\(builtinDriverRows\.value, driverStatusFilter\.value\)\) return/);
  assert.match(driverStore, /upgradeAllMatchesFullUpdateSet\(builtinDriverRows\.value, driverStatusFilter\.value\)/);
  assert.match(driverStore, /driverStatusFilter\.value = "all"/);
  assert.match(driverStore, /shouldApplyDriverStoreFocus\(lastAppliedFocusKey\.value, key, focusChanged\)/);
  assert.match(driverStore, /driverStoreFocusRowIsRenderable\(focus, drivers\.value\.length, builtinDriverRows\.value\)/);
  const applyIdx = driverStore.indexOf("if (!shouldApplyDriverStoreFocus");
  const tabIdx = driverStore.indexOf('driverStoreTab.value = "agent"');
  assert.ok(applyIdx >= 0, "focus apply guard");
  assert.ok(tabIdx > applyIdx, "Agent tab switch must sit behind the one-shot focus guard");
  assert.match(driverStore, /showInstalledEmptyState/);
  assert.match(driverStore, /showAvailableEmptyState/);
  assert.match(driverStore, /driverStore\.noAvailableDrivers/);
  assert.doesNotMatch(driverStore, /selectStableDrivers\(categoryFilteredDrivers/);
  assert.doesNotMatch(driverStore, /selectUpdatableDrivers\(builtinDriverRows/);
  assert.equal([...driverStore.matchAll(/<DriverStoreAgentRow/g)].length, 3);
});

test("driver rows show a text Installed badge beside the name", () => {
  const row = source("apps/desktop/src/components/config/DriverStoreAgentRow.vue");

  assert.match(row, /driverStore\.installedBadge/);
  assert.match(row, /driver-store-installed-badge/);
  assert.match(row, /driver-store-agent-row--installed/);
  assert.match(row, /data-driver-store-focus/);
  assert.match(row, /driver-store-local-import-button/);
});
