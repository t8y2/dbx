import ts from "typescript";
import { computed, ref, shallowRef, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import dialogSource from "../EditorSettingsDialog.vue?raw";
import { DEFAULT_DESKTOP_SETTINGS, DEFAULT_SIDEBAR_TABLE_PAGE_SIZE, normalizeMcpGlobalPolicy, type McpGlobalPolicy } from "@/stores/settingsStore";
import { shouldConfirmEditorSettingsDialogClose } from "@/lib/settings/editorSettingsDraft";
import { mergeMcpToolsetSelection, setMcpCategoryEnabled, setMcpToolsEnabled, setMcpToolsetEnabled, type McpCapabilityCategoryId } from "@/lib/mcp/mcpToolCatalog";
import { addMcpAllowedToolName, MCP_PLUGIN_TOOLS_WILDCARD, mcpExecutionModeFromPolicy, mcpPolicyFieldsForExecutionMode, type McpExecutionMode } from "@/lib/mcp/mcpPolicySelection";
import { editableDatabaseAccess, mergeDatabaseAccess, type McpDatabaseAccess } from "@/lib/mcp/mcpDatabaseAccess";
import { buildMcpAccessTreeRows } from "@/lib/mcp/mcpAccessTree";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";
import type { McpAccessPolicy, McpToolCatalog, McpToolCatalogToolset, PluginMcpGrant, PluginMcpView } from "@/types/mcpCatalog";

// Run the actual dialog handlers and Apply/Discard path without mounting the
// unrelated editors, charts and plugin workbenches in the settings dialog.
// Only external persistence and non-MCP settings dependencies are replaced.
const script = dialogSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("EditorSettingsDialog script setup was not found");
const source = ts.createSourceFile("EditorSettingsDialog.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function declaration(name: string): string {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(source);
    if (ts.isVariableStatement(statement)) {
      const target = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
      if (target) return `const ${target.getText(source)};`;
    }
  }
  throw new Error(`Missing real settings declaration: ${name}`);
}

const exposedNames = [
  "mcpAccessPolicy",
  "mcpAccessPolicyError",
  "mcpAccessPolicyLoading",
  "mcpPolicyRecovering",
  "mcpPolicyRecoveryConfirmation",
  "recoverMcpAccessPolicy",
  "mcpInstalledPluginsForScopes",
  "loadMcpPluginScopeContext",
  "mcpPolicyConfirmation",
  "confirmMcpPolicyChange",
  "onMcpPolicyConfirmationOpenChange",
  "onMcpTreeScopeMode",
  "onMcpTreeDatabaseScope",
  "onMcpTreeDatabaseAllowed",
  "onMcpExecutionModeChange",
  "onMcpHighRiskConfirmationChange",
  "onMcpGroupExecutionModeChange",
  "onMcpConnectionExecutionModeChange",
  "onMcpDatabaseExecutionModeChange",
  "stageMcpPolicy",
  "mcpPolicyDraft",
  "mcpPolicyBaseline",
  "mcpPolicySaving",
  "mcpToolCatalog",
  "mcpToolCatalogLoading",
  "mcpToolCatalogError",
  "mcpPluginViews",
  "mcpPluginViewsLoading",
  "mcpPluginViewsError",
  "loadMcpPluginViews",
  "showUnsavedSettingsCloseConfirm",
  "cancelUnsavedSettingsClose",
  "onMcpCategoryAllowedChange",
  "onMcpToolAllowedChange",
  "onMcpToolsetAllowedChange",
  "applyMcpToolset",
  "loadMcpTreeDatabases",
  "applyMcpDatabaseAccess",
  "onMcpDatabaseAccessChange",
  "mcpPolicyHasUnsavedChanges",
  "requestCloseSettings",
  "discardUnsavedSettingsAndClose",
  "applySettingsForResult",
  "applySettingsAndClose",
  "persistMcpPluginGrant",
  "mcpCustomToolInput",
  "onMcpCustomToolAdd",
];
const declarationNames = [
  ...exposedNames,
  "mcpDatabaseEditedOverrides",
  "mcpPluginScopeLoadRevision",
  "pendingMcpCallHistory",
  "requestMcpPolicyConfirmation",
  "mcpTreeConnectionRule",
  "stageMcpTreeConnectionRule",
  "requestMcpCallHistory",
  "finishSettingsClose",
  "mcpExecutionMode",
  "mcpConnectionPolicyIsMeaningful",
  "migrateLegacyMcpConnectionPolicy",
  "mcpConnectionExecutionMode",
  "mcpInheritedGroupExecutionMode",
  "mcpInheritedGroupPolicy",
  "mcpGroupExecutionMode",
  "mcpExecutionModeRank",
  "mcpPluginViewRevisions",
  "mcpPluginSavingIds",
  "mcpAllowedToolNames",
  "mcpCatalogControlsDisabled",
  "mcpPoliciesEqual",
  "syncMcpPolicyBaseline",
  "stageMcpQueryTimeoutDraft",
  "commitMcpPolicyDraft",
  "persistSettings",
  "applySettingsErrorToast",
  "closeSettings",
  "onMcpPluginViewSaved",
];
const compiledHandlers = ts.transpileModule(declarationNames.map(declaration).join("\n"), {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;
const historyClick = dialogSource.match(/data-mcp-open-call-history\s+@click="([^"]+)"/)?.[1];
if (!historyClick) throw new Error("MCP history button handler was not found");

function toolset(id: string, names: string[]): McpToolCatalogToolset {
  return { id, provider: `builtin:${id.split(".")[0]}`, resourceKinds: [], scopeKinds: [], tools: names.map((name) => ({ name, access: "read", accessMode: "static", coverageKind: "none", databaseTypes: [], description: "", parameters: [] })) };
}

const catalog: McpToolCatalog = { toolsets: [toolset("sql.query", ["dbx_execute_query", "dbx_future_query"]), toolset("nacos.config", ["dbx_nacos_get_config", "dbx_nacos_publish_config"]), toolset("nacos.service", ["dbx_nacos_list_services"]), toolset("admin.connections", ["dbx_add_connection"])] };

const plugin: PluginMcpView = {
  pluginId: "io.dbx.helper",
  pluginName: "Helper",
  version: "1.0.0",
  authorAllowsExternal: true,
  hasSavedGrant: true,
  grant: { external: false, ceiling: "read", approvedTools: { dbx_helper__inspect: "read" }, disabledTools: [] },
  toolsets: [{ id: "default", title: null, description: null }],
  tools: [],
  discoveryError: null,
};

interface SettingsHarness {
  mcpAccessPolicyError: Ref<string>;
  mcpAccessPolicyLoading: Ref<boolean>;
  mcpPolicyRecovering: Ref<boolean>;
  mcpPolicyRecoveryConfirmation: Ref<boolean>;
  recoverMcpAccessPolicy: () => Promise<void>;
  mcpAccessPolicy: Ref<McpAccessPolicy | null>;
  mcpInstalledPluginsForScopes: Ref<Array<{ manifest: { id: string } }>>;
  loadMcpPluginScopeContext: () => Promise<void>;
  mcpPolicyConfirmation: Ref<{ message: string; apply: () => void } | null>;
  confirmMcpPolicyChange: () => void | Promise<void>;
  onMcpPolicyConfirmationOpenChange: (open: boolean) => void;
  onMcpTreeScopeMode: (mode: "all" | "custom") => void;
  onMcpTreeDatabaseScope: (id: string, scope: "all" | "selected" | "none") => void;
  onMcpTreeDatabaseAllowed: (id: string, database: string, allowed: boolean) => void;
  onMcpExecutionModeChange: (mode: McpExecutionMode) => void;
  onMcpHighRiskConfirmationChange: (enabled: boolean) => void;
  onMcpGroupExecutionModeChange: (id: string, mode: McpExecutionMode | "inherit") => void;
  onMcpConnectionExecutionModeChange: (id: string, mode: McpExecutionMode | "inherit") => void;
  onMcpDatabaseExecutionModeChange: (id: string, database: string, mode: McpExecutionMode | "inherit") => void;
  stageMcpPolicy: (patch: Partial<McpGlobalPolicy>) => void;
  mcpPolicyDraft: Ref<McpGlobalPolicy>;
  mcpPolicyBaseline: Ref<McpGlobalPolicy>;
  mcpPolicySaving: Ref<boolean>;
  mcpToolCatalog: Ref<McpToolCatalog | null>;
  mcpToolCatalogLoading: Ref<boolean>;
  mcpToolCatalogError: Ref<string>;
  mcpPluginViews: Ref<PluginMcpView[] | null>;
  mcpPluginViewsLoading: Ref<boolean>;
  mcpPluginViewsError: Ref<string>;
  loadMcpPluginViews: () => Promise<void>;
  showUnsavedSettingsCloseConfirm: Ref<boolean>;
  cancelUnsavedSettingsClose: () => void;
  clickMcpCallHistory: () => void;
  onMcpCategoryAllowedChange: (id: McpCapabilityCategoryId, enabled: boolean) => void;
  onMcpToolAllowedChange: (name: string, enabled: boolean) => void;
  onMcpToolsetAllowedChange: (toolset: McpToolCatalogToolset, enabled: boolean) => void;
  applyMcpToolset: (toolsetId: string) => Promise<void>;
  loadMcpTreeDatabases: (connection: ConnectionConfig) => Promise<string[]>;
  applyMcpDatabaseAccess: (id: string) => Promise<void>;
  onMcpDatabaseAccessChange: (id: string, access: McpDatabaseAccess) => void;
  mcpPolicyHasUnsavedChanges: () => boolean;
  requestCloseSettings: (open: boolean) => void;
  discardUnsavedSettingsAndClose: () => void;
  applySettingsForResult: () => Promise<boolean>;
  applySettingsAndClose: () => Promise<void>;
  persistMcpPluginGrant: (id: string, grant: PluginMcpGrant, approveCurrent: boolean) => Promise<PluginMcpView>;
  mcpCustomToolInput: Ref<string>;
  onMcpCustomToolAdd: () => void;
}

function createHarness(initial: Partial<McpGlobalPolicy> = {}) {
  const loadMcpAccessPolicy = vi.fn(async (): Promise<McpAccessPolicy> => ({ version: 2, defaultAccess: "read", rules: [] }));
  const resetInvalidMcpAccessPolicy = vi.fn(async () => {});
  const listPlugins = vi.fn(async (): Promise<Array<{ manifest: { id: string } }>> => []);
  const persistedPlugin = ref<PluginMcpView>(structuredClone(plugin));
  const listPluginMcpViews = vi.fn(async () => [structuredClone(plugin)]);
  const savePluginMcpGrant = vi.fn(async (_id: string, grant: PluginMcpGrant, _approveCurrent: boolean) => {
    const next = { ...structuredClone(plugin), grant: structuredClone(grant) };
    persistedPlugin.value = next;
    return next;
  });
  const settingsStore = {
    mcpGlobalPolicy: normalizeMcpGlobalPolicy(initial),
    editorSettings: { sidebarObjectDisplay: "all" },
    desktopSettings: { ...DEFAULT_DESKTOP_SETTINGS },
    initMcpGlobalPolicy: vi.fn(async () => {}),
    updateDesktopSettings: vi.fn(async (patch: object) => {
      Object.assign(settingsStore.desktopSettings, patch);
    }),
    updateMcpGlobalPolicy: vi.fn(async (patch: Partial<McpGlobalPolicy>) => {
      settingsStore.mcpGlobalPolicy = normalizeMcpGlobalPolicy({ ...settingsStore.mcpGlobalPolicy, ...patch, configured: true });
    }),
  };
  const databaseNames = Array.from({ length: 260 }, (_, index) => `db_${index}`);
  const listMcpTreeDatabases = vi.fn(async () => databaseNames.map((name) => ({ name })));
  const mongoListMcpTreeDatabases = vi.fn(async () => databaseNames);
  const redisListMcpTreeDatabases = vi.fn(async () => databaseNames.map((_, db) => ({ db })));
  const ensureConnected = vi.fn(async () => {});
  const emit = vi.fn();
  const toast = vi.fn();
  const confirm = vi.fn(() => true);
  const openMcpCallHistory = vi.fn();
  const context = {
    ref,
    shallowRef,
    computed,
    settingsStore,
    normalizeMcpGlobalPolicy,
    mcpExecutionModeFromPolicy,
    mcpPolicyFieldsForExecutionMode,
    window: { confirm },
    mcpConnectionGroupIdPaths: ref(new Map()),
    mcpGroupRows: ref([]),
    setMcpCategoryEnabled,
    setMcpToolsEnabled,
    setMcpToolsetEnabled,
    mergeMcpToolsetSelection,
    listMcpTreeDatabases,
    mongoListMcpTreeDatabases,
    redisListMcpTreeDatabases,
    editableDatabaseAccess,
    mergeDatabaseAccess,
    mcpSelectableConnections: ref([
      { id: "c1", name: "First", db_type: "mysql" },
      { id: "c2", name: "Second", db_type: "mysql" },
    ] as ConnectionConfig[]),
    addMcpAllowedToolName,
    savePluginMcpGrant,
    listPluginMcpViews,
    loadMcpAccessPolicy,
    resetInvalidMcpAccessPolicy,
    listPlugins,
    shouldConfirmEditorSettingsDialogClose,
    emit,
    openMcpCallHistory,
    toast,
    t: (key: string) => key,
    mcpPolicyControlsDisabled: ref(false),
    mcpPolicyLoadError: ref(""),
    hasApplyBlocker: ref(false),
    historyRetention: { save: vi.fn(async () => {}) },
    mcpHistoryRetention: { save: vi.fn(async () => {}) },
    editorSettingsPatchFromDraft: () => ({}),
    currentEditorSettingsDraft: () => ({}),
    editEditorSettingsBase: ref({}),
    editSidebarTablePageSize: ref(DEFAULT_SIDEBAR_TABLE_PAGE_SIZE),
    DEFAULT_SIDEBAR_TABLE_PAGE_SIZE,
    editMetadataCacheMaxMemoryMb: ref(DEFAULT_DESKTOP_SETTINGS.metadata_cache_max_memory_mb),
    normalizeMetadataCacheMemoryMb: (value: number) => value,
    editShowTrayIcon: ref(false),
    editLinuxFloatingFrameEnabled: ref(DEFAULT_DESKTOP_SETTINGS.linux_floating_frame_enabled ?? true),
    editQuitOnClose: ref(false),
    desktopCloseBehaviorResetPending: ref(false),
    editIconTheme: ref("default"),
    editDebugLoggingEnabled: ref(false),
    editDuckDbWorkerProcessIsolation: ref(false),
    editDuckDbWorkerMaxProcesses: ref(4),
    normalizeDuckDbWorkerMaxProcesses: (value: number) => value,
    hasImportedSettingsPendingApply: ref(false),
    connectionStore: { ensureConnected, sidebarLayout: { groups: [], order: [] } as SidebarLayout, refreshAllTree: vi.fn(), refreshSidebarObjectPagination: vi.fn() },
  };
  const factory = new Function(
    ...Object.keys(context),
    `
    let mcpLastCustomScope = null;
    let mcpQueryTimeoutPendingValue;
    let mcpQueryTimeoutSaveTimer = null;
    const mcpQueryTimeoutInput = ref("");
    let pendingBackgroundImageCleanup = null;
    function hasChanges() { return mcpPolicyHasUnsavedChanges(); }
    ${compiledHandlers}
    return { ${exposedNames.join(",")}, clickMcpCallHistory: () => { ${historyClick} } };
  `,
  );
  const handlers = factory(...Object.values(context)) as SettingsHarness;
  handlers.mcpToolCatalog.value = catalog;
  handlers.mcpPluginViews.value = [structuredClone(plugin)];
  return {
    ...handlers,
    listMcpTreeDatabases,
    mongoListMcpTreeDatabases,
    redisListMcpTreeDatabases,
    ensureConnected,
    databaseNames,
    settingsStore,
    savePluginMcpGrant,
    listPluginMcpViews,
    loadMcpAccessPolicy,
    resetInvalidMcpAccessPolicy,
    listPlugins,
    persistedPlugin,
    emit,
    toast,
    confirm,
    openMcpCallHistory,
    controlsDisabled: context.mcpPolicyControlsDisabled,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("EditorSettingsDialog MCP capability persistence integration", () => {
  it("places plugin tool delivery only in the capabilities advanced slot", () => {
    const advanced = dialogSource.match(/<template #advanced>([\s\S]*?)<\/template>/)?.[1];
    expect(advanced).toContain('<McpPluginToolsModeSetting :model-value="mcpPolicyDraft.pluginToolsMode" :disabled="mcpPolicyControlsDisabled" @update:model-value="(value) => stageMcpPolicy({ pluginToolsMode: value })"');
    expect(dialogSource.match(/<McpPluginToolsModeSetting\b/g)).toHaveLength(1);
    expect(dialogSource).not.toContain('id="mcp-plugin-tools-mode-label"');
  });

  it.each(["auto", "flat", "lazy"] as const)("keeps a saved %s delivery mode when applying unrelated settings", async (pluginToolsMode) => {
    const h = createHarness({ configured: true, pluginToolsMode });
    expect(h.mcpPolicyDraft.value.pluginToolsMode).toBe(pluginToolsMode);
    h.onMcpHighRiskConfirmationChange(true);
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledWith(expect.objectContaining({ pluginToolsMode }));
  });

  it("stages delivery changes until Apply and discards them without changing plugin grants", async () => {
    const h = createHarness();
    expect(h.mcpPolicyDraft.value.pluginToolsMode).toBe("flat");
    h.stageMcpPolicy({ pluginToolsMode: "lazy" });
    expect(h.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(h.savePluginMcpGrant).not.toHaveBeenCalled();
    h.requestCloseSettings(false);
    expect(h.showUnsavedSettingsCloseConfirm.value).toBe(true);
    h.cancelUnsavedSettingsClose();
    expect(h.mcpPolicyDraft.value.pluginToolsMode).toBe("lazy");
    h.discardUnsavedSettingsAndClose();
    expect(h.mcpPolicyDraft.value.pluginToolsMode).toBe("flat");
    expect(h.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    h.stageMcpPolicy({ pluginToolsMode: "lazy" });
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy.pluginToolsMode).toBe("lazy");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(false);
  });

  it("keeps delivery and permission drafts retryable after a failed Apply", async () => {
    const h = createHarness({ configured: true, pluginToolsMode: "auto", readOnly: true });
    h.stageMcpPolicy({ pluginToolsMode: "flat" });
    h.onMcpHighRiskConfirmationChange(true);
    h.settingsStore.updateMcpGlobalPolicy.mockRejectedValueOnce(new Error("disk unavailable"));
    expect(await h.applySettingsForResult()).toBe(false);
    expect(h.settingsStore.mcpGlobalPolicy.pluginToolsMode).toBe("auto");
    expect(h.mcpPolicyDraft.value).toMatchObject({ pluginToolsMode: "flat", promptHighRiskSql: false, callConfirmation: "high_risk" });
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(true);
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy).toMatchObject({ pluginToolsMode: "flat", promptHighRiskSql: false, callConfirmation: "high_risk" });
    expect(h.savePluginMcpGrant).not.toHaveBeenCalled();
  });

  it.each(["mysql", "mongodb", "redis"])("loads all %s databases through the metadata API without sidebar filtering or a page limit", async (dbType) => {
    const h = createHarness();
    const result = await h.loadMcpTreeDatabases({ id: "c1", db_type: dbType } as ConnectionConfig);
    expect(result).toHaveLength(260);
    expect(result).toEqual(dbType === "redis" ? h.databaseNames.map((_, index) => String(index)) : h.databaseNames);
    expect(h.ensureConnected).toHaveBeenCalledExactlyOnceWith("c1", { activate: false });
    expect(dbType === "redis" ? h.redisListMcpTreeDatabases : dbType === "mongodb" ? h.mongoListMcpTreeDatabases : h.listMcpTreeDatabases).toHaveBeenCalledExactlyOnceWith("c1");
  });
  it("applies only one connection's database access, keeping its parent, tools, runtime and other connection drafts", async () => {
    const h = createHarness({ configured: true, readOnly: true, queryTimeoutSecs: 30, pluginToolsMode: "auto" });
    h.stageMcpPolicy({ pluginToolsMode: "lazy" });
    h.onMcpExecutionModeChange("safe_write");
    h.onMcpConnectionExecutionModeChange("c1", "safe_write");
    h.onMcpGroupExecutionModeChange("group", "safe_write");
    h.onMcpToolAllowedChange("dbx_execute_query", false);
    h.mcpPolicyDraft.value.queryTimeoutSecs = 99;
    const access: McpDatabaseAccess = { databaseScope: "selected", allowedDatabases: ["aaa", "abc"], databasePolicies: [{ databaseName: "aaa", readOnly: true, allowDangerousSql: false }] };
    h.onMcpDatabaseAccessChange("c2", { ...access, allowedDatabases: ["other"], databasePolicies: [] });
    h.onMcpDatabaseAccessChange("c1", access);
    await h.applyMcpDatabaseAccess("c1");
    const saved = h.settingsStore.mcpGlobalPolicy;
    expect(saved.readOnly).toBe(true);
    expect(saved.queryTimeoutSecs).toBe(30);
    expect(saved.pluginToolsMode).toBe("auto");
    expect(h.mcpPolicyDraft.value.pluginToolsMode).toBe("lazy");
    expect(saved.allowedToolNames).toBeNull();
    expect(saved.groupPolicies).toEqual([]);
    expect(h.mcpPolicyDraft.value.groupPolicies).toHaveLength(1);
    expect(saved.connectionPolicies).toHaveLength(1);
    expect(saved.connectionPolicies[0]).toMatchObject({ connectionId: "c1", executionModeConfigured: false, ...access });
    expect(h.mcpPolicyDraft.value.connectionPolicies.find((r) => r.connectionId === "c1")).toMatchObject({ executionModeConfigured: true, readOnly: false });
    expect(h.mcpPolicyDraft.value.connectionPolicies.find((r) => r.connectionId === "c2")?.allowedDatabases).toEqual(["other"]);
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(true);
    await h.applySettingsForResult();
    expect(h.settingsStore.mcpGlobalPolicy.readOnly).toBe(false);
    expect(h.settingsStore.mcpGlobalPolicy.queryTimeoutSecs).toBe(99);
    expect(h.settingsStore.mcpGlobalPolicy.pluginToolsMode).toBe("lazy");
    expect(h.settingsStore.mcpGlobalPolicy.connectionPolicies).toHaveLength(2);
  });
  it("discarding remaining drafts does not undo applied database permissions", async () => {
    const h = createHarness({ configured: true, readOnly: true });
    h.onMcpDatabaseAccessChange("c1", { databaseScope: "none", allowedDatabases: [], databasePolicies: [] });
    h.onMcpExecutionModeChange("safe_write");
    await h.applyMcpDatabaseAccess("c1");
    h.discardUnsavedSettingsAndClose();
    expect(h.mcpPolicyDraft.value.readOnly).toBe(true);
    expect(h.mcpPolicyDraft.value.connectionPolicies[0].databaseScope).toBe("none");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(false);
  });
  it("clears the dirty state when multiple connection scopes are applied in reverse editing order", async () => {
    const h = createHarness({ configured: true });
    const value: McpDatabaseAccess = { databaseScope: "none", allowedDatabases: [], databasePolicies: [] };
    h.onMcpDatabaseAccessChange("c2", value);
    h.onMcpDatabaseAccessChange("c1", value);
    await h.applyMcpDatabaseAccess("c1");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(true);
    await h.applyMcpDatabaseAccess("c2");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(false);
  });
  it("database save failure leaves baseline and draft intact and retry succeeds", async () => {
    const h = createHarness({ configured: true });
    h.onMcpDatabaseAccessChange("c1", { databaseScope: "selected", allowedDatabases: ["aaa"], databasePolicies: [] });
    const draft = normalizeMcpGlobalPolicy(h.mcpPolicyDraft.value);
    const baseline = normalizeMcpGlobalPolicy(h.mcpPolicyBaseline.value);
    h.settingsStore.updateMcpGlobalPolicy.mockRejectedValueOnce(new Error("offline"));
    await expect(h.applyMcpDatabaseAccess("c1")).rejects.toThrow("offline");
    expect(h.mcpPolicyDraft.value).toEqual(draft);
    expect(h.mcpPolicyBaseline.value).toEqual(baseline);
    expect(h.mcpPolicySaving.value).toBe(false);
    await h.applyMcpDatabaseAccess("c1");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(false);
  });
  it("rejects database saves while controls are blocked or another save is pending", async () => {
    const h = createHarness();
    await expect(h.applyMcpDatabaseAccess("missing")).rejects.toThrow();
    h.controlsDisabled.value = true;
    await expect(h.applyMcpDatabaseAccess("c1")).rejects.toThrow();
    h.controlsDisabled.value = false;
    const pending = deferred<void>();
    h.settingsStore.updateMcpGlobalPolicy.mockImplementationOnce(() => pending.promise);
    const first = h.applyMcpDatabaseAccess("c1");
    await expect(h.applyMcpDatabaseAccess("c2")).rejects.toThrow();
    pending.resolve();
    await first;
    expect(h.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledOnce();
  });
  it("does not widen legacy saved permissions when applying database scope with an unrelated permissive draft", async () => {
    const h = createHarness({
      configured: true,
      readOnly: true,
      connectionPolicies: [{ connectionId: "c1", readOnly: false, allowDangerousSql: true, executionModeConfigured: true, executionModePolicyVersion: null, databaseScope: "selected", allowedDatabases: ["old"], databasePolicies: [], allowSalesforceDml: false }],
    });
    h.onMcpExecutionModeChange("safe_write");
    h.onMcpDatabaseAccessChange("c1", { databaseScope: "selected", allowedDatabases: ["old", "new"], databasePolicies: [] });
    await h.applyMcpDatabaseAccess("c1");
    expect(h.settingsStore.mcpGlobalPolicy.connectionPolicies[0]).toMatchObject({ executionModePolicyVersion: 1, readOnly: true, allowDangerousSql: false, allowedDatabases: ["new", "old"] });
    expect(h.mcpPolicyDraft.value.connectionPolicies[0].readOnly).toBe(false);
  });

  it("keeps untouched legacy database ceilings at saved levels instead of applying a pending parent grant", async () => {
    const h = createHarness({
      configured: true,
      readOnly: true,
      connectionPolicies: [
        {
          connectionId: "c1",
          readOnly: false,
          allowDangerousSql: true,
          executionModeConfigured: true,
          executionModePolicyVersion: null,
          databaseScope: "selected",
          allowedDatabases: ["old"],
          databasePolicies: [{ databaseName: "old", readOnly: false, allowDangerousSql: true }],
          allowSalesforceDml: false,
        },
      ],
    });
    h.onMcpExecutionModeChange("safe_write");
    const access = editableDatabaseAccess(h.mcpPolicyDraft.value, "c1", { groups: [], order: [] }, [{ id: "c1", name: "First", db_type: "mysql" }] as ConnectionConfig[]);
    h.onMcpDatabaseAccessChange("c1", { ...access, allowedDatabases: ["old", "new"] });
    await h.applyMcpDatabaseAccess("c1");
    expect(h.settingsStore.mcpGlobalPolicy.connectionPolicies[0].databasePolicies).toEqual([{ databaseName: "old", readOnly: true, allowDangerousSql: false }]);
    expect(h.mcpPolicyDraft.value.readOnly).toBe(false);
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(true);
  });
  it("applies an explicitly edited legacy database override independently of the pending parent", async () => {
    const h = createHarness({
      configured: true,
      readOnly: true,
      connectionPolicies: [
        {
          connectionId: "c1",
          readOnly: false,
          allowDangerousSql: true,
          executionModeConfigured: true,
          executionModePolicyVersion: null,
          databaseScope: "selected",
          allowedDatabases: ["old"],
          databasePolicies: [{ databaseName: "old", readOnly: false, allowDangerousSql: true }],
          allowSalesforceDml: false,
        },
      ],
    });
    h.onMcpExecutionModeChange("safe_write");
    h.onMcpDatabaseAccessChange("c1", { databaseScope: "selected", allowedDatabases: ["old"], databasePolicies: [{ databaseName: "old", readOnly: false, allowDangerousSql: true }] });
    await h.applyMcpDatabaseAccess("c1");
    expect(h.settingsStore.mcpGlobalPolicy.connectionPolicies[0]).toMatchObject({ readOnly: true, databasePolicies: [{ databaseName: "old", readOnly: false, allowDangerousSql: true }] });
    expect(h.settingsStore.mcpGlobalPolicy.readOnly).toBe(true);
  });

  it("applies only the current toolset, keeping other tool, permission and custom-entry drafts for a later Apply", async () => {
    const harness = createHarness({ configured: true, readOnly: true, queryTimeoutSecs: 30, pluginToolsMode: "auto" });
    harness.stageMcpPolicy({ pluginToolsMode: "flat" });
    harness.onMcpToolAllowedChange("dbx_nacos_publish_config", false);
    harness.onMcpToolAllowedChange("dbx_execute_query", false);
    harness.onMcpExecutionModeChange("safe_write");
    harness.onMcpConnectionExecutionModeChange("c1", "safe_write");
    harness.mcpPolicyDraft.value.queryTimeoutSecs = 99;
    harness.mcpCustomToolInput.value = "dbx_custom__inspect";
    harness.onMcpCustomToolAdd();
    const draft = normalizeMcpGlobalPolicy(harness.mcpPolicyDraft.value);

    await harness.applyMcpToolset("nacos.config");
    const saved = harness.settingsStore.mcpGlobalPolicy;
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledWith({ allowedToolNames: expect.any(Array) });
    expect(saved.allowedToolNames).not.toContain("dbx_nacos_publish_config");
    expect(saved.allowedToolNames).toContain("dbx_execute_query");
    expect(saved.allowedToolNames).toContain(MCP_PLUGIN_TOOLS_WILDCARD);
    expect(saved.allowedToolNames).not.toContain("dbx_custom__inspect");
    expect(saved).toMatchObject({ readOnly: true, connectionPolicies: [], queryTimeoutSecs: 30, pluginToolsMode: "auto" });
    expect(harness.mcpPolicyDraft.value).toEqual(draft);
    expect(harness.mcpPolicyBaseline.value).toEqual(saved);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(true);
    expect(harness.settingsStore.updateDesktopSettings).not.toHaveBeenCalled();
    expect(harness.savePluginMcpGrant).not.toHaveBeenCalled();
    expect(await harness.applySettingsForResult()).toBe(true);
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(draft);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
  });

  it("discarding remaining drafts keeps the toolset already applied from its details", async () => {
    const harness = createHarness({ readOnly: true, allowedToolNames: ["dbx_execute_query", "dbx_nacos_get_config", "dbx_helper__*", "custom-tool"] });
    harness.onMcpToolAllowedChange("dbx_nacos_publish_config", true);
    harness.onMcpToolAllowedChange("dbx_execute_query", false);
    harness.onMcpExecutionModeChange("safe_write");
    await harness.applyMcpToolset("nacos.config");
    expect(harness.settingsStore.mcpGlobalPolicy.allowedToolNames).toEqual(["dbx_execute_query", "dbx_nacos_get_config", "dbx_helper__*", "custom-tool", "dbx_nacos_publish_config"]);
    harness.discardUnsavedSettingsAndClose();
    expect(harness.mcpPolicyDraft.value).toEqual(harness.settingsStore.mcpGlobalPolicy);
    expect(harness.mcpPolicyDraft.value.readOnly).toBe(true);
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledOnce();
  });

  it("clears the outer dirty state after applying toolsets in a different order from their edits", async () => {
    const harness = createHarness({ allowedToolNames: [] });
    harness.onMcpToolAllowedChange("dbx_nacos_get_config", true);
    harness.onMcpToolAllowedChange("dbx_execute_query", true);
    await harness.applyMcpToolset("sql.query");
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(true);
    await harness.applyMcpToolset("nacos.config");
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.mcpPolicyDraft.value).toEqual(harness.settingsStore.mcpGlobalPolicy);
  });

  it("preserves the baseline and draft after failure and saves the same toolset on retry", async () => {
    const harness = createHarness();
    harness.onMcpToolAllowedChange("dbx_nacos_publish_config", false);
    const baseline = normalizeMcpGlobalPolicy(harness.mcpPolicyBaseline.value);
    const draft = normalizeMcpGlobalPolicy(harness.mcpPolicyDraft.value);
    harness.settingsStore.updateMcpGlobalPolicy.mockRejectedValueOnce(new Error("disk full"));
    await expect(harness.applyMcpToolset("nacos.config")).rejects.toThrow("disk full");
    expect(harness.mcpPolicyBaseline.value).toEqual(baseline);
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(baseline);
    expect(harness.mcpPolicyDraft.value).toEqual(draft);
    expect(harness.mcpPolicySaving.value).toBe(false);
    await harness.applyMcpToolset("nacos.config");
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledTimes(2);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
  });

  it("blocks partial saves without a complete catalog or while another policy save is pending", async () => {
    const harness = createHarness();
    harness.mcpToolCatalogLoading.value = true;
    await expect(harness.applyMcpToolset("sql.query")).rejects.toThrow();
    harness.mcpToolCatalogLoading.value = false;
    await expect(harness.applyMcpToolset("unknown")).rejects.toThrow();
    const pending = deferred<void>();
    harness.settingsStore.updateMcpGlobalPolicy.mockReturnValueOnce(pending.promise);
    harness.onMcpToolAllowedChange("dbx_execute_query", false);
    const saving = harness.applyMcpToolset("sql.query");
    expect(harness.mcpPolicySaving.value).toBe(true);
    await expect(harness.applyMcpToolset("nacos.config")).rejects.toThrow();
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledOnce();
    pending.resolve();
    await saving;
  });

  it("keeps a scope saved while permission context refresh is waiting for the plugin list", async () => {
    const harness = createHarness();
    const previous: McpAccessPolicy = { version: 2, defaultAccess: "read", rules: [] };
    const saved: McpAccessPolicy = { ...previous, rules: [{ target: { kind: "connection", id: "nacos" }, subScope: "none", subScopeKind: "namespace" }] };
    harness.mcpAccessPolicy.value = previous;
    harness.loadMcpAccessPolicy.mockResolvedValueOnce(previous);
    const plugins = deferred<Array<{ manifest: { id: string } }>>();
    harness.listPlugins.mockReturnValueOnce(plugins.promise);
    const loading = harness.loadMcpPluginScopeContext();
    // The scope editor emits the policy returned by its immediate save.
    harness.mcpAccessPolicy.value = saved;
    plugins.resolve([{ manifest: { id: "io.dbx.scope" } }]);
    await loading;
    expect(harness.mcpAccessPolicy.value).toEqual(saved);
    expect(harness.mcpInstalledPluginsForScopes.value).toEqual([{ manifest: { id: "io.dbx.scope" } }]);
  });

  it("ignores an older permission context refresh that finishes after a newer refresh", async () => {
    const harness = createHarness();
    const first = deferred<McpAccessPolicy>();
    harness.loadMcpAccessPolicy.mockReturnValueOnce(first.promise);
    harness.listPlugins.mockResolvedValueOnce([{ manifest: { id: "io.dbx.old" } }]);
    const loading = harness.loadMcpPluginScopeContext();
    const latest: McpAccessPolicy = { version: 2, defaultAccess: "write", rules: [{ target: { kind: "connection", id: "nacos" }, subScope: "selected" }] };
    harness.loadMcpAccessPolicy.mockResolvedValueOnce(latest);
    harness.listPlugins.mockResolvedValueOnce([{ manifest: { id: "io.dbx.new" } }]);
    await harness.loadMcpPluginScopeContext();
    first.resolve({ version: 2, defaultAccess: "read", rules: [] });
    await loading;
    expect(harness.mcpAccessPolicy.value).toEqual(latest);
    expect(harness.mcpInstalledPluginsForScopes.value).toEqual([{ manifest: { id: "io.dbx.new" } }]);
  });

  it("opens MCP history after closing settings when there is no draft", () => {
    const harness = createHarness();
    harness.clickMcpCallHistory();
    expect(harness.emit).toHaveBeenCalledWith("update:open", false);
    expect(harness.openMcpCallHistory).toHaveBeenCalledOnce();
    expect(harness.emit.mock.invocationCallOrder[0]).toBeLessThan(harness.openMcpCallHistory.mock.invocationCallOrder[0]);
  });

  it("keeps MCP history closed when the user cancels leaving an unsaved draft", async () => {
    const harness = createHarness({ readOnly: true });
    harness.onMcpExecutionModeChange("safe_write");
    harness.clickMcpCallHistory();
    expect(harness.showUnsavedSettingsCloseConfirm.value).toBe(true);
    expect(harness.openMcpCallHistory).not.toHaveBeenCalled();
    harness.cancelUnsavedSettingsClose();
    expect(harness.emit).not.toHaveBeenCalled();
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(true);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    await harness.applySettingsAndClose();
    expect(harness.emit).toHaveBeenCalledWith("update:open", false);
    expect(harness.openMcpCallHistory).not.toHaveBeenCalled();
  });

  it("opens MCP history once after confirming draft discard, without persisting it", () => {
    const harness = createHarness({ readOnly: true });
    harness.onMcpExecutionModeChange("safe_write");
    harness.clickMcpCallHistory();
    expect(harness.openMcpCallHistory).not.toHaveBeenCalled();
    harness.discardUnsavedSettingsAndClose();
    expect(harness.mcpPolicyDraft.value.readOnly).toBe(true);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(harness.emit).toHaveBeenCalledWith("update:open", false);
    expect(harness.openMcpCallHistory).toHaveBeenCalledOnce();
    expect(harness.emit.mock.invocationCallOrder[0]).toBeLessThan(harness.openMcpCallHistory.mock.invocationCallOrder[0]);
    harness.requestCloseSettings(false);
    expect(harness.openMcpCallHistory).toHaveBeenCalledOnce();
  });

  it("changes only global execution defaults, preserving tool switches and resource exceptions until Apply", async () => {
    const harness = createHarness({
      readOnly: true,
      allowedToolNames: ["dbx_execute_query", "dbx_helper__inspect"],
      allowedConnectionIds: ["c1", "c2", "inherited"],
      groupPolicies: [{ groupId: "team", readOnly: true, allowDangerousSql: false }],
      connectionPolicies: [
        {
          connectionId: "c1",
          executionModeConfigured: true,
          executionModePolicyVersion: 1,
          readOnly: true,
          allowDangerousSql: false,
          databaseScope: "selected",
          allowedDatabases: ["billing"],
          databasePolicies: [{ databaseName: "billing", readOnly: false, allowDangerousSql: false }],
          allowSalesforceDml: false,
        },
      ],
    });
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    const layout: SidebarLayout = {
      groups: [{ id: "team", name: "Team", collapsed: false }],
      order: [
        { type: "group", id: "team", children: [{ type: "connection", id: "c2" }] },
        { type: "connection", id: "c1" },
        { type: "connection", id: "inherited" },
      ],
    };
    const connections = ["c1", "c2", "inherited"].map((id) => ({ id, name: id, db_type: "mysql" }) as ConnectionConfig);
    harness.mcpToolCatalog.value = null; // Permission changes do not depend on loading tools.
    harness.onMcpExecutionModeChange("safe_write");
    expect(harness.mcpPolicyDraft.value).toEqual({ ...original, readOnly: false });
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(original);
    const rows = buildMcpAccessTreeRows(harness.mcpPolicyDraft.value, layout, connections, { expandedGroupIds: new Set(["team"]), expandedConnectionIds: new Set(["c1"]) });
    expect(rows.find((row) => row.key === "connection:inherited")).toMatchObject({ visible: true, effective: "safe_write", source: { kind: "global" } });
    expect(rows.find((row) => row.key === "connection:c1")).toMatchObject({ effective: "read_only", source: { kind: "connection" } });
    expect(rows.find((row) => row.key === "connection:c2")).toMatchObject({ effective: "read_only", source: { kind: "group" } });
    expect(rows.find((row) => row.key === "database:c1:billing")).toMatchObject({ effective: "safe_write", source: { kind: "database" } });
    expect(harness.savePluginMcpGrant).not.toHaveBeenCalled();
    expect(await harness.applySettingsForResult()).toBe(true);
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual({ ...original, readOnly: false, configured: true });
  });

  it("preserves legacy semantics on unrelated saves and migrates only on deliberate selection", async () => {
    const h = createHarness({ configured: true, promptHighRiskSql: true });
    h.stageMcpPolicy({ queryTimeoutSecs: 90 });
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy.promptHighRiskSql).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy.callConfirmation).toBeUndefined();
    h.onMcpHighRiskConfirmationChange(true);
    expect(h.settingsStore.mcpGlobalPolicy.promptHighRiskSql).toBe(true);
    expect(h.mcpPolicyDraft.value).toMatchObject({ promptHighRiskSql: false, callConfirmation: "high_risk" });
    h.discardUnsavedSettingsAndClose();
    expect(h.mcpPolicyDraft.value.promptHighRiskSql).toBe(true);
    h.onMcpHighRiskConfirmationChange(true);
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy).toMatchObject({ promptHighRiskSql: false, callConfirmation: "high_risk" });
    h.onMcpHighRiskConfirmationChange(false);
    expect(await h.applySettingsForResult()).toBe(true);
    expect(h.settingsStore.mcpGlobalPolicy.promptHighRiskSql).toBe(false);
    expect(h.settingsStore.mcpGlobalPolicy.callConfirmation).toBeUndefined();
  });

  it("keeps a pending safety migration when applying only a toolset", async () => {
    const h = createHarness({ configured: true, promptHighRiskSql: true });
    h.onMcpHighRiskConfirmationChange(true);
    h.onMcpToolAllowedChange("dbx_execute_query", false);
    await h.applyMcpToolset("sql.query");
    expect(h.settingsStore.mcpGlobalPolicy.promptHighRiskSql).toBe(true);
    expect(h.mcpPolicyDraft.value.callConfirmation).toBe("high_risk");
    expect(h.mcpPolicyHasUnsavedChanges()).toBe(true);
  });

  it("discards default permission and confirmation edits without changing saved settings", () => {
    const harness = createHarness({ readOnly: false, promptHighRiskSql: true, allowedToolNames: ["dbx_execute_query"] });
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    harness.onMcpHighRiskConfirmationChange(false);
    harness.onMcpExecutionModeChange("read_only");
    harness.requestCloseSettings(false);
    expect(harness.showUnsavedSettingsCloseConfirm.value).toBe(true);
    harness.discardUnsavedSettingsAndClose();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(original);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
  });

  it("requires confirmation for full access and leaves the draft intact when cancelled", () => {
    const harness = createHarness({ readOnly: false, promptHighRiskSql: true });
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    harness.onMcpExecutionModeChange("high_risk_write");
    expect(harness.mcpPolicyConfirmation.value?.message).toBe("settings.mcpExecutionModeHighRiskConfirm");
    expect(harness.confirm).not.toHaveBeenCalled();
    harness.mcpPolicyConfirmation.value = null;
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    harness.onMcpExecutionModeChange("high_risk_write");
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyConfirmation.value).toBeNull();
    expect(harness.mcpPolicyDraft.value).toEqual({ ...original, allowDangerousSql: true });
    harness.onMcpHighRiskConfirmationChange(true);
    expect(harness.mcpPolicyDraft.value.callConfirmation).toBe("high_risk");
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(false);
  });

  it("keeps default permission controls locked and preserves confirmation for resource overrides with any default", () => {
    const harness = createHarness({ readOnly: true });
    harness.onMcpHighRiskConfirmationChange(true);
    expect(harness.mcpPolicyDraft.value.callConfirmation).toBe("high_risk");
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(false);
    harness.controlsDisabled.value = true;
    harness.onMcpExecutionModeChange("high_risk_write");
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.mcpPolicyDraft.value.readOnly).toBe(true);
    harness.controlsDisabled.value = false;
    harness.onMcpExecutionModeChange("safe_write");
    harness.onMcpHighRiskConfirmationChange(true);
    expect(harness.mcpPolicyDraft.value.callConfirmation).toBe("high_risk");
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(false);
    harness.controlsDisabled.value = true;
    harness.onMcpHighRiskConfirmationChange(false);
    expect(harness.mcpPolicyDraft.value.callConfirmation).toBe("high_risk");
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(false);
  });

  it.each(["group", "connection", "database"] as const)("confirms a %s full-access edit exactly once and preserves cancelled drafts", (kind) => {
    const harness = createHarness({ readOnly: true });
    if (kind === "database") {
      harness.onMcpConnectionExecutionModeChange("c1", "safe_write");
      const connection = harness.mcpPolicyDraft.value.connectionPolicies[0];
      connection.databaseScope = "selected";
      connection.allowedDatabases = ["billing"];
    }
    const original = JSON.parse(JSON.stringify(harness.mcpPolicyDraft.value));
    const change = () => (kind === "group" ? harness.onMcpGroupExecutionModeChange("team", "high_risk_write") : kind === "connection" ? harness.onMcpConnectionExecutionModeChange("c1", "high_risk_write") : harness.onMcpDatabaseExecutionModeChange("c1", "billing", "high_risk_write"));
    change();
    expect(harness.mcpPolicyConfirmation.value).not.toBeNull();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    harness.mcpPolicyConfirmation.value = null; // cancel / Escape / outside close
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    change();
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyConfirmation.value).toBeNull();
    expect(harness.mcpPolicyDraft.value).not.toEqual(original);
  });

  it.each(["visibility", "databaseScope", "databaseRemoval"] as const)("requires an in-app decision before changing %s and discarding exceptions", (kind) => {
    const harness = createHarness({
      allowedConnectionIds: ["c1"],
      connectionPolicies: [
        {
          connectionId: "c1",
          readOnly: false,
          allowDangerousSql: false,
          executionModeConfigured: true,
          executionModePolicyVersion: 1,
          databaseScope: "selected",
          allowedDatabases: ["main"],
          databasePolicies: [{ databaseName: "main", readOnly: true, allowDangerousSql: false }],
          allowSalesforceDml: false,
        },
      ],
    });
    const original = JSON.parse(JSON.stringify(harness.mcpPolicyDraft.value));
    const change = () => (kind === "visibility" ? harness.onMcpTreeScopeMode("all") : kind === "databaseScope" ? harness.onMcpTreeDatabaseScope("c1", "all") : harness.onMcpTreeDatabaseAllowed("c1", "main", false));
    change();
    expect(harness.mcpPolicyConfirmation.value).not.toBeNull();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    harness.mcpPolicyConfirmation.value = null;
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    change();
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyConfirmation.value).toBeNull();
    expect(harness.mcpPolicyDraft.value).not.toEqual(original);
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  it("drops pending permission changes when closed or controls become unavailable", () => {
    const harness = createHarness({ readOnly: true });
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    harness.onMcpConnectionExecutionModeChange("c1", "high_risk_write");
    harness.controlsDisabled.value = true;
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    expect(harness.mcpPolicyConfirmation.value).toBeNull();
    harness.controlsDisabled.value = false;
    harness.onMcpGroupExecutionModeChange("team", "high_risk_write");
    harness.requestCloseSettings(false);
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
  });

  it("keeps confirmation when changing the default around resource-level write overrides", () => {
    const harness = createHarness({ readOnly: false, promptHighRiskSql: true });
    harness.onMcpConnectionExecutionModeChange("c1", "safe_write");
    harness.onMcpExecutionModeChange("read_only");
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(true);
    expect(harness.mcpPolicyDraft.value.connectionPolicies[0].readOnly).toBe(false);
    harness.onMcpExecutionModeChange("high_risk_write");
    harness.confirmMcpPolicyChange();
    expect(harness.mcpPolicyDraft.value.promptHighRiskSql).toBe(true);
  });

  it("restores inheritance at each resource level without rewriting the default or enabled tools", () => {
    const harness = createHarness({ readOnly: true, allowedToolNames: ["dbx_execute_query"] });
    harness.onMcpGroupExecutionModeChange("team", "safe_write");
    harness.onMcpConnectionExecutionModeChange("c1", "safe_write");
    const connection = harness.mcpPolicyDraft.value.connectionPolicies[0];
    connection.databaseScope = "selected";
    connection.allowedDatabases = ["billing"];
    harness.onMcpDatabaseExecutionModeChange("c1", "billing", "read_only");
    expect(harness.mcpPolicyDraft.value.connectionPolicies[0].databasePolicies).toHaveLength(1);
    harness.onMcpDatabaseExecutionModeChange("c1", "billing", "inherit");
    harness.onMcpConnectionExecutionModeChange("c1", "inherit");
    harness.onMcpGroupExecutionModeChange("team", "inherit");
    expect(harness.mcpPolicyDraft.value).toMatchObject({ readOnly: true, allowedToolNames: ["dbx_execute_query"], groupPolicies: [], connectionPolicies: [{ executionModeConfigured: false, databaseScope: "selected", allowedDatabases: ["billing"], databasePolicies: [] }] });
  });

  it("stages a whole category and discards it without writing either persistence boundary", () => {
    const harness = createHarness({ readOnly: true, allowedConnectionIds: ["production"], allowedGroupIds: ["team"] });
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    harness.onMcpCategoryAllowedChange("nacos", false);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(true);
    expect(harness.mcpPolicyDraft.value.allowedToolNames).toEqual(["dbx_execute_query", "dbx_future_query", "dbx_add_connection", MCP_PLUGIN_TOOLS_WILDCARD]);
    expect(harness.mcpPolicyDraft.value).toMatchObject({ readOnly: true, allowedConnectionIds: ["production"], allowedGroupIds: ["team"] });
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(original);
    harness.requestCloseSettings(false);
    expect(harness.showUnsavedSettingsCloseConfirm.value).toBe(true);
    expect(harness.emit).not.toHaveBeenCalled();
    harness.discardUnsavedSettingsAndClose();
    expect(harness.mcpPolicyDraft.value).toEqual(original);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.emit).toHaveBeenCalledExactlyOnceWith("update:open", false);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(harness.savePluginMcpGrant).not.toHaveBeenCalled();
  });

  it("persists the category only through the actual Apply path and refreshes its baseline", async () => {
    const harness = createHarness();
    harness.onMcpCategoryAllowedChange("nacos", false);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(await harness.applySettingsForResult()).toBe(true);
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledTimes(1);
    expect(harness.settingsStore.mcpGlobalPolicy.allowedToolNames).toEqual(["dbx_execute_query", "dbx_future_query", "dbx_add_connection", MCP_PLUGIN_TOOLS_WILDCARD]);
    expect(harness.mcpPolicyDraft.value).toEqual(harness.settingsStore.mcpGlobalPolicy);
    expect(harness.mcpPolicyBaseline.value).toEqual(harness.settingsStore.mcpGlobalPolicy);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.savePluginMcpGrant).not.toHaveBeenCalled();
    await harness.applySettingsAndClose();
    expect(harness.settingsStore.updateMcpGlobalPolicy).toHaveBeenCalledTimes(1);
    expect(harness.emit).toHaveBeenCalledWith("update:open", false);
  });

  it("keeps a failed Apply draft retryable and does not close the settings dialog", async () => {
    const harness = createHarness();
    const original = structuredClone(harness.settingsStore.mcpGlobalPolicy);
    harness.onMcpCategoryAllowedChange("nacos", false);
    harness.settingsStore.updateMcpGlobalPolicy.mockRejectedValueOnce(new Error("disk unavailable"));
    await harness.applySettingsAndClose();
    expect(harness.emit).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith("settings.applyFailed", 5000);
    expect(harness.settingsStore.mcpGlobalPolicy).toEqual(original);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(true);
    expect(harness.mcpPolicySaving.value).toBe(false);
    expect(await harness.applySettingsForResult()).toBe(true);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
  });

  it("does not undo an immediately saved plugin grant when built-in changes are discarded", async () => {
    const harness = createHarness();
    harness.onMcpCategoryAllowedChange("nacos", false);
    const grant = { ...plugin.grant, external: true };
    const saved = await harness.persistMcpPluginGrant(plugin.pluginId, grant, true);
    expect(harness.savePluginMcpGrant).toHaveBeenCalledExactlyOnceWith(plugin.pluginId, grant, true);
    expect(harness.persistedPlugin.value.grant.external).toBe(true);
    expect(harness.mcpPluginViews.value?.[0]).toEqual(saved);
    harness.discardUnsavedSettingsAndClose();
    expect(harness.mcpPolicyDraft.value.allowedToolNames).toBeNull();
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(harness.persistedPlugin.value.grant.external).toBe(true);
    expect(harness.mcpPluginViews.value?.[0].grant.external).toBe(true);
    expect(harness.savePluginMcpGrant).toHaveBeenCalledTimes(1);
  });

  it("updates the cached plugin after a late save even without a child saved event", async () => {
    const harness = createHarness();
    let resolve!: (view: PluginMcpView) => void;
    harness.savePluginMcpGrant.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const grant = { ...plugin.grant, external: true };
    const pending = harness.persistMcpPluginGrant(plugin.pluginId, grant, false);
    harness.discardUnsavedSettingsAndClose();
    const saved = { ...plugin, grant };
    resolve(saved);
    await expect(pending).resolves.toEqual(saved);
    expect(harness.mcpPluginViews.value?.[0]).toEqual(saved);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
  });

  it("leaves plugin state unchanged after a failed immediate save", async () => {
    const harness = createHarness();
    harness.savePluginMcpGrant.mockRejectedValueOnce(new Error("plugin unavailable"));
    await expect(harness.persistMcpPluginGrant(plugin.pluginId, { ...plugin.grant, external: true }, false)).rejects.toThrow("plugin unavailable");
    expect(harness.mcpPluginViews.value?.[0]).toEqual(plugin);
    expect(harness.persistedPlugin.value.grant.external).toBe(false);
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
  });

  it("keeps a grant saved during refresh while accepting refreshed and newly discovered plugins", async () => {
    const harness = createHarness();
    const other = { ...structuredClone(plugin), pluginId: "io.dbx.other", pluginName: "Other" };
    const refreshedOther = { ...other, version: "2.0.0", grant: { ...other.grant, external: true } };
    const discovered = { ...structuredClone(plugin), pluginId: "io.dbx.new", pluginName: "New" };
    harness.mcpPluginViews.value = [structuredClone(plugin), other];
    const discovery = deferred<PluginMcpView[]>();
    harness.listPluginMcpViews.mockReturnValueOnce(discovery.promise);
    const refreshing = harness.loadMcpPluginViews();
    expect(harness.mcpPluginViewsLoading.value).toBe(true);
    const saved = await harness.persistMcpPluginGrant(plugin.pluginId, { ...plugin.grant, external: true }, true);
    discovery.resolve([structuredClone(plugin), refreshedOther, discovered]);
    await refreshing;
    expect(harness.mcpPluginViews.value).toEqual([saved, refreshedOther, discovered]);
    expect(harness.mcpPluginViewsLoading.value).toBe(false);
    expect(harness.mcpPluginViewsError.value).toBe("");
  });

  it("applies a save that finishes after refresh without reverting other refreshed plugins", async () => {
    const harness = createHarness();
    const refreshed = { ...structuredClone(plugin), version: "2.0.0" };
    const other = { ...structuredClone(plugin), pluginId: "io.dbx.other", pluginName: "Other", version: "3.0.0" };
    const discovery = deferred<PluginMcpView[]>();
    const saving = deferred<PluginMcpView>();
    harness.listPluginMcpViews.mockReturnValueOnce(discovery.promise);
    harness.savePluginMcpGrant.mockReturnValueOnce(saving.promise);
    const refreshing = harness.loadMcpPluginViews();
    const grant = { ...plugin.grant, external: true };
    const save = harness.persistMcpPluginGrant(plugin.pluginId, grant, true);
    discovery.resolve([refreshed, other]);
    await refreshing;
    expect(harness.mcpPluginViews.value).toEqual([refreshed, other]);
    const saved = { ...refreshed, grant };
    saving.resolve(saved);
    await save;
    expect(harness.mcpPluginViews.value).toEqual([saved, other]);
  });

  it("accepts refreshed plugin data when a concurrent grant save fails", async () => {
    const harness = createHarness();
    const discovery = deferred<PluginMcpView[]>();
    const saving = deferred<PluginMcpView>();
    harness.listPluginMcpViews.mockReturnValueOnce(discovery.promise);
    harness.savePluginMcpGrant.mockReturnValueOnce(saving.promise);
    const refreshing = harness.loadMcpPluginViews();
    const save = harness.persistMcpPluginGrant(plugin.pluginId, { ...plugin.grant, external: true }, true);
    saving.reject(new Error("save unavailable"));
    await expect(save).rejects.toThrow("save unavailable");
    const refreshed = { ...structuredClone(plugin), version: "2.0.0", discoveryError: "probe unavailable" };
    discovery.resolve([refreshed]);
    await refreshing;
    expect(harness.mcpPluginViews.value).toEqual([refreshed]);
    expect(harness.mcpPluginViews.value?.[0].grant.external).toBe(false);
    expect(harness.mcpPluginViewsLoading.value).toBe(false);
  });

  it("rejects duplicate saves for one plugin while allowing another plugin to save concurrently", async () => {
    const harness = createHarness();
    const other = { ...structuredClone(plugin), pluginId: "io.dbx.other", pluginName: "Other" };
    const grant = { ...plugin.grant, external: true };
    const saved = { ...structuredClone(plugin), grant };
    const savedOther = { ...other, grant };
    harness.mcpPluginViews.value = [structuredClone(plugin), other];
    const saving = deferred<PluginMcpView>();
    harness.savePluginMcpGrant.mockImplementation((id) => (id === plugin.pluginId ? saving.promise : Promise.resolve(savedOther)));
    const first = harness.persistMcpPluginGrant(plugin.pluginId, grant, true);
    await expect(harness.persistMcpPluginGrant(plugin.pluginId, grant, true)).rejects.toThrow("settings.mcpBrowser.pluginSaving");
    expect(harness.savePluginMcpGrant).toHaveBeenCalledTimes(1);
    await expect(harness.persistMcpPluginGrant(other.pluginId, grant, true)).resolves.toEqual(savedOther);
    expect(harness.savePluginMcpGrant).toHaveBeenCalledTimes(2);
    expect(harness.mcpPluginViews.value?.[1]).toEqual(savedOther);
    saving.resolve(saved);
    await expect(first).resolves.toEqual(saved);
    await expect(harness.persistMcpPluginGrant(plugin.pluginId, grant, true)).resolves.toEqual(saved);
    expect(harness.savePluginMcpGrant).toHaveBeenCalledTimes(3);
    expect(harness.mcpPluginViews.value).toEqual([saved, savedOther]);
  });

  it("unlocks a plugin after a failed save so that a later retry can succeed", async () => {
    const harness = createHarness();
    const saving = deferred<PluginMcpView>();
    harness.savePluginMcpGrant.mockReturnValueOnce(saving.promise);
    const grant = { ...plugin.grant, external: true };
    const first = harness.persistMcpPluginGrant(plugin.pluginId, grant, true);
    saving.reject(new Error("save interrupted"));
    await expect(first).rejects.toThrow("save interrupted");
    const saved = { ...structuredClone(plugin), grant };
    harness.savePluginMcpGrant.mockResolvedValueOnce(saved);
    await expect(harness.persistMcpPluginGrant(plugin.pluginId, grant, true)).resolves.toEqual(saved);
    expect(harness.savePluginMcpGrant).toHaveBeenCalledTimes(2);
    expect(harness.mcpPluginViews.value).toEqual([saved]);
  });

  it("rejects category mutations while catalog loading, load failure or policy lock is active", () => {
    const harness = createHarness();
    harness.mcpToolCatalogLoading.value = true;
    harness.onMcpCategoryAllowedChange("nacos", false);
    harness.mcpToolCatalogLoading.value = false;
    harness.mcpToolCatalogError.value = "catalog failed";
    harness.onMcpCategoryAllowedChange("nacos", false);
    harness.mcpToolCatalogError.value = "";
    harness.controlsDisabled.value = true;
    harness.onMcpCategoryAllowedChange("nacos", false);
    expect(harness.mcpPolicyDraft.value.allowedToolNames).toBeNull();
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
  });

  it("adding a custom tool preserves the complete runtime catalog and plugin wildcard from an unrestricted policy", () => {
    const harness = createHarness();
    harness.mcpCustomToolInput.value = "  dbx_custom__inspect  ";
    harness.onMcpCustomToolAdd();
    expect(harness.mcpPolicyDraft.value.allowedToolNames).toEqual(["dbx_execute_query", "dbx_future_query", "dbx_nacos_get_config", "dbx_nacos_publish_config", "dbx_nacos_list_services", "dbx_add_connection", MCP_PLUGIN_TOOLS_WILDCARD, "dbx_custom__inspect"]);
    expect(harness.mcpCustomToolInput.value).toBe("");
    expect(harness.settingsStore.mcpGlobalPolicy.allowedToolNames).toBeNull();
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
  });

  it.each(["missing", "loading", "error", "policy"])("does not add a custom tool or clear its input while the catalog is locked: %s", (reason) => {
    const harness = createHarness();
    harness.mcpCustomToolInput.value = "dbx_custom__inspect";
    if (reason === "missing") harness.mcpToolCatalog.value = null;
    if (reason === "loading") harness.mcpToolCatalogLoading.value = true;
    if (reason === "error") harness.mcpToolCatalogError.value = "catalog unavailable";
    if (reason === "policy") harness.controlsDisabled.value = true;
    harness.onMcpCustomToolAdd();
    expect(harness.mcpPolicyDraft.value.allowedToolNames).toBeNull();
    expect(harness.mcpCustomToolInput.value).toBe("dbx_custom__inspect");
    expect(harness.mcpPolicyHasUnsavedChanges()).toBe(false);
    expect(harness.settingsStore.updateMcpGlobalPolicy).not.toHaveBeenCalled();
  });
});

describe("MCP policy corruption recovery", () => {
  it("uses the in-app confirmation on desktop as well as web", () => {
    expect(declaration("recoverMcpAccessPolicy")).not.toContain("window.confirm");
    expect(dialogSource).toContain(':open="mcpPolicyConfirmationDialog.open"');
    expect(declaration("mcpPolicyConfirmationDialog")).toContain("mcpPolicyRecoveryConfirmation.value");
    expect(declaration("confirmMcpPolicyChange")).toContain("return recoverMcpAccessPolicy()");
  });
  it("shows access-policy errors and clears stale permission data", async () => {
    const h = createHarness();
    h.mcpAccessPolicy.value = { version: 2, defaultAccess: "full", rules: [] };
    h.loadMcpAccessPolicy.mockRejectedValueOnce(new Error("MCP_POLICY_UNAVAILABLE: invalid MCP access policy"));
    await h.loadMcpPluginScopeContext();
    expect(h.mcpAccessPolicy.value).toBeNull();
    expect(h.mcpAccessPolicyError.value).toContain("invalid MCP access policy");
    expect(h.mcpAccessPolicyLoading.value).toBe(false);
    await h.loadMcpPluginScopeContext();
    expect(h.mcpAccessPolicyError.value).toBe("");
  });

  it("does not treat plugin discovery failure as policy corruption", async () => {
    const h = createHarness();
    h.listPlugins.mockRejectedValueOnce(new Error("plugin unavailable"));
    await h.loadMcpPluginScopeContext();
    expect(h.mcpAccessPolicy.value?.defaultAccess).toBe("read");
    expect(h.mcpAccessPolicyError.value).toBe("");
  });

  it("requires explicit confirmation and reloads the saved policy after recovery", async () => {
    const h = createHarness();
    h.mcpPolicyRecoveryConfirmation.value = true;
    h.onMcpPolicyConfirmationOpenChange(false);
    await h.recoverMcpAccessPolicy();
    expect(h.resetInvalidMcpAccessPolicy).not.toHaveBeenCalled();
    h.mcpPolicyRecoveryConfirmation.value = true;
    const pending = h.confirmMcpPolicyChange();
    await h.recoverMcpAccessPolicy(); // A second confirm cannot start another reset.
    await pending;
    expect(h.resetInvalidMcpAccessPolicy).toHaveBeenCalledOnce();
    expect(h.settingsStore.initMcpGlobalPolicy).toHaveBeenCalledWith(true);
    expect(h.mcpPolicyRecovering.value).toBe(false);
    h.resetInvalidMcpAccessPolicy.mockRejectedValueOnce(new Error("backup failed"));
    h.mcpPolicyRecoveryConfirmation.value = true;
    await h.recoverMcpAccessPolicy();
    expect(h.mcpAccessPolicyError.value).toBe("backup failed");
    expect(h.mcpPolicyRecovering.value).toBe(false);
  });
});
