import assert from "node:assert/strict";
import test from "node:test";

import { canDownloadAndInstallUpdate } from "../../apps/desktop/src/composables/useAppUpdater.ts";
import type { UpdateInfo } from "../../apps/desktop/src/lib/api.ts";

function updateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current_version: "0.5.25",
    latest_version: "0.5.26",
    update_available: true,
    portable_mode: false,
    release_name: "DBX v0.5.26",
    release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.26",
    release_notes: "",
    ...overrides,
  };
}

test("allows in-app update installation for installed desktop builds", () => {
  assert.equal(canDownloadAndInstallUpdate(updateInfo(), true), true);
});

test("blocks in-app update installation for portable builds", () => {
  assert.equal(canDownloadAndInstallUpdate(updateInfo({ portable_mode: true }), true), false);
});

test("blocks in-app update installation outside desktop runtime or without an update", () => {
  assert.equal(canDownloadAndInstallUpdate(updateInfo(), false), false);
  assert.equal(canDownloadAndInstallUpdate(updateInfo({ update_available: false }), true), false);
  assert.equal(canDownloadAndInstallUpdate(null, true), false);
});
