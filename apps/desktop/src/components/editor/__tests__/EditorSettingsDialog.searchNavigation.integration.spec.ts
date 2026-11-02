// @vitest-environment happy-dom
import * as Vue from "vue";
import { createApp, defineComponent, h, nextTick, ref, shallowRef, watch, type App, type RenderFunction } from "vue";
import { compileTemplate } from "vue/compiler-sfc";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { AlertTriangle, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import McpCapabilityBrowser from "@/components/settings/McpCapabilityBrowser.vue";
import McpPluginToolsModeSetting from "@/components/settings/McpPluginToolsModeSetting.vue";
import { initialMcpCapabilityBrowserState, type McpCapabilityNavigator } from "@/lib/mcp/mcpCapabilitySearch";
import type { McpToolCatalog } from "@/types/mcpCatalog";
import dialogSource from "../EditorSettingsDialog.vue?raw";
import formatterSource from "../SqlFormatterSettingsPanel.vue?raw";
import { findSettingsSearchHighlightTarget } from "@/lib/settings/settingsSearchHighlight";
import { SETTINGS_SEARCH_DEFINITIONS, resolveSettingsSearchEntries, searchSettings, type SettingsSearchEntry } from "@/lib/settings/settingsSearch";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Only replace the portal/focus-trap boundary. The capability browser, tool
// panel, expansion controls and advanced slot below are production components.
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (tag: string) =>
    defineComponent({
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h(tag, attrs, slots.default?.()),
    });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      emits: ["update:open"],
      setup:
        (props, { slots, emit }) =>
        () =>
          props.open ? h("div", [...(slots.default?.() ?? []), h("button", { "data-dialog-dismiss": "", onClick: () => emit("update:open", false) })]) : null,
    }),
    DialogContent: passthrough("div"),
    DialogDescription: passthrough("p"),
    DialogHeader: passthrough("div"),
    DialogTitle: passthrough("h2"),
  };
});

const navigationTools = [
  ["sql.query", "dbx_execute_query", "database"],
  ["redis", "dbx_execute_redis_command", "database"],
  ["nacos.config", "dbx_nacos_get_config", "nacos"],
  ["consul.kv", "dbx_consul_kv_get", "consul"],
  ["mq", "dbx_peek_messages", "mq"],
  ["salesforce", "dbx_salesforce_current_user", "salesforce"],
  ["core.discovery", "dbx_list_connections", "dbx"],
] as const;

const catalog: McpToolCatalog = {
  toolsets: navigationTools.map(([id, name]) => ({
    id,
    provider: `builtin:${id.split(".")[0]}`,
    resourceKinds: [],
    scopeKinds: [],
    tools: [{ name, access: "read", accessMode: "static", coverageKind: "none", databaseTypes: [], description: `Description for ${name}`, parameters: [] }],
  })),
};

// Compile the real settings template fragment, including the component ref,
// model binding and advanced input. This avoids a duplicate placeholder UI.
const browserStart = dialogSource.indexOf("<McpCapabilityBrowser\n");
const browserEnd = dialogSource.indexOf("</McpCapabilityBrowser>", browserStart);
const compiledBrowser = compileTemplate({
  source: dialogSource.slice(browserStart, browserEnd + "</McpCapabilityBrowser>".length),
  filename: "EditorSettingsDialog.vue",
  id: "settings-navigation",
});
if (browserStart < 0 || browserEnd < 0 || compiledBrowser.errors.length) throw new Error("Could not compile the settings capability browser");
const browserExports = {} as { render: RenderFunction };
new Function("require", "exports", ts.transpileModule(compiledBrowser.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)((name: string) => {
  if (name === "vue") return Vue;
  throw new Error(`Unexpected template dependency: ${name}`);
}, browserExports);

const apps: App[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// Compile the real navigation functions; rendering only the relevant views avoids booting
// database services. Unexpected saves or other business calls fail as unresolved bindings.
function navigationHarness(initialCategory = "appearance") {
  const mutatePolicy = vi.fn();
  const savePlugin = vi.fn();
  const state = {
    settingsVisible: ref(true),
    activeSettingsTab: ref(initialCategory),
    pendingSettingsSearchNavigation: shallowRef<{ result: SettingsSearchEntry; delivered: boolean } | null>(null),
    syncMethodTab: ref("webdav"),
    mcpManagementTab: ref("access"),
    mcpTransportTab: ref("stdio"),
    formatterMode: ref("form"),
    shortcutSearchQuery: ref(""),
    aiConfigListMode: ref("list"),
    settingsSearchQuery: ref("query"),
    settingsSearchOpen: ref(true),
    settingsSearchActiveIndex: ref(0),
    settingsContentScrollRef: ref<HTMLElement | null>(null),
    highlightedSettingsSearchTargetId: ref(""),
    mcpCapabilityBrowserState: ref(initialMcpCapabilityBrowserState()),
    mcpCapabilityBrowserRef: ref<McpCapabilityNavigator>(),
    mcpToolCatalog: ref<McpToolCatalog | null>(catalog),
    mcpToolCatalogLoading: ref(false),
    mcpToolCatalogError: ref(""),
  };
  const Browser = defineComponent({
    components: { McpCapabilityBrowser, McpPluginToolsModeSetting, Button, Input, AlertTriangle, X },
    setup: () => ({
      ...state,
      t: (key: string) => key,
      mcpAllowedToolNames: [],
      mcpPolicyBaseline: { allowedToolNames: [] },
      mcpPolicyDraft: { pluginToolsMode: "flat" },
      mcpCoverageConnections: [],
      mcpPolicyControlsDisabled: false,
      mcpCatalogControlsDisabled: false,
      mcpPluginViews: [],
      mcpPluginViewsLoading: false,
      mcpPluginViewsError: "",
      mcpPluginSavingIds: new Set<string>(),
      isWeb: false,
      mcpPluginToolsBlockedByAllowlist: false,
      mcpPluginAllowlistPending: false,
      mcpCustomToolEntries: [],
      mcpCustomToolInput: ref(""),
      applyMcpToolset: mutatePolicy,
      persistMcpPluginGrant: savePlugin,
      onMcpToolsetAllowedChange: mutatePolicy,
      onMcpToolAllowedChange: mutatePolicy,
      onMcpCategoryAllowedChange: mutatePolicy,
      onMcpAllowPluginTools: mutatePolicy,
      stageMcpPolicy: mutatePolicy,
      onMcpCustomToolAdd: mutatePolicy,
      onMcpCustomToolRemove: mutatePolicy,
      ensureMcpToolCatalog: vi.fn(),
      loadMcpPluginViews: vi.fn(),
    }),
    render: browserExports.render,
  });
  const start = dialogSource.indexOf("function applySettingsSearchRoute(");
  const end = dialogSource.indexOf("function onSettingsSearchKeydown(", start);
  const watcherStart = dialogSource.indexOf("  const result = pendingSettingsSearchResult;", dialogSource.indexOf("watch(activeSettingsTab,"));
  const watcherEnd = dialogSource.indexOf("\n});", watcherStart);
  expect(start).toBeGreaterThan(0);
  expect(watcherStart).toBeGreaterThan(0);
  const code = ts.transpileModule(
    `
    let pendingSettingsSearchResult = null;
    let highlightedSettingsSearchElement = null;
    let settingsSearchHighlightTimer = null;
    let settingsSearchHighlightAnimationHandler = null;
    const settingsSearchHighlightClasses = ["settings-search-highlight-breathe"];
    function clearSettingsSearchHighlight() {
      highlightedSettingsSearchElement?.classList.remove(...settingsSearchHighlightClasses);
    }
    ${dialogSource.slice(start, end)}
    watchSettingsSearchNavigation();
    watch(activeSettingsTab, async () => { ${dialogSource.slice(watcherStart, watcherEnd)} });
    return { selectSettingsSearchResult };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const factory = new Function(...Object.keys(state), "nextTick", "watch", "findSettingsSearchHighlightTarget", code);
  let api!: {
    selectSettingsSearchResult: (entry: SettingsSearchEntry) => Promise<void>;
  };
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({
    setup() {
      // Register the production watchers in the app scope so unmount cleans up
      // pending navigation and DOM observers as it does in the settings dialog.
      api = factory(...Object.values(state), nextTick, watch, findSettingsSearchHighlightTarget);
      return () =>
        state.settingsVisible.value
          ? h("div", { ref: state.settingsContentScrollRef }, [
              state.activeSettingsTab.value === "mcp"
                ? h(
                    Tabs,
                    {
                      modelValue: state.mcpManagementTab.value,
                      "onUpdate:modelValue": (value) => {
                        state.mcpManagementTab.value = String(value);
                      },
                    },
                    {
                      default: () => [
                        h(TabsList, {}, { default: () => ["access", "permissions", "capabilities"].map((value) => h(TabsTrigger, { value }, { default: () => value })) }),
                        h(TabsContent, { value: "access" }, { default: () => h("section", { "data-settings-search-id": `mcp-${state.mcpTransportTab.value}` }, "Transport") }),
                        h(
                          TabsContent,
                          { value: "permissions" },
                          {
                            default: () => ["overrides", "connections", "call-safety"].map((id) => h("section", { "data-settings-search-id": `mcp-${id}` }, `Empty ${id}`)),
                          },
                        ),
                        h(TabsContent, { value: "capabilities", "data-settings-search-id": "mcp-capabilities" }, { default: () => h(Browser) }),
                      ],
                    },
                  )
                : h("section", { "data-settings-search-id": state.activeSettingsTab.value === "data" ? "redis-key-templates" : "appearance-settings" }, "Settings"),
            ])
          : null;
    },
  });
  app.mount(root);
  apps.push(app);
  return { ...state, ...api, root, mutatePolicy, savePlugin };
}

function entry(category: SettingsSearchEntry["category"], targetId: string, route?: SettingsSearchEntry["route"]): SettingsSearchEntry {
  return { id: targetId, targetId, category, title: "Absent title uses stable group", description: "", categoryLabel: category, route };
}

async function flush() {
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
}

function indexedMcpEntry(id: string) {
  const definition = SETTINGS_SEARCH_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing settings entry: ${id}`);
  return resolveSettingsSearchEntries([definition], { isWeb: false, visibleCategories: new Set(["mcp"]) }, (key) => key, { mcp: "MCP" } as Record<SettingsSearchEntry["category"], string>)[0]!;
}

describe("settings search navigation", () => {
  it.each(["access", "permissions"])("waits for real capability tab content when navigating from MCP %s", async (initialTab) => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    harness.mcpManagementTab.value = initialTab;
    await flush();
    expect(harness.mcpCapabilityBrowserRef.value).toBeFalsy();
    expect(harness.root.querySelector("[data-mcp-global-search]")).toBeNull();

    await harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await flush();

    const panel = harness.root.querySelector('[role="tabpanel"][data-state="active"]');
    expect(panel?.getAttribute("data-settings-search-id")).toBe("mcp-capabilities");
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(panel?.querySelector('[data-mcp-tool="dbx_nacos_get_config"] [data-mcp-tool-toggle]')?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.querySelector('[data-mcp-tool="dbx_nacos_get_config"] [data-mcp-tool-detail]')?.textContent).toContain("Description for dbx_nacos_get_config");
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
    expect(harness.savePlugin).not.toHaveBeenCalled();
  });

  it.each(["mcp-custom-tool-entries", "mcp-tool-dbx_consul_kv_get"])("uses the newest request %s while the real capability tab is mounting", async (latestId) => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    await flush();
    const first = harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await nextTick();
    expect(harness.mcpCapabilityBrowserRef.value).toBeFalsy();
    const second = harness.selectSettingsSearchResult(indexedMcpEntry(latestId));
    await Promise.all([first, second]);
    await flush();
    if (latestId === "mcp-custom-tool-entries") {
      expect(harness.root.querySelector("[data-mcp-advanced] [data-mcp-plugin-tool-entries] input")).not.toBeNull();
      expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    } else {
      expect(harness.root.querySelector('[data-mcp-tool="dbx_consul_kv_get"] [data-mcp-tool-toggle]')?.getAttribute("aria-expanded")).toBe("true");
    }
    expect(harness.root.querySelector('[data-mcp-tool="dbx_nacos_get_config"] [data-mcp-tool-detail]')).toBeNull();
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
    expect(harness.savePlugin).not.toHaveBeenCalled();
  });

  it.each(["management", "category", "close"])("cancels navigation before tab mount on %s and does not replay on return", async (leave) => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    await flush();
    const selection = harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_consul_kv_get"));
    await nextTick();
    expect(harness.mcpCapabilityBrowserRef.value).toBeFalsy();
    if (leave === "management") harness.mcpManagementTab.value = "permissions";
    if (leave === "category") harness.activeSettingsTab.value = "appearance";
    if (leave === "close") harness.settingsVisible.value = false;
    await selection;
    await flush();
    harness.settingsVisible.value = true;
    harness.activeSettingsTab.value = "mcp";
    harness.mcpManagementTab.value = "capabilities";
    await flush();
    expect(harness.root.querySelector("[data-mcp-global-search]")).not.toBeNull();
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    expect(harness.mcpCapabilityBrowserState.value.search).toBe("");
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
    expect(harness.savePlugin).not.toHaveBeenCalled();
  });

  it("cancels a delivered request when leaving and returning before the catalog arrives", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    harness.mcpToolCatalog.value = null;
    harness.mcpToolCatalogLoading.value = true;
    await harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await flush();
    expect(harness.mcpCapabilityBrowserState.value.search).toBe("dbx_nacos_get_config");
    // No render between leaving and returning: the browser is still mounted.
    harness.mcpManagementTab.value = "permissions";
    harness.mcpManagementTab.value = "capabilities";
    harness.mcpToolCatalog.value = catalog;
    harness.mcpToolCatalogLoading.value = false;
    await flush();
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
  });

  it.each(navigationTools)("reveals %s tool details from the settings index despite old filters", async (_toolset, name, category) => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    harness.mcpCapabilityBrowserState.value = { selected: "advanced", search: "unrelated", onlyEnabled: true, viewMode: "overview" };
    await harness.selectSettingsSearchResult(indexedMcpEntry(`mcp-tool-${name}`));
    await flush();
    expect(harness.root.querySelector(`[data-mcp-category="${category}"]`)?.getAttribute("aria-current")).toBe("page");
    const tool = harness.root.querySelector(`[data-mcp-toolset-detail] [data-mcp-tool="${name}"]`);
    expect(tool?.querySelector("[data-mcp-tool-toggle]")?.getAttribute("aria-expanded")).toBe("true");
    expect(tool?.querySelector("[data-mcp-tool-detail]")?.textContent).toContain(`Description for ${name}`);
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
    expect(harness.savePlugin).not.toHaveBeenCalled();
  });

  it("opens the real advanced whitelist input and can reopen the same tool within MCP", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    harness.mcpManagementTab.value = "permissions";
    await flush();
    const custom = indexedMcpEntry("mcp-custom-tool-entries");
    expect(searchSettings([custom], "settings.mcpToolCustomHint", "en")).toEqual([custom]);
    harness.mcpCapabilityBrowserState.value = { selected: "nacos", search: "stale", onlyEnabled: true, viewMode: "overview" };
    await harness.selectSettingsSearchResult(custom);
    await flush();
    const input = harness.root.querySelector<HTMLInputElement>("[data-mcp-advanced] [data-mcp-plugin-tool-entries] input");
    expect(input?.placeholder).toBe("settings.mcpToolCustomPlaceholder");
    expect(input?.disabled).toBe(false);
    const result = indexedMcpEntry("mcp-tool-dbx_consul_kv_get");
    for (let attempt = 0; attempt < 2; attempt++) {
      await harness.selectSettingsSearchResult(result);
      await flush();
      expect(harness.root.querySelector('[data-mcp-tool="dbx_consul_kv_get"] [data-mcp-tool-detail]')).not.toBeNull();
      harness.root.querySelector<HTMLButtonElement>("[data-dialog-dismiss]")!.click();
      await flush();
      expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    }
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
    expect(harness.savePlugin).not.toHaveBeenCalled();
  });

  it("waits through catalog loading and failure, then reveals the requested tool after recovery", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    harness.mcpToolCatalog.value = null;
    harness.mcpToolCatalogLoading.value = true;
    await harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await flush();
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    harness.mcpToolCatalogLoading.value = false;
    harness.mcpToolCatalogError.value = "offline";
    await flush();
    expect(harness.root.textContent).toContain("settings.mcpCapabilitiesLoadFailed");
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
    harness.mcpToolCatalog.value = catalog;
    harness.mcpToolCatalogError.value = "";
    await flush();
    expect(harness.root.querySelector('[data-mcp-tool="dbx_nacos_get_config"] [data-mcp-tool-detail]')).not.toBeNull();
    expect(harness.mutatePolicy).not.toHaveBeenCalled();
  });

  it("cancels deferred navigation when the user chooses a different category", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    harness.mcpToolCatalog.value = null;
    harness.mcpToolCatalogLoading.value = true;
    await harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await flush();
    harness.root.querySelector<HTMLButtonElement>('[data-mcp-category="advanced"]')!.click();
    await flush();
    harness.mcpToolCatalog.value = catalog;
    harness.mcpToolCatalogLoading.value = false;
    await flush();
    expect(harness.root.querySelector("[data-mcp-advanced] input")).not.toBeNull();
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
  });

  it("keeps an unavailable tool visible as an empty search instead of opening an unrelated detail", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    harness.mcpToolCatalog.value = { toolsets: [] };
    await harness.selectSettingsSearchResult(indexedMcpEntry("mcp-tool-dbx_nacos_get_config"));
    await flush();
    expect(harness.root.querySelector<HTMLInputElement>("[data-mcp-global-search]")?.value).toBe("dbx_nacos_get_config");
    expect(harness.root.textContent).toContain("settings.mcpCapabilitiesSearchEmpty");
    expect(harness.root.querySelector("[data-mcp-toolset-detail]")).toBeNull();
  });

  it("scrolls keyboard selection into view past the former eight-result limit and wraps", async () => {
    const settingsSearchResults = ref(Array.from({ length: 12 }, (_, index) => entry("editor", `entry-${index}`)));
    const settingsSearchActiveIndex = ref(7);
    const settingsSearchOpen = ref(true);
    const selectSettingsSearchResult = vi.fn();
    const exitSettingsSearch = vi.fn();
    const start = dialogSource.indexOf("function onSettingsSearchKeydown(");
    const end = dialogSource.indexOf("async function resetSettingsContentScroll(", start);
    const code = ts.transpileModule(dialogSource.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const keydown = new Function("settingsSearchResults", "settingsSearchActiveIndex", "settingsSearchOpen", "selectSettingsSearchResult", "exitSettingsSearch", "nextTick", `${code}; return onSettingsSearchKeydown;`)(
      settingsSearchResults,
      settingsSearchActiveIndex,
      settingsSearchOpen,
      selectSettingsSearchResult,
      exitSettingsSearch,
      nextTick,
    );
    const host = document.createElement("div");
    document.body.append(host);
    for (const result of settingsSearchResults.value) {
      const button = document.createElement("button");
      button.id = `settings-search-result-${result.id}`;
      host.append(button);
    }
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    for (let index = 8; index < 12; index++) {
      keydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      await nextTick();
      expect(settingsSearchActiveIndex.value).toBe(index);
      expect(scroll.mock.instances.at(-1)).toBe(host.children[index]);
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
    }
    keydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await nextTick();
    expect(settingsSearchActiveIndex.value).toBe(0);
    keydown(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    await nextTick();
    expect(settingsSearchActiveIndex.value).toBe(11);
    keydown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(selectSettingsSearchResult).toHaveBeenCalledWith(settingsSearchResults.value[11]);
  });

  it("reveals MCP permissions and capabilities across management tabs, even with no records", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    for (const tab of ["connections", "capabilities", "call-safety", "overrides"] as const) {
      await harness.selectSettingsSearchResult(entry("mcp", `mcp-${tab}`, { mcpManagementTab: tab === "capabilities" ? "capabilities" : "permissions" }));
      await flush();
      const panel = harness.root.querySelector(`[data-settings-search-id="mcp-${tab}"]`);
      expect(panel).not.toBeNull();
      expect(panel?.classList.contains("settings-search-highlight-breathe")).toBe(true);
      expect(harness.settingsSearchQuery.value).toBe("");
      expect(harness.settingsSearchOpen.value).toBe(false);
    }
    expect(scroll).toHaveBeenCalledTimes(4);
  });

  it("switches management and transport before revealing HTTP, and reaches Redis across categories", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    harness.mcpManagementTab.value = "permissions";
    await harness.selectSettingsSearchResult(entry("mcp", "mcp-http", { mcpManagementTab: "access", mcpTransportTab: "http" }));
    await flush();
    expect(harness.root.querySelector('[data-settings-search-id="mcp-http"]')?.classList.contains("settings-search-highlight-breathe")).toBe(true);
    await harness.selectSettingsSearchResult(entry("data", "redis-key-templates"));
    await flush();
    expect(harness.root.querySelector('[data-settings-search-id="redis-key-templates"]')?.classList.contains("settings-search-highlight-breathe")).toBe(true);
    expect(dialogSource).toContain('id="redis-key-templates" data-settings-search-id="redis-key-templates"');
  });

  it("changes only view refs for sync and formatter routes and wires their controlled child modes", async () => {
    const harness = navigationHarness();
    await harness.selectSettingsSearchResult(entry("formatter", "formatter-json", { formatterMode: "json", syncMethodTab: "snippet" }));
    await flush();
    expect(harness.formatterMode.value).toBe("json");
    expect(harness.syncMethodTab.value).toBe("snippet");
    expect(dialogSource).toContain('v-model:mode="formatterMode"');
    expect(formatterSource).toContain('data-settings-search-id="formatter-json"');
    expect(dialogSource).toContain("searchSettings(settingsSearchEntries.value, settingsSearchQuery.value, currentLocale(), Infinity)");
  });
});
