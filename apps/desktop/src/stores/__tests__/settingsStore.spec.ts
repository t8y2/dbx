import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXECUTE_MODE_CURRENT_DEFAULT_VERSION, normalizeDesktopSettings, normalizeEditorSettings, normalizeMcpGlobalPolicy } from "@/stores/settingsStore";
import { createPinia, setActivePinia } from "pinia";
import type { AiConfigItem } from "@/types/ai";

describe("normalizeEditorSettings", () => {
  it("defaults SQL execution to the current statement and migrates legacy execute-all settings", () => {
    expect(normalizeEditorSettings({}).executeMode).toBe("current");
    expect(normalizeEditorSettings({ executeMode: "all" }).executeMode).toBe("current");
    expect(normalizeEditorSettings({ executeMode: "all", executeModeDefaultVersion: EXECUTE_MODE_CURRENT_DEFAULT_VERSION }).executeMode).toBe("all");
  });

  it("enables automatic table aliases by default", () => {
    expect(normalizeEditorSettings({}).autoAliasTables).toBe(true);
  });

  it("preserves disabled automatic table aliases", () => {
    expect(normalizeEditorSettings({ autoAliasTables: false }).autoAliasTables).toBe(false);
  });

  it("defaults sidebar connection sorting to manual order and preserves valid alphabetical modes", () => {
    expect(normalizeEditorSettings({}).sidebarConnectionSortMode).toBe("manual");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "asc" }).sidebarConnectionSortMode).toBe("asc");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "desc" }).sidebarConnectionSortMode).toBe("desc");
    expect(normalizeEditorSettings({ sidebarConnectionSortMode: "invalid" as any }).sidebarConnectionSortMode).toBe("manual");
  });

  it("shows the current statement frame by default", () => {
    expect(normalizeEditorSettings({}).showCurrentStatementFrame).toBe(true);
  });

  it("preserves disabled current statement frames", () => {
    expect(normalizeEditorSettings({ showCurrentStatementFrame: false }).showCurrentStatementFrame).toBe(false);
  });

  it("shows INSERT value column hints by default", () => {
    expect(normalizeEditorSettings({}).showInsertValueHints).toBe(true);
  });

  it("preserves disabled INSERT value column hints", () => {
    expect(normalizeEditorSettings({ showInsertValueHints: false }).showInsertValueHints).toBe(false);
  });

  it("keeps SQL semantic diagnostics in auto mode and disabled by default", () => {
    const settings = normalizeEditorSettings({});
    expect(settings.sqlSemanticDiagnosticsMode).toBe("auto");
    expect(settings.sqlSemanticDiagnosticsEnabled).toBe(false);
  });

  it("preserves explicit SQL semantic diagnostics modes", () => {
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsMode: "enabled" }).sqlSemanticDiagnosticsEnabled).toBe(true);
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsMode: "disabled" }).sqlSemanticDiagnosticsEnabled).toBe(false);
  });

  it("migrates legacy SQL semantic diagnostics booleans to explicit modes", () => {
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsEnabled: true } as any).sqlSemanticDiagnosticsMode).toBe("enabled");
    expect(normalizeEditorSettings({ sqlSemanticDiagnosticsEnabled: false } as any).sqlSemanticDiagnosticsMode).toBe("disabled");
  });

  it("defaults update downloads to the official source", () => {
    expect(normalizeEditorSettings({}).updateDownloadSource).toBe("official");
  });

  it("preserves explicit editor themes from saved settings", () => {
    expect(normalizeEditorSettings({ theme: "xcode" }).theme).toBe("xcode");
    expect(normalizeEditorSettings({ theme: "one-dark" }).theme).toBe("one-dark");
    expect(normalizeEditorSettings({ theme: "custom" }).theme).toBe("custom");
  });

  it("restores all open tabs on launch by default", () => {
    expect(normalizeEditorSettings({}).openTabsRestoreMode).toBe("all");
  });

  it("preserves explicit open tab restore modes", () => {
    expect(normalizeEditorSettings({ openTabsRestoreMode: "pinned" }).openTabsRestoreMode).toBe("pinned");
    expect(normalizeEditorSettings({ openTabsRestoreMode: "none" }).openTabsRestoreMode).toBe("none");
    expect(normalizeEditorSettings({ openTabsRestoreMode: "invalid" as any }).openTabsRestoreMode).toBe("all");
  });

  it("migrates legacy open tab restore booleans", () => {
    expect(normalizeEditorSettings({ restoreOpenTabsOnLaunch: false } as any).openTabsRestoreMode).toBe("none");
    expect(normalizeEditorSettings({ restoreOpenTabsOnLaunch: true } as any).openTabsRestoreMode).toBe("all");
  });

  it("preserves CNB, migrates AtomGit to CNB, and rejects invalid values", () => {
    expect(normalizeEditorSettings({ updateDownloadSource: "cnb" }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "atomgit" as any }).updateDownloadSource).toBe("cnb");
    expect(normalizeEditorSettings({ updateDownloadSource: "mirror" as any }).updateDownloadSource).toBe("official");
  });

  it("defaults data grid search to row filtering and preserves highlight mode", () => {
    expect(normalizeEditorSettings({}).dataGridSearchMode).toBe("filter");
    expect(normalizeEditorSettings({ dataGridSearchMode: "highlight" }).dataGridSearchMode).toBe("highlight");
    expect(normalizeEditorSettings({ dataGridSearchMode: "invalid" as any }).dataGridSearchMode).toBe("filter");
  });

  it("defaults persistent data grid view options off and preserves enabled values", () => {
    const defaults = normalizeEditorSettings({});
    expect(defaults.dataGridMultiRowTranspose).toBe(false);
    expect(defaults.dataGridHideNullColumns).toBe(false);

    const enabled = normalizeEditorSettings({ dataGridMultiRowTranspose: true, dataGridHideNullColumns: true });
    expect(enabled.dataGridMultiRowTranspose).toBe(true);
    expect(enabled.dataGridHideNullColumns).toBe(true);

    const invalid = normalizeEditorSettings({ dataGridMultiRowTranspose: "true" as any, dataGridHideNullColumns: 1 as any });
    expect(invalid.dataGridMultiRowTranspose).toBe(false);
    expect(invalid.dataGridHideNullColumns).toBe(false);
  });

  it("shows cell detail metadata by default and preserves collapsed state", () => {
    expect(normalizeEditorSettings({}).cellDetailMetadataCollapsed).toBe(false);
    expect(normalizeEditorSettings({ cellDetailMetadataCollapsed: true }).cellDetailMetadataCollapsed).toBe(true);
  });

  it("normalizes toolbar item settings from older saved settings", () => {
    const settings = normalizeEditorSettings({
      toolbarItems: {
        sqlFileTree: false,
        history: false,
      } as any,
    });

    expect(settings.toolbarItems.sqlFileTree).toBe(false);
    expect(settings.toolbarItems.history).toBe(false);
    expect(settings.toolbarItems.sqlLibrary).toBe(true);
  });
});

describe("normalizeDesktopSettings", () => {
  it("defaults DuckDB worker process isolation to disabled for old settings", () => {
    expect(normalizeDesktopSettings({}).duckdb_worker_process_isolation).toBe(false);
  });

  it("defaults DuckDB worker max processes to 4 and clamps saved values", () => {
    expect(normalizeDesktopSettings({}).duckdb_worker_max_processes).toBe(4);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 1 }).duckdb_worker_max_processes).toBe(1);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 16 }).duckdb_worker_max_processes).toBe(16);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 0 }).duckdb_worker_max_processes).toBe(1);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 32 }).duckdb_worker_max_processes).toBe(16);
    expect(normalizeDesktopSettings({ duckdb_worker_max_processes: 3.6 }).duckdb_worker_max_processes).toBe(4);
  });
});

describe("normalizeMcpGlobalPolicy", () => {
  it("defaults to all connections with writes allowed", () => {
    expect(normalizeMcpGlobalPolicy(undefined)).toEqual({
      readOnly: false,
      allowDangerousSql: false,
      allowedConnectionIds: null,
      configured: false,
    });
  });

  it("normalizes and deduplicates an explicit connection allowlist", () => {
    expect(
      normalizeMcpGlobalPolicy({
        readOnly: true,
        allowDangerousSql: true,
        allowedConnectionIds: [" connection-1 ", "connection-1", "", "connection-2"],
        configured: true,
      }),
    ).toEqual({
      readOnly: true,
      allowDangerousSql: true,
      allowedConnectionIds: ["connection-1", "connection-2"],
      configured: true,
    });
  });

  it("preserves an empty allowlist as deny all", () => {
    expect(normalizeMcpGlobalPolicy({ allowedConnectionIds: [] }).allowedConnectionIds).toEqual([]);
  });
});

describe("normalizeEditorSettings - continueOnErrorOnBatch", () => {
  it("defaults continueOnErrorOnBatch to false", () => {
    expect(normalizeEditorSettings({}).continueOnErrorOnBatch).toBe(false);
  });

  it("preserves enabled continueOnErrorOnBatch", () => {
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: true }).continueOnErrorOnBatch).toBe(true);
  });

  it("treats non-boolean values as false", () => {
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: "yes" } as any).continueOnErrorOnBatch).toBe(false);
    expect(normalizeEditorSettings({ continueOnErrorOnBatch: 1 } as any).continueOnErrorOnBatch).toBe(false);
  });
});

describe("normalizeEditorSettings - tabLayout", () => {
  it("defaults tabLayout to scroll", () => {
    expect(normalizeEditorSettings({}).tabLayout).toBe("scroll");
  });

  it("preserves explicit scroll mode", () => {
    expect(normalizeEditorSettings({ tabLayout: "scroll" }).tabLayout).toBe("scroll");
  });

  it("preserves explicit wrap mode", () => {
    expect(normalizeEditorSettings({ tabLayout: "wrap" }).tabLayout).toBe("wrap");
  });

  it("falls back to scroll for invalid values", () => {
    expect(normalizeEditorSettings({ tabLayout: "invalid" } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: undefined } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: null } as any).tabLayout).toBe("scroll");
    expect(normalizeEditorSettings({ tabLayout: 123 } as any).tabLayout).toBe("scroll");
  });
});

// --- Helpers for Pinia store tests ---

function makeTestConfig(overrides: Partial<AiConfigItem> & { id: string }): AiConfigItem {
  return {
    provider: "openai",
    apiKey: "",
    authMethod: "api-key",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiStyle: "completions",
    name: overrides.id,
    ...overrides,
  } as AiConfigItem;
}

describe("settingsStore MCP policy persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("rolls an optimistic policy update back when persistence fails", async () => {
    let rejectSave!: (reason?: unknown) => void;
    const saveMcpGlobalPolicy = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    vi.doMock("@/lib/backend/api", () => ({ saveMcpGlobalPolicy }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    const previous = {
      readOnly: true,
      allowDangerousSql: false,
      allowedConnectionIds: ["connection-1"],
      configured: true,
    };
    store.mcpGlobalPolicy = previous;

    const update = store.updateMcpGlobalPolicy({ readOnly: false, allowedConnectionIds: [] });
    expect(store.mcpGlobalPolicy).toEqual({
      readOnly: false,
      allowDangerousSql: false,
      allowedConnectionIds: [],
      configured: true,
    });

    rejectSave(new Error("save failed"));
    await expect(update).rejects.toThrow("save failed");
    expect(store.mcpGlobalPolicy).toEqual(previous);
  });
});

describe("settingsStore sidebar connection sort persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("persists the selected alphabetical sort mode", async () => {
    const saveEditorSettings = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/api", () => ({ saveEditorSettings }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.updateEditorSettings({ sidebarConnectionSortMode: "desc" });

    expect(store.editorSettings.sidebarConnectionSortMode).toBe("desc");
    expect(saveEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ sidebarConnectionSortMode: "desc" }));
  });
});

// --- activeModel lifecycle tests ---

describe("settingsStore activeModel lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it("updateActiveModel persists the model and does not change any config isDefault", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;

    store.updateActiveModel({ configId: "c1", modelId: "model-a" });
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });

    store.updateActiveModel({ configId: "c2", modelId: "model-b" });
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });

    // 核心保障：不改变任何配置的 isDefault
    expect(store.aiConfigs[0].isDefault).toBe(true);
    expect(store.aiConfigs[1].isDefault).toBe(false);
  });

  it("setDefaultAiConfig(id) on success points activeModel to the new default config", async () => {
    const setDefaultAiConfig = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      setDefaultAiConfig,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;

    // 先手动切到非默认的配置
    store.updateActiveModel({ configId: "c2", modelId: "model-b" });
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });

    await store.setDefaultAiConfig("c2");

    expect(setDefaultAiConfig).toHaveBeenCalledWith("c2");
    expect(store.aiConfigs[0].isDefault).toBe(false);
    expect(store.aiConfigs[1].isDefault).toBe(true);
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });
  });

  it("setDefaultAiConfig does not mutate state when backend call fails", async () => {
    const error = new Error("backend error");
    const setDefaultAiConfig = vi.fn().mockRejectedValue(error);

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
      setDefaultAiConfig,
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.aiConfigs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: true }), makeTestConfig({ id: "c2", model: "model-b", isDefault: false })];
    store.isAiConfigLoaded = true;
    store.updateActiveModel({ configId: "c1", modelId: "model-a" });

    await expect(store.setDefaultAiConfig("c2")).rejects.toThrow("backend error");

    // isDefault 不变
    expect(store.aiConfigs[0].isDefault).toBe(true);
    expect(store.aiConfigs[1].isDefault).toBe(false);
    // activeModel 不变
    expect(store.activeModel).toEqual({ configId: "c1", modelId: "model-a" });
  });

  it("reloadAiConfigs sets activeModel to null when config list is empty", async () => {
    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue([]),
      loadAiConfig: vi.fn().mockResolvedValue(null),
      loadAiProviderConfigs: vi.fn().mockResolvedValue(null),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.isAiConfigLoaded = false;
    await store.reloadAiConfigs();
    expect(store.activeModel).toBeNull();
  });

  it("reloadAiConfigs points activeModel to isDefault config, not first in list", async () => {
    const configs = [makeTestConfig({ id: "c1", model: "model-a", isDefault: false }), makeTestConfig({ id: "c2", model: "model-b", isDefault: true }), makeTestConfig({ id: "c3", model: "model-c", isDefault: false })];

    vi.doMock("@/lib/backend/api", () => ({
      loadAiConfigs: vi.fn().mockResolvedValue(configs),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    store.isAiConfigLoaded = false;
    await store.reloadAiConfigs();
    expect(store.activeModel).toEqual({ configId: "c2", modelId: "model-b" });
  });
});
