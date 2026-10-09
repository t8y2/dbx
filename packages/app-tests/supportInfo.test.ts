import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildAppSupportInfoRows, formatAppSupportInfoForClipboard, formatSupportInfoOperatingSystem, normalizeSupportInfoVersion, windowsMarketingName } from "../../apps/desktop/src/lib/app/supportInfo.ts";
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

test("maps Windows kernel build to its marketing name", () => {
  assert.equal(windowsMarketingName("10.0.26200.9457"), "Windows 11");
  assert.equal(windowsMarketingName("10.0.22000.1"), "Windows 11");
  assert.equal(windowsMarketingName("10.0.19045.5011"), "Windows 10");
  assert.equal(windowsMarketingName("6.1.7601"), null);
  assert.equal(windowsMarketingName(""), null);
  assert.equal(windowsMarketingName("10.0"), null);
});

test("shows Windows marketing name while keeping the raw build for diagnostics", () => {
  assert.equal(
    formatSupportInfoOperatingSystem({ appVersion: "0.6.22", runtime: "desktop", osName: "Windows", osVersion: "10.0.26200.9457", arch: "x86_64" }, labels.unknown),
    "Windows 11 (10.0.26200.9457)",
  );
  assert.equal(
    formatSupportInfoOperatingSystem({ appVersion: "0.6.22", runtime: "desktop", osName: "Windows", osVersion: "10.0.19045.5011", arch: "x64" }, labels.unknown),
    "Windows 10 (10.0.19045.5011)",
  );
});

test("leaves non-10.0 Windows and other platforms unchanged", () => {
  assert.equal(
    formatSupportInfoOperatingSystem({ appVersion: "x", runtime: "desktop", osName: "Windows", osVersion: "6.1.7601", arch: "x86" }, labels.unknown),
    "Windows 6.1.7601",
  );
  assert.equal(
    formatSupportInfoOperatingSystem({ appVersion: "x", runtime: "desktop", osName: "macOS", osVersion: "15.5", arch: "aarch64" }, labels.unknown),
    "macOS 15.5",
  );
});
