// @vitest-environment happy-dom

import { defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent, type HostNode } from "@/components/grid/__tests__/vueHostHarness";
import type { McpToolCatalog, McpToolCatalogToolset, PluginMcpView } from "@/types/mcpCatalog";
import type { McpCapabilityBrowserState } from "@/lib/mcp/mcpCapabilitySearch";

const detailCalls = vi.hoisted(() => ({ builtin: vi.fn(), plugin: vi.fn(), pluginTool: vi.fn() }));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "settings.mcpBrowser.category.database.title": "数据库",
        "settings.mcpBrowser.category.nacos.title": "Nacos",
        "settings.mcpBrowser.category.consul.title": "Consul",
        "settings.mcpBrowser.category.mq.title": "消息队列",
        "settings.mcpBrowser.category.salesforce.title": "Salesforce",
        "settings.mcpBrowser.category.dbx.title": "DBX 通用",
        "settings.mcpBrowser.category.other.title": "其他能力",
        "settings.mcpToolset.sqlQuery.title": "查询与脚本",
        "settings.mcpToolset.sqlSchema.title": "对象结构",
        "settings.mcpToolset.nacosConfig.title": "配置管理",
        "settings.mcpToolset.nacosService.title": "服务管理",
      };
      return `${messages[key] ?? key}${values ? ` ${JSON.stringify(values)}` : ""}`;
    },
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Search: icon, X: icon, RefreshCw: icon, Loader2: icon };
});

vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return Object.fromEntries(["Select", "SelectContent", "SelectGroup", "SelectItem", "SelectLabel", "SelectTrigger", "SelectValue"].map((name) => [name, createPassthroughStub(name)]));
});

vi.mock("@/components/settings/McpCapabilitiesPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "McpCapabilitiesPanel",
      inheritAttrs: false,
      setup(_props, { attrs, expose }) {
        expose({ openDetail: detailCalls.builtin });
        return () => h("div", { ...attrs, "data-stub": "BuiltinPanel" });
      },
    }),
  };
});

vi.mock("@/components/settings/McpPluginCapabilities.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "McpPluginCapabilities",
      inheritAttrs: false,
      setup(_props, { attrs, expose }) {
        expose({ openDetail: detailCalls.plugin, openTool: detailCalls.pluginTool });
        return () => h("div", { ...attrs, "data-stub": "PluginPanel" });
      },
    }),
  };
});

import McpCapabilityBrowser from "@/components/settings/McpCapabilityBrowser.vue";

function toolset(id: string, names: string[], type = "mysql"): McpToolCatalogToolset {
  return {
    id,
    provider: `builtin:${id.split(".")[0]}`,
    resourceKinds: [],
    scopeKinds: [],
    tools: names.map((name) => ({ name, access: "read", accessMode: "static", coverageKind: "types", databaseTypes: [type], description: `${name} description`, parameters: [] })),
  };
}

// Deliberately shuffled: navigation order comes from the product taxonomy.
const catalog: McpToolCatalog = {
  toolsets: [
    toolset("nacos.service", ["dbx_nacos_list_services"], "nacos"),
    toolset("future.inspect", ["dbx_future_inspect"]),
    toolset("sql.schema", ["dbx_list_tables"]),
    toolset("core.discovery", ["dbx_list_connections"]),
    toolset("nacos.config", ["dbx_nacos_get_config", "dbx_nacos_publish_config"], "nacos"),
    toolset("sql.query", ["dbx_execute_query"]),
  ],
};

const plugin: PluginMcpView = {
  pluginId: "io.dbx.nacos-helper",
  pluginName: "Nacos",
  version: "1.0.0",
  authorAllowsExternal: true,
  hasSavedGrant: true,
  grant: { external: true, ceiling: "write", approvedTools: { dbx_helper__inspect: "read" }, disabledTools: [] },
  discoveryError: null,
  toolsets: [{ id: "helpers", title: "辅助工具", description: "Nacos helpers" }],
  tools: [
    { name: "dbx_helper__inspect", description: "Inspect deployment", access: "read", exposure: "exposed", toolset: "helpers", parameters: [] },
    { name: "dbx_helper__update", description: "Update deployment", access: "write", exposure: "pendingApproval", toolset: "helpers", parameters: [] },
  ],
};

type Mounted = ReturnType<typeof mountComponent>;
const mounts: Mounted[] = [];

const BrowserWithSlots = defineComponent({
  inheritAttrs: false,
  setup(_props, { attrs }) {
    return () =>
      h(McpCapabilityBrowser, attrs as never, {
        advanced: () => h("button", { "data-test-advanced-editor": "" }, "工具白名单"),
        "plugin-warning": () => h("p", { "data-test-plugin-warning": "" }, "插件白名单提示"),
      });
  },
});

function mountBrowser(props: Record<string, unknown> = {}) {
  let mounted: Mounted;
  const modelUpdates = vi.fn((value: McpCapabilityBrowserState) => void mounted.setProps({ modelValue: value }));
  const setTool = vi.fn();
  const setToolset = vi.fn();
  const setCategory = vi.fn();
  const retry = vi.fn();
  const refreshPlugins = vi.fn();
  const savedPlugin = vi.fn();
  const savePlugin = vi.fn(async () => plugin);
  mounted = mountComponent(BrowserWithSlots, {
    catalog,
    allowedToolNames: null,
    connections: [],
    plugins: [plugin],
    savePlugin,
    "onUpdate:modelValue": modelUpdates,
    "onSet:tool": setTool,
    "onSet:toolset": setToolset,
    "onSet:category": setCategory,
    onRetry: retry,
    "onRefresh:plugins": refreshPlugins,
    "onSaved:plugin": savedPlugin,
    ...props,
  });
  mounts.push(mounted);
  return { mounted, modelUpdates, setTool, setToolset, setCategory, retry, refreshPlugins, savedPlugin, savePlugin };
}

function byData(root: HostNode, name: string, value?: string) {
  return findOne(root, (node) => (value === undefined ? node.props[name] !== undefined : node.props[name] === value));
}

function builtin(root: HostNode) {
  return byData(root, "data-stub", "BuiltinPanel");
}

function plugins(root: HostNode) {
  return byData(root, "data-stub", "PluginPanel");
}

async function select(root: HostNode, category: string) {
  dispatch(byData(root, "data-mcp-category", category), "click");
  await nextTick();
}

async function search(root: HostNode, value: string) {
  byData(root, "data-mcp-global-search").props["onUpdate:modelValue"](value);
  await nextTick();
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const mounted of mounts.splice(0)) mounted.unmount();
});

describe("McpCapabilityBrowser", () => {
  it("keeps toolset saving and the saved baseline connected in category, overview and search views", async () => {
    const saveToolset = vi.fn(async () => {});
    const savedToolNames = ["dbx_nacos_get_config"];
    const { mounted } = mountBrowser({ savedToolNames, saveToolset });
    for (const mode of ["manage", "overview"] as const) {
      dispatch(byData(mounted.root, "data-mcp-view-mode", mode), "click");
      await nextTick();
      expect(builtin(mounted.root).props["saved-tool-names"]).toEqual(savedToolNames);
      await builtin(mounted.root).props["save-toolset"]("nacos.config");
    }
    await search(mounted.root, "nacos");
    await builtin(mounted.root).props["save-toolset"]("nacos.config");
    expect(saveToolset).toHaveBeenCalledTimes(3);
    expect(saveToolset).toHaveBeenLastCalledWith("nacos.config");
    expect(plugins(mounted.root).props["save-toolset"]).toBeUndefined();
  });

  it("starts at databases and retains the fixed business order independently of catalog order", () => {
    const { mounted } = mountBrowser();
    const navigation = findAll(mounted.root, (node) => node.props["data-mcp-category"] !== undefined);
    expect(navigation.map((node) => node.props["data-mcp-category"])).toEqual(["database", "nacos", "consul", "mq", "salesforce", "dbx", "other", `plugin:${plugin.pluginId}`, "advanced"]);
    expect(byData(mounted.root, "data-mcp-category", "database").props["aria-current"]).toBe("page");
    expect(byData(mounted.root, "data-mcp-category", "database").props.class).toContain("mcp-category-button-selected");
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["sql.query", "sql.schema"]);
    expect(builtin(mounted.root).props["list-hidden"]).toBe(false);
    expect(plugins(mounted.root).props["list-hidden"]).toBe(true);
    expect(byData(mounted.root, "data-mcp-view-mode", "manage").props["aria-pressed"]).toBe(true);
  });

  it("filters built-in navigation without changing the selected category or its content", async () => {
    const { mounted } = mountBrowser();
    const filter = byData(mounted.root, "data-mcp-builtin-filter");
    filter.props["onUpdate:modelValue"]("nacos");
    await nextTick();

    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] !== undefined).map((node) => node.props["data-mcp-category"])).toEqual(["nacos", `plugin:${plugin.pluginId}`, "advanced"]);
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["sql.query", "sql.schema"]);

    dispatch(byData(mounted.root, "data-mcp-clear-builtin-filter"), "click");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", "database").props["aria-current"]).toBe("page");
  });

  it("filters plugins by display name and plugin id while keeping the refresh action available", async () => {
    const secondPlugin: PluginMcpView = { ...plugin, pluginId: "com.example.timestamp-converter", pluginName: "Timestamp Converter" };
    const { mounted } = mountBrowser({ plugins: [plugin, secondPlugin] });
    const filter = byData(mounted.root, "data-mcp-plugin-filter");
    filter.props["onUpdate:modelValue"]("timestamp");
    await nextTick();

    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"]?.startsWith("plugin:")).map((node) => node.props["data-mcp-category"])).toEqual([`plugin:${secondPlugin.pluginId}`]);
    expect(byData(mounted.root, "data-mcp-plugins-refresh-nav")).toBeDefined();

    dispatch(byData(mounted.root, "data-mcp-clear-plugin-filter"), "click");
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"]?.startsWith("plugin:")).map((node) => node.props["data-mcp-category"])).toEqual([`plugin:${plugin.pluginId}`, `plugin:${secondPlugin.pluginId}`]);
  });

  it("keeps navigation filters icon-only and combines plugin refresh with the filter control", async () => {
    const { mounted } = mountBrowser();
    const builtinFilter = byData(mounted.root, "data-mcp-builtin-filter");
    const pluginFilter = byData(mounted.root, "data-mcp-plugin-filter");
    const refresh = byData(mounted.root, "data-mcp-plugins-refresh-nav");

    expect(builtinFilter.props.placeholder).toBe("");
    expect(pluginFilter.props.placeholder).toBe("");
    expect(builtinFilter.props["aria-label"]).toBeTruthy();
    expect(pluginFilter.props["aria-label"]).toBeTruthy();
    expect(builtinFilter.props["modelValue"]).toBe("");
    expect(pluginFilter.props["modelValue"]).toBe("");
    expect(refresh.parent).toBeDefined();
    expect(refresh.props.class).toContain("mcp-nav-refresh-action");

    pluginFilter.props["onUpdate:modelValue"]("sql");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-plugin-filter").parent?.props.class).toContain("active");

    dispatch(byData(mounted.root, "data-mcp-clear-plugin-filter"), "click");
    await nextTick();
    await select(mounted.root, `plugin:${plugin.pluginId}`);
    expect(byData(mounted.root, "data-mcp-category", `plugin:${plugin.pluginId}`).props.class).toContain("mcp-category-button-selected");
  });

  it("switches to a grouped global overview without losing the selected category", async () => {
    const { mounted, modelUpdates, setCategory, setToolset } = mountBrowser({ allowedToolNames: ["dbx_list_tables"] });
    await select(mounted.root, "nacos");
    dispatch(byData(mounted.root, "data-mcp-view-mode", "overview"), "click");
    await nextTick();
    expect(modelUpdates).toHaveBeenLastCalledWith({ selected: "nacos", search: "", onlyEnabled: false, viewMode: "overview" });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] !== undefined)).toEqual([]);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-overview-category"] !== undefined).map((node) => node.props["data-mcp-overview-category"])).toEqual(["database", "nacos", "consul", "mq", "salesforce", "dbx", "other"]);
    expect(hostText(byData(mounted.root, "data-mcp-overview-category", "database"))).toContain('"enabled":1');
    expect(findAll(mounted.root, (node) => node.props["data-test-plugin-warning"] !== undefined)).toHaveLength(1);

    dispatch(byData(mounted.root, "data-mcp-overview-category-enable", "database"), "click");
    expect(setCategory).toHaveBeenCalledExactlyOnceWith("database", true);
    dispatch(byData(mounted.root, "data-mcp-overview-toolset-switch", "sql.query"), "change", { target: { checked: false } });
    expect(setToolset).toHaveBeenCalledExactlyOnceWith(
      catalog.toolsets.find((item) => item.id === "sql.query"),
      false,
    );
    dispatch(byData(mounted.root, "data-mcp-view-mode", "manage"), "click");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBe("page");
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["nacos.config", "nacos.service"]);
  });

  it("collapses overview categories and opens existing toolset details with a category path", async () => {
    const { mounted } = mountBrowser();
    dispatch(byData(mounted.root, "data-mcp-view-mode", "overview"), "click");
    await nextTick();
    const category = byData(mounted.root, "data-mcp-overview-category", "database");
    const toggle = byData(category, "data-mcp-overview-category-toggle");
    expect(toggle.props["aria-expanded"]).toBe(true);
    dispatch(toggle, "click");
    await nextTick();
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(findAll(category, (node) => node.props["data-mcp-overview-toolset"] !== undefined)).toEqual([]);

    dispatch(toggle, "click");
    await nextTick();
    const toolsetRow = byData(category, "data-mcp-overview-toolset", "sql.query");
    const trigger = byData(toolsetRow, "data-mcp-overview-toolset-open");
    // Native events clear currentTarget immediately after synchronous dispatch.
    const event = { currentTarget: trigger as HostNode | null };
    (trigger.props.onClick as (event: unknown) => void)(event);
    event.currentTarget = null;
    await nextTick();
    expect(detailCalls.builtin).toHaveBeenCalledWith("sql.query", "tools", undefined, byData(toolsetRow, "data-mcp-overview-toolset-open"));
    expect(builtin(mounted.root).props["title-path"]).toBe("数据库");
  });

  it("opens plugin details from the global overview and keeps search behavior unchanged", async () => {
    const { mounted, modelUpdates } = mountBrowser();
    dispatch(byData(mounted.root, "data-mcp-view-mode", "overview"), "click");
    await nextTick();
    dispatch(byData(mounted.root, "data-mcp-overview-plugin-open"), "click");
    expect(detailCalls.plugin).toHaveBeenCalledWith(plugin.pluginId, byData(mounted.root, "data-mcp-overview-plugin-open"));
    await search(mounted.root, "dbx_nacos_get_config");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-overview"] !== undefined)).toEqual([]);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category-batch"] !== undefined)).toEqual([]);
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBeUndefined();
    await select(mounted.root, "nacos");
    expect(modelUpdates).toHaveBeenLastCalledWith({ selected: "nacos", search: "", onlyEnabled: false, viewMode: "manage" });
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBe("page");
  });

  it("keeps plugin discovery failures visible in the global overview", async () => {
    const { mounted } = mountBrowser({ plugins: [{ ...plugin, discoveryError: "sidecar unavailable", tools: [] }] });
    dispatch(byData(mounted.root, "data-mcp-view-mode", "overview"), "click");
    await nextTick();
    expect(hostText(byData(mounted.root, "data-mcp-overview-plugin", plugin.pluginId))).toContain("sidecar unavailable");
  });

  it("applies enabled-only filtering to plugins in the global overview", async () => {
    const disabledPlugin = { ...plugin, grant: { ...plugin.grant, external: false } };
    const { mounted } = mountBrowser({
      plugins: [disabledPlugin],
      modelValue: { selected: "database", search: "", onlyEnabled: true, viewMode: "overview" },
    });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-overview-plugin"] !== undefined)).toEqual([]);
    expect(hostText(byData(mounted.root, "data-mcp-overview-plugins"))).toContain("settings.mcpBrowser.emptyEnabled");
  });

  it("keeps the selected overview state on an enabled-only empty result and exposes catalog retry", async () => {
    const { mounted, retry } = mountBrowser({
      plugins: [],
      allowedToolNames: [],
      modelValue: { selected: "nacos", search: "", onlyEnabled: true, viewMode: "overview" },
    });
    expect(byData(mounted.root, "data-mcp-overview-empty")).toBeDefined();
    expect(byData(mounted.root, "data-mcp-view-mode", "overview").props["aria-pressed"]).toBe(true);
    await mounted.setProps({ loadError: "catalog unavailable" });
    dispatch(byData(mounted.root, "data-mcp-overview-retry"), "click");
    expect(retry).toHaveBeenCalledExactlyOnceWith();
    expect(byData(mounted.root, "data-mcp-overview", undefined)).toBeDefined();
  });

  it("distinguishes a plugin from the built-in product with the same display name", async () => {
    const { mounted } = mountBrowser();
    const native = byData(mounted.root, "data-mcp-category", "nacos");
    const extension = byData(mounted.root, "data-mcp-category", `plugin:${plugin.pluginId}`);
    expect(hostText(native)).toContain("Nacos");
    expect(hostText(extension)).toContain("Nacos");
    expect(hostText(extension)).toContain("settings.mcpCapabilitiesFilterPlugin");
    expect(hostText(extension)).toContain('settings.mcpPluginPendingTools {"count":1}');
    await select(mounted.root, `plugin:${plugin.pluginId}`);
    expect(plugins(mounted.root).props["selected-plugin-id"]).toBe(plugin.pluginId);
    expect(plugins(mounted.root).props["list-hidden"]).toBe(false);
    expect(builtin(mounted.root).props["list-hidden"]).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category-batch"] !== undefined)).toEqual([]);
  });

  it("lets the compact shared Select navigate to the same categories", async () => {
    const { mounted } = mountBrowser();
    byData(mounted.root, "data-stub", "Select").props["onUpdate:modelValue"]("nacos");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBe("page");
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["nacos.config", "nacos.service"]);
  });

  it.each(["nacos", "no-matching-category"])("keeps compact category navigation available with sidebar filter %s", async (query) => {
    const { mounted, modelUpdates } = mountBrowser({
      allowedToolNames: ["dbx_list_tables"],
      modelValue: { selected: "nacos", search: "", onlyEnabled: true, viewMode: "manage" },
    });
    const compactSelect = byData(mounted.root, "data-stub", "Select");
    const destinations = () => findAll(compactSelect, (node) => node.props["data-stub"] === "SelectItem").map((node) => node.props.value);
    const allDestinations = destinations();
    byData(mounted.root, "data-mcp-builtin-filter").props["onUpdate:modelValue"](query);
    await nextTick();

    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] === "database")).toEqual([]);
    expect(destinations()).toEqual(allDestinations);
    expect(destinations()).toContain("database");
    compactSelect.props["onUpdate:modelValue"]("database");
    await nextTick();

    expect(modelUpdates).toHaveBeenLastCalledWith({ selected: "database", search: "", onlyEnabled: true, viewMode: "manage" });
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["sql.query", "sql.schema"]);
    expect(builtin(mounted.root).props["allowed-tool-names"]).toEqual(["dbx_list_tables"]);
    expect(byData(mounted.root, "data-mcp-builtin-filter").props.modelValue).toBe(query);
    dispatch(byData(mounted.root, "data-mcp-clear-builtin-filter"), "click");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", "database").props["aria-current"]).toBe("page");
  });

  it.each(["timestamp", "no-matching-plugin"])("keeps compact plugin navigation available with sidebar filter %s", async (query) => {
    const secondPlugin: PluginMcpView = { ...plugin, pluginId: "com.example.timestamp-converter", pluginName: "Timestamp Converter" };
    const { mounted } = mountBrowser({ plugins: [plugin, secondPlugin] });
    const compactSelect = byData(mounted.root, "data-stub", "Select");
    const destinations = () => findAll(compactSelect, (node) => node.props["data-stub"] === "SelectItem").map((node) => node.props.value);
    const allDestinations = destinations();
    byData(mounted.root, "data-mcp-plugin-filter").props["onUpdate:modelValue"](query);
    await nextTick();

    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] === `plugin:${plugin.pluginId}`)).toEqual([]);
    expect(destinations()).toEqual(allDestinations);
    expect(destinations()).toContain(`plugin:${plugin.pluginId}`);
    compactSelect.props["onUpdate:modelValue"](`plugin:${plugin.pluginId}`);
    await nextTick();

    expect(plugins(mounted.root).props["selected-plugin-id"]).toBe(plugin.pluginId);
    expect(plugins(mounted.root).props["list-hidden"]).toBe(false);
    expect(byData(mounted.root, "data-mcp-plugin-filter").props.modelValue).toBe(query);
    dispatch(byData(mounted.root, "data-mcp-clear-plugin-filter"), "click");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", `plugin:${plugin.pluginId}`).props["aria-current"]).toBe("page");
  });

  it("searches across categories and opens a matching built-in tool with its category path and trigger", async () => {
    const { mounted } = mountBrowser();
    await search(mounted.root, "dbx_nacos_get_config");
    const result = byData(mounted.root, "data-mcp-search-result", "nacos.config/dbx_nacos_get_config");
    expect(hostText(result)).toContain("Nacos / 配置管理");
    expect(builtin(mounted.root).props["list-hidden"]).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category-batch"] !== undefined)).toEqual([]);
    dispatch(result, "click");
    await nextTick();
    expect(detailCalls.builtin).toHaveBeenCalledWith("nacos.config", "tools", "dbx_nacos_get_config", result);
    expect(builtin(mounted.root).props["title-path"]).toBe("Nacos");
  });

  it("opens plugin search matches through the plugin detail and tool handles", async () => {
    const { mounted } = mountBrowser();
    await search(mounted.root, "dbx_helper__inspect");
    const toolResult = byData(mounted.root, "data-mcp-search-result", `${plugin.pluginId}/dbx_helper__inspect`);
    dispatch(toolResult, "click");
    expect(detailCalls.pluginTool).toHaveBeenCalledWith(plugin.pluginId, "dbx_helper__inspect", toolResult);
    expect(detailCalls.builtin).not.toHaveBeenCalled();
    await search(mounted.root, plugin.pluginId);
    const pluginResult = byData(mounted.root, "data-mcp-search-result", plugin.pluginId);
    dispatch(pluginResult, "click");
    expect(detailCalls.plugin).toHaveBeenCalledWith(plugin.pluginId, pluginResult);
  });

  it("restores the previous category when search is cleared", async () => {
    const { mounted } = mountBrowser();
    await select(mounted.root, "nacos");
    await search(mounted.root, "dbx_list_tables");
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBeUndefined();
    dispatch(byData(mounted.root, "data-mcp-clear-search"), "click");
    await nextTick();
    expect(byData(mounted.root, "data-mcp-category", "nacos").props["aria-current"]).toBe("page");
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["nacos.config", "nacos.service"]);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-search-result"] !== undefined)).toEqual([]);
  });

  it("exits search when a navigation category is chosen", async () => {
    const { mounted, modelUpdates } = mountBrowser();
    await search(mounted.root, "config");
    await select(mounted.root, "dbx");
    expect(modelUpdates).toHaveBeenLastCalledWith({ selected: "dbx", search: "", onlyEnabled: false, viewMode: "manage" });
    expect(builtin(mounted.root).props["list-hidden"]).toBe(false);
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["core.discovery"]);
  });

  it("preserves category selection and navigation after the final enabled tool is turned off", async () => {
    const { mounted, setTool } = mountBrowser({ allowedToolNames: ["dbx_list_tables"] });
    dispatch(byData(mounted.root, "data-mcp-only-enabled"), "change", { target: { checked: true } });
    await nextTick();
    builtin(mounted.root).props["onSet:tool"]("dbx_list_tables", false);
    expect(setTool).toHaveBeenCalledWith("dbx_list_tables", false);
    await mounted.setProps({ allowedToolNames: [] });
    expect(byData(mounted.root, "data-mcp-category", "database").props["aria-current"]).toBe("page");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] !== undefined)).toHaveLength(9);
    expect(builtin(mounted.root).props["only-enabled"]).toBe(true);
    expect(builtin(mounted.root).props["visible-toolset-ids"]).toEqual(["sql.query", "sql.schema"]);
    expect(hostText(byData(mounted.root, "data-mcp-category-summary"))).toContain('"enabled":0');
  });

  it("emits a full category action even while only enabled tools are shown", async () => {
    const { mounted, setCategory, setTool, setToolset } = mountBrowser({ allowedToolNames: ["dbx_list_tables"] });
    dispatch(byData(mounted.root, "data-mcp-only-enabled"), "change", { target: { checked: true } });
    await nextTick();
    dispatch(byData(mounted.root, "data-mcp-category-enable"), "click");
    await nextTick();
    expect(setCategory).toHaveBeenCalledExactlyOnceWith("database", true);
    expect(setTool).not.toHaveBeenCalled();
    expect(setToolset).not.toHaveBeenCalled();
    expect(hostText(byData(mounted.root, "data-mcp-category-summary"))).toContain('"total":2');
    expect(hostText(byData(mounted.root, "data-mcp-batch-feedback"))).toContain("settings.mcpBrowser.batchChanged");
  });

  it("disables redundant batch actions and categories without tools", async () => {
    const { mounted, setCategory } = mountBrowser();
    expect(byData(mounted.root, "data-mcp-category-enable").props.disabled).toBe(true);
    dispatch(byData(mounted.root, "data-mcp-category-enable"), "click");
    expect(setCategory).not.toHaveBeenCalled();
    dispatch(byData(mounted.root, "data-mcp-category-disable"), "click");
    expect(setCategory).toHaveBeenCalledExactlyOnceWith("database", false);
    await mounted.setProps({ allowedToolNames: [] });
    expect(byData(mounted.root, "data-mcp-category-disable").props.disabled).toBe(true);
    await select(mounted.root, "consul");
    expect(byData(mounted.root, "data-mcp-category-enable").props.disabled).toBe(true);
    expect(byData(mounted.root, "data-mcp-category-disable").props.disabled).toBe(true);
  });

  it.each([{ catalog: null }, { loading: true }, { loadError: "catalog unavailable" }, { disabled: true }])("prevents edits while the catalog is unavailable or settings are locked: %j", (state) => {
    const { mounted, setCategory } = mountBrowser({ allowedToolNames: [], ...state });
    expect(builtin(mounted.root).props.disabled).toBe(true);
    expect(byData(mounted.root, "data-mcp-category-enable").props.disabled).toBe(true);
    expect(byData(mounted.root, "data-mcp-category-disable").props.disabled).toBe(true);
    dispatch(byData(mounted.root, "data-mcp-category-enable"), "click");
    expect(setCategory).not.toHaveBeenCalled();
  });

  it("forwards catalog retry both from the built-in panel and search error state", async () => {
    const { mounted, retry } = mountBrowser({ loadError: "catalog unavailable" });
    builtin(mounted.root).props.onRetry();
    expect(retry).toHaveBeenCalledTimes(1);
    await search(mounted.root, "query");
    const alert = findOne(mounted.root, (node) => node.props.role === "alert");
    expect(hostText(alert)).toContain("catalog unavailable");
    dispatch(
      findOne(alert, (node) => node.type === "button"),
      "click",
    );
    expect(retry).toHaveBeenCalledTimes(2);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-search-result"] !== undefined)).toEqual([]);
  });

  it("shows loading, error and empty plugin states and retries their source independently", async () => {
    const { mounted, refreshPlugins, retry } = mountBrowser({ plugins: null, pluginsLoading: true });
    expect(hostText(byData(mounted.root, "data-mcp-plugin-source-status"))).toContain("settings.mcpPluginsLoading");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-source-retry"] !== undefined)).toEqual([]);
    await mounted.setProps({ pluginsLoading: false, pluginsError: "plugin unavailable" });
    expect(hostText(byData(mounted.root, "data-mcp-plugin-source-status"))).toContain("plugin unavailable");
    dispatch(byData(mounted.root, "data-mcp-plugin-source-retry"), "click");
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    await mounted.setProps({ pluginsError: "", plugins: [] });
    expect(hostText(byData(mounted.root, "data-mcp-plugin-source-status"))).toContain("settings.mcpPluginsEmpty");
    expect(builtin(mounted.root).props.disabled).toBe(false);
  });

  it("keeps plugin refresh available with a populated catalog and disables it while loading", async () => {
    const { mounted, refreshPlugins } = mountBrowser();
    const refresh = () => byData(mounted.root, "data-mcp-plugins-refresh-nav");
    expect(refresh().props.disabled).not.toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-source-status"] !== undefined)).toEqual([]);
    dispatch(refresh(), "click");
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
    await mounted.setProps({ pluginsLoading: true });
    expect(refresh().props.disabled).toBe(true);
    dispatch(refresh(), "click");
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
  });

  it("shows advanced controls only when that navigation entry is selected", async () => {
    const { mounted } = mountBrowser();
    expect(findAll(mounted.root, (node) => node.props["data-test-advanced-editor"] !== undefined)).toEqual([]);
    await select(mounted.root, "advanced");
    expect(hostText(byData(mounted.root, "data-mcp-advanced"))).toContain("工具白名单");
    expect(builtin(mounted.root).props["list-hidden"]).toBe(true);
    expect(plugins(mounted.root).props["list-hidden"]).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category-batch"] !== undefined)).toEqual([]);
    await search(mounted.root, "query");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-advanced"] !== undefined)).toEqual([]);
  });

  it("keeps built-in draft events and plugin persistence separate", async () => {
    const { mounted, setTool, setToolset, setCategory, savePlugin, savedPlugin } = mountBrowser();
    const entry = catalog.toolsets.find((item) => item.id === "sql.query")!;
    builtin(mounted.root).props["onSet:tool"]("dbx_execute_query", false);
    builtin(mounted.root).props["onSet:toolset"](entry, false);
    expect(setTool).toHaveBeenCalledExactlyOnceWith("dbx_execute_query", false);
    expect(setToolset).toHaveBeenCalledExactlyOnceWith(entry, false);
    expect(savePlugin).not.toHaveBeenCalled();
    await select(mounted.root, `plugin:${plugin.pluginId}`);
    expect(plugins(mounted.root).props.save).toBe(savePlugin);
    const saved = await plugins(mounted.root).props.save(plugin.pluginId, plugin.grant, false);
    plugins(mounted.root).props.onSaved(saved);
    expect(savePlugin).toHaveBeenCalledExactlyOnceWith(plugin.pluginId, plugin.grant, false);
    expect(savedPlugin).toHaveBeenCalledExactlyOnceWith(plugin);
    expect(setTool).toHaveBeenCalledTimes(1);
    expect(setToolset).toHaveBeenCalledTimes(1);
    expect(setCategory).not.toHaveBeenCalled();
  });

  it("hides plugin navigation, results and source controls when plugins are unsupported", async () => {
    const { mounted } = mountBrowser({ showPlugins: false, pluginsError: "not supported" });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-category"] === `plugin:${plugin.pluginId}` || node.props["data-stub"] === "PluginPanel" || node.props["data-mcp-plugin-source-status"] !== undefined)).toEqual([]);
    await search(mounted.root, "dbx_helper__inspect");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-search-result"] !== undefined)).toEqual([]);
  });
});
