// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
let tauriRuntime = true;

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => tauriRuntime }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const BUILD = "0.6.67-beta.20261105.1";
const STORAGE_KEY = "dbx:promoted-build";

async function loadModule() {
  vi.resetModules();
  return import("../promotedBuild");
}

/** The publish path is fire-and-forget; let the dynamic import settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("promoted build reporting to the backend", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    tauriRuntime = true;
  });

  it("re-reports a remembered build on load so the native About panel stays correct", async () => {
    localStorage.setItem(STORAGE_KEY, BUILD);
    await loadModule();
    await flush();
    expect(invoke).toHaveBeenCalledWith("set_promoted_build", { buildVersion: BUILD });
  });

  it("stays silent on load when no promotion is remembered", async () => {
    await loadModule();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports once when an update check recognises a promotion", async () => {
    const { recordPromotedBuild } = await loadModule();
    recordPromotedBuild({ current_version: BUILD, promoted_from: BUILD });
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_promoted_build", { buildVersion: BUILD });

    // Re-recording the same build reports nothing new.
    recordPromotedBuild({ current_version: BUILD, promoted_from: BUILD });
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not report a manifest that names another build", async () => {
    const { recordPromotedBuild } = await loadModule();
    recordPromotedBuild({ current_version: BUILD, promoted_from: "0.6.67-beta.20261105.2" });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never reports outside the Tauri runtime", async () => {
    tauriRuntime = false;
    localStorage.setItem(STORAGE_KEY, BUILD);
    const { recordPromotedBuild } = await loadModule();
    recordPromotedBuild({ current_version: BUILD, promoted_from: BUILD });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
