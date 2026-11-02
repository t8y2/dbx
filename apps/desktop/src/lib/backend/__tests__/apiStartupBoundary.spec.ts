import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsImported: vi.fn(),
  migrationStatus: vi.fn(),
  listInstalledAgents: vi.fn(),
  installAgent: vi.fn(),
  upgradeAllAgents: vi.fn(),
  reinstallJre: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/tauri", () => mocks);
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn() }));

const settings = { editorSettings: { updateDownloadSource: "github" } };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  settings.editorSettings.updateDownloadSource = "github";
  vi.doMock("@/stores/settingsStore", () => {
    mocks.settingsImported();
    return { useSettingsStore: () => settings };
  });
});

describe("startup API dependency boundary", () => {
  it("does not import the business settings store for migration preflight", async () => {
    mocks.migrationStatus.mockResolvedValue({ state: "not_required" });
    const api = await import("../api");
    await expect(api.migrationStatus()).resolves.toEqual({ state: "not_required" });
    expect(mocks.settingsImported).not.toHaveBeenCalled();
  });

  it("continues using the current configured source for agent operations", async () => {
    const api = await import("../api");
    await api.listInstalledAgents();
    expect(mocks.listInstalledAgents).toHaveBeenCalledWith("github");
    settings.editorSettings.updateDownloadSource = "cloudflare";
    await api.installAgent("mysql", "install-1");
    await api.upgradeAllAgents("upgrade-1");
    await api.reinstallJre("java-21", "jre-1");
    expect(mocks.installAgent).toHaveBeenCalledWith("mysql", "cloudflare", "install-1");
    expect(mocks.upgradeAllAgents).toHaveBeenCalledWith("cloudflare", "upgrade-1");
    expect(mocks.reinstallJre).toHaveBeenCalledWith("java-21", "cloudflare", "jre-1");
    expect(mocks.settingsImported).toHaveBeenCalledTimes(1);
  });
});
