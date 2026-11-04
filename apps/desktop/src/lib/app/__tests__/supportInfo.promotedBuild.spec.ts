// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSupportInfo } from "@/lib/backend/tauri";

const BUILD = "0.6.66-beta.20261104.1";
const labels = {
  appVersion: "DBX Version",
  runtime: "Runtime",
  runtimeDesktop: "Desktop",
  runtimeWeb: "Web",
  operatingSystem: "OS",
  architecture: "Arch",
  userAgent: "UA",
  databaseTypes: "DB",
  localDriverVersions: "Drivers",
  aiProviders: "AI",
  unknown: "Unknown",
};
const info: AppSupportInfo = { appVersion: BUILD, runtime: "desktop", osName: "macOS", osVersion: "15", arch: "arm64" };

async function loadModules() {
  vi.resetModules();
  return { promoted: await import("../promotedBuild"), support: await import("../supportInfo") };
}

describe("support info for a promoted build", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the raw build version before promotion is recognised", async () => {
    const { support } = await loadModules();
    expect(support.buildAppSupportInfoRows(info, labels)[0].value).toBe(`v${BUILD}`);
    expect(support.formatAppSupportInfoForClipboard(info, labels).split("\n")[0]).toBe(`DBX Version: v${BUILD}`);
  });

  it("shows the stable version in the row and keeps the exact build in the copied report", async () => {
    const { promoted, support } = await loadModules();
    promoted.recordPromotedBuild({ current_version: BUILD, promoted_from: BUILD });
    expect(support.buildAppSupportInfoRows(info, labels)[0].value).toBe("v0.6.66");
    expect(support.formatAppSupportInfoForClipboard(info, labels).split("\n")[0]).toBe(`DBX Version: v0.6.66 (${BUILD})`);
  });
});
