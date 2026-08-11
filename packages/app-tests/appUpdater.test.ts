import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { canDownloadAndInstallUpdate, isUpdateIgnored, normalizeUpdateDownloadSource, resolveUpdateReleaseUrl, tagVersion } from "../../apps/desktop/src/composables/useAppUpdater.ts";
import { downloadAndInstallUpdateWhenIdle, installDownloadedUpdateWhenIdle } from "../../apps/desktop/src/lib/app/appUpdateInstallFlow.ts";
import { countActiveUpdateBlockingTasks, shouldBlockAppUpdate } from "../../apps/desktop/src/lib/app/appUpdateTaskGuard.ts";
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

test("allows portable builds to use the portable update installer", () => {
  assert.equal(canDownloadAndInstallUpdate(updateInfo({ portable_mode: true }), true), true);
});

test("blocks in-app update installation outside desktop runtime or without an update", () => {
  assert.equal(canDownloadAndInstallUpdate(updateInfo(), false), false);
  assert.equal(canDownloadAndInstallUpdate(updateInfo({ update_available: false }), true), false);
  assert.equal(canDownloadAndInstallUpdate(null, true), false);
});

test("keeps the ignored state for the same or an older stable version", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.26" }), "0.5.26"), true);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.25" }), "0.5.26"), true);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.27" }), "0.5.26"), false);
});

test("keeps the ignored state when an update source lags behind", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.69" }), "0.5.70"), true);
});

test("does not ignore updates when the stored version is absent", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.26" }), ""), false);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.26" }), undefined), false);
  assert.equal(isUpdateIgnored(null, "0.5.26"), false);
});

test("normalizes v-prefixed ignored versions before comparing", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "0.5.26" }), "v0.5.26"), true);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: " v0.5.26 " }), " 0.5.26 "), true);
});

test("uses SemVer precedence for prereleases and ignores build metadata", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "1.0.0-beta.1" }), "1.0.0-beta.2"), true);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "1.0.0-beta.11" }), "1.0.0-beta.2"), false);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "1.0.0" }), "1.0.0-rc.1"), false);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "1.0.0+mirror.2" }), "1.0.0+github.1"), true);
});

test("falls back conservatively when either version is not valid SemVer", () => {
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "release-next" }), "vrelease-next"), true);
  assert.equal(isUpdateIgnored(updateInfo({ latest_version: "release-next" }), "release-later"), false);
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

test("counts background and query tasks that must finish before updating", () => {
  assert.equal(countActiveUpdateBlockingTasks(2, [{ isExecuting: true }, { explainExecutionId: "explain-1" }, { isExecuting: true, explainExecutionId: "explain-2" }, { isExecuting: false, explainExecutionId: "" }]), 5);
  assert.equal(countActiveUpdateBlockingTasks(-1, []), 0);
  assert.equal(shouldBlockAppUpdate(0), false);
  assert.equal(shouldBlockAppUpdate(1), true);
});

test("retains a downloaded update when a task starts during download and installs it later without downloading again", async () => {
  let activeTaskCount = 0;
  let downloadCount = 0;
  let installCount = 0;
  let finishDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  const operations = {
    getActiveTaskCount: () => activeTaskCount,
    download: async () => {
      downloadCount += 1;
      await downloadGate;
    },
    install: async () => {
      installCount += 1;
    },
  };

  const firstAttempt = downloadAndInstallUpdateWhenIdle(operations);
  assert.equal(downloadCount, 1);
  assert.equal(installCount, 0);

  activeTaskCount = 1;
  finishDownload();
  assert.equal(await firstAttempt, "downloaded");
  assert.equal(installCount, 0);

  activeTaskCount = 0;
  assert.equal(await installDownloadedUpdateWhenIdle(operations), true);
  assert.equal(downloadCount, 1);
  assert.equal(installCount, 1);
});

test("wires the active task guard into update installation and restart", () => {
  const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");
  const updaterSource = readFileSync("apps/desktop/src/composables/useAppUpdater.ts", "utf8");
  const dialogSource = readFileSync("apps/desktop/src/components/layout/UpdateDialog.vue", "utf8");

  assert.match(appSource, /countActiveUpdateBlockingTasks\(activeBackgroundTaskCount\.value, queryStore\.tabs\)/);
  assert.match(appSource, /getActiveTaskCount: \(\) => trackedUpdateTaskCount\.value/);
  assert.equal(updaterSource.match(/if \(blockUpdateForActiveTasks\(\)\) return;/g)?.length, 2);
  assert.match(dialogSource, /role="alert"[\s\S]*updates\.activeTasksBlockUpdate/);
  assert.equal(dialogSource.match(/:disabled="activeTaskCount > 0"/g)?.length, 3);
  assert.match(dialogSource, /ignore-version/);
  assert.match(updaterSource, /ignoreCurrentVersion/);
});
