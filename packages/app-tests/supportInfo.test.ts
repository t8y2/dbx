import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildAppSupportInfoRows, formatAppSupportInfoForClipboard, normalizeSupportInfoVersion } from "../../apps/desktop/src/lib/app/supportInfo.ts";
import type { AppSupportInfoLabels } from "../../apps/desktop/src/lib/app/supportInfo.ts";
import type { AppSupportInfo } from "../../apps/desktop/src/lib/backend/tauri.ts";

const labels: AppSupportInfoLabels = {
  appVersion: "DBX Version",
  runtime: "Runtime",
  runtimeDesktop: "Desktop",
  runtimeWeb: "Web",
  operatingSystem: "Operating System",
  architecture: "Architecture",
  unknown: "Unknown",
};

test("normalizes support info versions with a single v prefix", () => {
  assert.equal(normalizeSupportInfoVersion("0.5.50", labels.unknown), "v0.5.50");
  assert.equal(normalizeSupportInfoVersion("v0.5.50", labels.unknown), "v0.5.50");
  assert.equal(normalizeSupportInfoVersion("V0.5.50", labels.unknown), "v0.5.50");
});

test("support info rows use stable fallback values", () => {
  const info: AppSupportInfo = {
    appVersion: "",
    runtime: "desktop",
    osName: "",
    osVersion: null,
    arch: "",
  };

  assert.deepEqual(
    buildAppSupportInfoRows(info, labels).map((row) => row.value),
    ["Unknown", "Desktop", "Unknown", "Unknown"],
  );
});

test("formats support info clipboard text in stable issue-friendly order", () => {
  const info: AppSupportInfo = {
    appVersion: "0.5.50",
    runtime: "desktop",
    osName: "macOS",
    osVersion: "15.5",
    arch: "aarch64",
  };

  assert.equal(
    formatAppSupportInfoForClipboard(info, labels),
    ["DBX Version: v0.5.50", "Runtime: Desktop", "Operating System: macOS 15.5", "Architecture: aarch64"].join("\n"),
  );
});
