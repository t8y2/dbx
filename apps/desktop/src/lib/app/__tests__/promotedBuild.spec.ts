// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const BUILD = "0.6.66-beta.20261104.1";

async function loadModule() {
  vi.resetModules();
  return import("../promotedBuild");
}

describe("promoted build recognition", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the build version until an update check proves it was promoted", async () => {
    const { displayAppVersion } = await loadModule();
    expect(displayAppVersion(BUILD)).toBe(BUILD);
  });

  it("shows the stable version once the manifest names the running build", async () => {
    const { displayAppVersion, recordPromotedBuild } = await loadModule();
    recordPromotedBuild({ current_version: BUILD, promoted_from: BUILD });
    expect(displayAppVersion(BUILD)).toBe("0.6.66");
  });

  it("does not recognise a different beta build of the same release line", async () => {
    const { displayAppVersion, recordPromotedBuild } = await loadModule();
    const other = "0.6.66-beta.20261104.2";
    recordPromotedBuild({ current_version: other, promoted_from: BUILD });
    expect(displayAppVersion(other)).toBe(other);
    expect(displayAppVersion(BUILD)).toBe(BUILD);
  });

  it("ignores manifests that do not record a promotion source", async () => {
    const { displayAppVersion, recordPromotedBuild } = await loadModule();
    recordPromotedBuild({ current_version: BUILD });
    recordPromotedBuild({ current_version: BUILD, promoted_from: "" });
    expect(displayAppVersion(BUILD)).toBe(BUILD);
  });

  it("survives a restart and stops applying after an upgrade", async () => {
    const first = await loadModule();
    first.recordPromotedBuild({ current_version: BUILD, promoted_from: `v${BUILD}` });

    const restarted = await loadModule();
    expect(restarted.displayAppVersion(BUILD)).toBe("0.6.66");
    expect(restarted.displayAppVersion("0.6.67")).toBe("0.6.67");
  });
});
