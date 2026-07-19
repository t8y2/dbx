import assert from "node:assert/strict";
import { test } from "vitest";

import { canDownloadAndInstallUpdate, normalizeUpdateDownloadSource, resolveUpdateReleaseUrl, tagVersion } from "../../apps/desktop/src/composables/useAppUpdater.ts";
import type { UpdateInfo } from "../../apps/desktop/src/lib/backend/api.ts";

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

test("normalizes update download source", () => {
  assert.equal(normalizeUpdateDownloadSource("official"), "official");
  assert.equal(normalizeUpdateDownloadSource("cnb"), "cnb");
  assert.equal(normalizeUpdateDownloadSource("atomgit"), "cnb");
  assert.equal(normalizeUpdateDownloadSource("unknown"), "official");
});

test("normalizes release tag versions", () => {
  assert.equal(tagVersion("0.5.39"), "v0.5.39");
  assert.equal(tagVersion("v0.5.39"), "v0.5.39");
});

test("resolves release page URL from update download source", () => {
  const fallbackUrl = "https://github.com/t8y2/dbx/releases/latest";
  assert.equal(resolveUpdateReleaseUrl(updateInfo({ latest_version: "0.5.39" }), "cnb", fallbackUrl), "https://cnb.cool/dbxio.com/dbx/-/releases/tag/v0.5.39");
  assert.equal(resolveUpdateReleaseUrl(updateInfo({ release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.39" }), "official", fallbackUrl), "https://github.com/t8y2/dbx/releases/tag/v0.5.39");
  assert.equal(resolveUpdateReleaseUrl(null, "cnb", fallbackUrl), fallbackUrl);
});
