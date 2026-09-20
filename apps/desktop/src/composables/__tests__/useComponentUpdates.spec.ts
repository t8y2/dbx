import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComponentUpdates } from "@/composables/useComponentUpdates";
import { runPendingComponentUpdatePlan, type PendingComponentUpdates } from "@/lib/updates/componentUpdateOrchestration";

const mocks = vi.hoisted(() => ({
  listInstalledAgents: vi.fn(),
  jdbcPluginStatus: vi.fn(),
  checkMcpServerStatus: vi.fn(),
  listPlugins: vi.fn(),
  fetchPluginMarketplaceCatalogs: vi.fn(),
  checkAgentUpdateBlockers: vi.fn(),
  upgradeAllAgents: vi.fn(),
  installJdbcPlugin: vi.fn(),
  installMcpServer: vi.fn(),
  installMarketplacePlugin: vi.fn(),
  buildMarketplacePluginListings: vi.fn(),
}));

const settings = {
  editorSettings: {
    autoUpdateDrivers: true,
    autoUpdateJdbc: true,
    autoUpdateMcp: true,
    autoUpdatePlugins: true,
  },
};

vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => settings }));
vi.mock("@/i18n", () => ({ currentLocale: () => "zh-CN" }));
vi.mock("@/lib/plugins/pluginMarketplace", async (importOriginal) => ({ ...(await importOriginal<object>()), buildMarketplacePluginListings: mocks.buildMarketplacePluginListings }));

const mcpStatus = {
  installed: true,
  npm_available: true,
  current_version: "1.0.0",
  latest_version: "1.1.0",
  update_available: true,
};

const pluginUpdate = {
  status: "update",
  artifact: { target: "universal", url: "https://example.com/plugin.dbxp", sha256: "hash" },
  repository: { id: "official" },
  plugin: { id: "example", latestVersion: "1.1.0" },
  name: "Example plugin",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(settings.editorSettings, {
    autoUpdateDrivers: true,
    autoUpdateJdbc: true,
    autoUpdateMcp: true,
    autoUpdatePlugins: true,
  });
  mocks.listInstalledAgents.mockResolvedValue([{ db_type: "mysql", update_available: true }]);
  mocks.jdbcPluginStatus.mockResolvedValue({ installed: true, update_available: true });
  mocks.checkMcpServerStatus.mockResolvedValue(mcpStatus);
  mocks.listPlugins.mockResolvedValue([]);
  mocks.fetchPluginMarketplaceCatalogs.mockResolvedValue([]);
  mocks.buildMarketplacePluginListings.mockReturnValue([pluginUpdate]);
  mocks.checkAgentUpdateBlockers.mockResolvedValue([]);
  mocks.upgradeAllAgents.mockResolvedValue({ upgraded: 1, failed: [], cancelled: 0 });
  mocks.installJdbcPlugin.mockResolvedValue({ installed: true, update_available: false });
  mocks.installMcpServer.mockResolvedValue("updated");
  mocks.installMarketplacePlugin.mockResolvedValue({});
});

describe("useComponentUpdates", () => {
  it("counts agent, JDBC, MCP, and plugin updates", async () => {
    const updates = useComponentUpdates({ isDesktop: true });

    expect(await updates.refresh()).toBe(true);
    expect(updates.driverUpdateCount.value).toBe(1);
    expect(updates.jdbcUpdateAvailable.value).toBe(true);
    expect(updates.mcpUpdateAvailable.value).toBe(true);
    expect(updates.pluginUpdateCount.value).toBe(1);
    expect(updates.totalUpdateCount.value).toBe(4);
  });

  it("forces a fresh snapshot when a management surface changes during an in-flight refresh", async () => {
    const firstAgents = deferred<Array<{ db_type: string; update_available: boolean }>>();
    const secondAgents = deferred<Array<{ db_type: string; update_available: boolean }>>();
    mocks.listInstalledAgents.mockReturnValueOnce(firstAgents.promise).mockReturnValueOnce(secondAgents.promise);
    const updates = useComponentUpdates({ isDesktop: true });

    const initialRefresh = updates.refresh();
    await Promise.resolve();
    const forcedRefresh = updates.refresh({ force: true });
    await Promise.resolve();

    secondAgents.resolve([{ db_type: "mysql", update_available: false }]);
    expect(await forcedRefresh).toBe(true);
    firstAgents.resolve([{ db_type: "mysql", update_available: true }]);
    expect(await initialRefresh).toBe(false);

    expect(mocks.listInstalledAgents).toHaveBeenCalledTimes(2);
    expect(updates.driverUpdateCount.value).toBe(0);
  });

  it("clears driver and MCP update state after a successful update and refresh", async () => {
    mocks.listInstalledAgents.mockResolvedValueOnce([{ db_type: "mysql", update_available: true }]).mockResolvedValueOnce([{ db_type: "mysql", update_available: false }]);
    mocks.checkMcpServerStatus.mockResolvedValueOnce(mcpStatus).mockResolvedValueOnce({ ...mcpStatus, latest_version: "1.0.0", update_available: false });
    const updates = useComponentUpdates({ isDesktop: true });

    await updates.installCategories(["drivers", "mcp"]);

    expect(mocks.upgradeAllAgents).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(updates.driverUpdateCount.value).toBe(0);
    expect(updates.mcpUpdateAvailable.value).toBe(false);
  });

  it("installs every enabled component category after an app update", async () => {
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.autoUpdateEnabledComponents();

    expect(mocks.checkAgentUpdateBlockers).toHaveBeenCalledWith(["mysql"]);
    expect(mocks.upgradeAllAgents).toHaveBeenCalledOnce();
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledWith({ repositoryId: "official", pluginId: "example", version: "1.1.0" });
    expect(result).toEqual({ drivers: 1, jdbc: true, mcp: true, plugins: 1, skippedDrivers: 0, failed: [] });
  });

  it("shares one update operation between automatic and manual callers", async () => {
    const jdbcInstall = deferred<{ installed: boolean; update_available: boolean }>();
    mocks.installJdbcPlugin.mockReturnValue(jdbcInstall.promise);
    const updates = useComponentUpdates({ isDesktop: true });

    const automatic = updates.autoUpdateEnabledComponents();
    await vi.waitFor(() => expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce());
    const manual = updates.installCategory("jdbc");

    expect(updates.updating.value).toBe(true);
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();

    jdbcInstall.resolve({ installed: true, update_available: false });
    const [automaticResult, manualResult] = await Promise.all([automatic, manual]);

    expect(manualResult).toEqual(automaticResult);
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledOnce();
    expect(updates.updating.value).toBe(false);
  });

  it("still detects updates but does not install disabled categories", async () => {
    Object.assign(settings.editorSettings, {
      autoUpdateDrivers: false,
      autoUpdateJdbc: false,
      autoUpdateMcp: false,
      autoUpdatePlugins: false,
    });
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.autoUpdateEnabledComponents();

    expect(updates.totalUpdateCount.value).toBe(4);
    expect(mocks.upgradeAllAgents).not.toHaveBeenCalled();
    expect(mocks.installJdbcPlugin).not.toHaveBeenCalled();
    expect(mocks.installMcpServer).not.toHaveBeenCalled();
    expect(mocks.installMarketplacePlugin).not.toHaveBeenCalled();
    expect(result).toEqual({ drivers: 0, jdbc: false, mcp: false, plugins: 0, skippedDrivers: 0, failed: [] });
  });

  it("installs every manually selected category when no DBX update exists and automatic updates are disabled", async () => {
    Object.assign(settings.editorSettings, {
      autoUpdateDrivers: false,
      autoUpdateJdbc: false,
      autoUpdateMcp: false,
      autoUpdatePlugins: false,
    });
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.installCategories(["drivers", "jdbc", "mcp", "plugins"]);

    expect(mocks.upgradeAllAgents).toHaveBeenCalledOnce();
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledOnce();
    expect(result).toEqual({ drivers: 1, jdbc: true, mcp: true, plugins: 1, skippedDrivers: 0, failed: [] });
  });

  it("resumes a persisted manual update-all plan after restart while automatic updates are disabled", async () => {
    Object.assign(settings.editorSettings, {
      autoUpdateDrivers: false,
      autoUpdateJdbc: false,
      autoUpdateMcp: false,
      autoUpdatePlugins: false,
    });
    const updates = useComponentUpdates({ isDesktop: true });
    const pending: PendingComponentUpdates = {
      fromVersion: "0.6.16",
      targetVersion: "0.6.17",
      plan: { kind: "manual", categories: ["drivers", "jdbc", "mcp", "plugins"] },
    };

    const result = await runPendingComponentUpdatePlan(pending, updates);

    expect(mocks.upgradeAllAgents).toHaveBeenCalledOnce();
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledOnce();
    expect(result).toEqual({ drivers: 1, jdbc: true, mcp: true, plugins: 1, skippedDrivers: 0, failed: [] });
  });

  it("skips blocked agent updates while allowing other component updates", async () => {
    mocks.checkAgentUpdateBlockers.mockResolvedValue([{ db_type: "mysql", label: "MySQL" }]);
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.autoUpdateEnabledComponents();

    expect(mocks.upgradeAllAgents).not.toHaveBeenCalled();
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).toHaveBeenCalledOnce();
    expect(result.skippedDrivers).toBe(1);
  });

  it("does not install from stale state when update detection fails", async () => {
    mocks.listInstalledAgents.mockRejectedValue(new Error("registry unavailable"));
    mocks.jdbcPluginStatus.mockRejectedValue(new Error("JDBC registry unavailable"));
    mocks.checkMcpServerStatus.mockRejectedValue(new Error("MCP registry unavailable"));
    mocks.listPlugins.mockRejectedValue(new Error("plugin store unavailable"));
    mocks.fetchPluginMarketplaceCatalogs.mockRejectedValue(new Error("catalog unavailable"));
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.autoUpdateEnabledComponents();

    expect(result.failed).toEqual(["drivers: registry unavailable; JDBC: JDBC registry unavailable; MCP: MCP registry unavailable; plugins: plugin store unavailable; plugin catalog: catalog unavailable"]);
    expect(mocks.upgradeAllAgents).not.toHaveBeenCalled();
    expect(mocks.installJdbcPlugin).not.toHaveBeenCalled();
    expect(mocks.installMcpServer).not.toHaveBeenCalled();
    expect(mocks.installMarketplacePlugin).not.toHaveBeenCalled();
  });

  it("continues independent updates when the plugin catalog is unavailable", async () => {
    mocks.fetchPluginMarketplaceCatalogs.mockRejectedValue(new Error("catalog unavailable"));
    const updates = useComponentUpdates({ isDesktop: true });

    const result = await updates.autoUpdateEnabledComponents();

    expect(mocks.upgradeAllAgents).toHaveBeenCalledOnce();
    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(mocks.installMcpServer).toHaveBeenCalledOnce();
    expect(mocks.installMarketplacePlugin).not.toHaveBeenCalled();
    expect(result.failed).toEqual(["plugin catalog: catalog unavailable"]);
  });

  it("allows a category to be installed manually even when automatic updates are disabled", async () => {
    Object.assign(settings.editorSettings, {
      autoUpdateDrivers: false,
      autoUpdateJdbc: false,
      autoUpdateMcp: false,
      autoUpdatePlugins: false,
    });
    const updates = useComponentUpdates({ isDesktop: true });
    await updates.refresh();

    const result = await updates.installCategory("jdbc");

    expect(mocks.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(result).toEqual({ drivers: 0, jdbc: true, mcp: false, plugins: 0, skippedDrivers: 0, failed: [] });
  });
});
