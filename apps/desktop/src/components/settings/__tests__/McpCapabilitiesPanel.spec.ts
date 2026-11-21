// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { McpToolCatalog } from "@/types/mcpCatalog";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const known: Record<string, string> = { "settings.mcpToolset.sqlSchema.title": "对象结构", "settings.mcpToolset.sqlSchema.description": "浏览表、字段和存储过程源码。" };
      return `${known[key] ?? key}${values ? ` ${JSON.stringify(values)}` : ""}`;
    },
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { AlertTriangle: icon, ChevronDown: icon, ChevronRight: icon, Loader2: icon, Minus: icon, Search: icon };
});

vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/switch", async () => ({ Switch: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Switch", "button") }));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    // Render the dialog body only while open, like the real portal.
    Dialog: defineComponent({
      name: "Dialog",
      props: { open: Boolean },
      emits: ["update:open"],
      setup(props, { slots, emit }) {
        return () => (props.open ? h("div", { "data-stub": "Dialog" }, [...(slots.default?.() ?? []), h("button", { "data-dialog-dismiss": "", onClick: () => emit("update:open", false) })]) : null);
      },
    }),
    DialogContent: createPassthroughStub("DialogContent", "div"),
    DialogDescription: createPassthroughStub("DialogDescription", "p"),
    DialogHeader: createPassthroughStub("DialogHeader", "div"),
    DialogTitle: createPassthroughStub("DialogTitle", "h2"),
  };
});

import McpCapabilitiesPanel from "@/components/settings/McpCapabilitiesPanel.vue";

const catalog: McpToolCatalog = {
  toolsets: [
    {
      id: "sql.schema",
      provider: "builtin:sql",
      resourceKinds: ["database"],
      scopeKind: "database",
      scopeKinds: ["database"],
      tools: [
        {
          name: "dbx_list_tables",
          access: "read",
          accessMode: "static",
          coverageKind: "capability",
          databaseTypes: ["mysql", "sqlite"],
          description: "List tables and views for a database connection",
          parameters: [
            { name: "connection_id", valueType: "string", required: true, description: "Unique ID of the DBX connection" },
            { name: "limit", valueType: "integer", required: false, default: 100, description: "Maximum rows" },
          ],
        },
        { name: "dbx_get_routine_source", access: "read", accessMode: "static", coverageKind: "capability", databaseTypes: ["mysql"], description: "", parameters: [] },
      ],
    },
    {
      id: "salesforce",
      provider: "builtin:salesforce",
      resourceKinds: ["org"],
      scopeKind: "org",
      scopeKinds: ["org"],
      tools: [{ name: "dbx_salesforce_current_user", access: "read", accessMode: "static", coverageKind: "types", databaseTypes: ["salesforce"], description: "", parameters: [] }],
    },
    {
      id: "admin.connections",
      provider: "builtin:admin",
      resourceKinds: [],
      scopeKinds: [],
      tools: [{ name: "dbx_add_connection", access: "write", accessMode: "static", coverageKind: "none", databaseTypes: [], description: "", parameters: [] }],
    },
  ],
};

const connections = [
  { id: "c1", name: "local-mysql", dbType: "mysql" },
  { id: "c2", name: "notes", dbType: "sqlite" },
  { id: "c3", name: "dev-nacos", dbType: "nacos" },
];

function mountPanel(props: Record<string, unknown> = {}) {
  const setToolset = vi.fn();
  const setTool = vi.fn();
  const mounted = mountComponent(McpCapabilitiesPanel, {
    catalog,
    allowedToolNames: null,
    connections,
    "onSet:toolset": setToolset,
    "onSet:tool": setTool,
    ...props,
  });
  return { mounted, setToolset, setTool };
}

function card(root: ReturnType<typeof mountComponent>["root"], id: string) {
  return findOne(root, (node) => node.props["data-mcp-toolset"] === id);
}

describe("McpCapabilitiesPanel", () => {
  it("applies in place, locks edits while saving, and retains the expanded tool", async () => {
    let complete!: () => void;
    const saving = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const saveToolset = vi.fn(async () => {
      await saving;
      await mounted.setProps({ savedToolNames: ["dbx_list_tables"] });
    });
    const { mounted } = mountPanel({ allowedToolNames: ["dbx_list_tables"], savedToolNames: null, saveToolset });
    mounted.exposed.value.openDetail("sql.schema");
    await nextTick();
    const detail = () => findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    const apply = () => findOne(detail(), (node) => node.props["data-mcp-toolset-apply"] !== undefined);
    expect(hostText(detail())).toContain('settings.mcpToolsetPending {"count":1}');
    dispatch(
      findOne(detail(), (node) => node.props["data-mcp-tool-toggle"] !== undefined),
      "click",
    );
    await nextTick();
    const request = apply().props.onClick();
    await nextTick();
    expect(saveToolset).toHaveBeenCalledWith("sql.schema");
    expect(apply().props.disabled).toBe(true);
    expect(findAll(detail(), (node) => node.props["data-stub"] === "Switch").every((node) => node.props.disabled)).toBe(true);
    const escape = new Event("keydown", { cancelable: true });
    detail().props.onEscapeKeyDown(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(detail().props["show-close-button"]).toBe(false);
    await apply().props.onClick();
    expect(saveToolset).toHaveBeenCalledOnce();
    dispatch(
      findOne(detail(), (node) => node.props["data-mcp-toolset-close"] !== undefined),
      "click",
    );
    await nextTick();
    expect(detail()).toBeDefined();
    complete();
    await request;
    await nextTick();
    expect(hostText(detail())).toContain("settings.mcpToolsetApplied");
    expect(findAll(detail(), (node) => node.props["data-mcp-tool-detail"] !== undefined)).toHaveLength(1);
    expect(apply().props.disabled).toBe(true);
    mounted.unmount();
  });

  it("shows a failed save inside the dialog and retries without losing the switches", async () => {
    const saveToolset = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async () => {
        await mounted.setProps({ savedToolNames: ["dbx_list_tables"] });
      });
    const { mounted } = mountPanel({ allowedToolNames: ["dbx_list_tables"], savedToolNames: null, saveToolset });
    mounted.exposed.value.openDetail("sql.schema");
    await nextTick();
    const apply = () => findOne(mounted.root, (node) => node.props["data-mcp-toolset-apply"] !== undefined);
    await apply().props.onClick();
    await nextTick();
    expect(hostText(findOne(mounted.root, (node) => node.props["data-mcp-toolset-save-error"] !== undefined))).toContain("disk full");
    expect(apply().props.disabled).toBe(false);
    const switches = findAll(
      findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined),
      (node) => node.props["data-stub"] === "Switch",
    );
    expect(switches.map((node) => node.props["model-value"] ?? node.props.modelValue)).toEqual([true, false]);
    await apply().props.onClick();
    await nextTick();
    expect(saveToolset).toHaveBeenCalledTimes(2);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset-save-error"] !== undefined)).toEqual([]);
    expect(hostText(mounted.root)).toContain("settings.mcpToolsetApplied");
    mounted.unmount();
  });

  it.each(["footer", "dismiss"])("keeps changed switches as drafts after %s closing and reopening, without saving", async (method) => {
    const saveToolset = vi.fn();
    const { mounted, setTool } = mountPanel({ savedToolNames: null, saveToolset });
    mounted.exposed.value.openDetail("sql.schema");
    await nextTick();
    const detail = () => findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    const toggle = findAll(detail(), (node) => node.props["data-stub"] === "Switch")[1];
    toggle.props["onUpdate:modelValue"](false);
    expect(setTool).toHaveBeenCalledWith("dbx_get_routine_source", false);
    // The parent owns the shared draft and feeds the edited list back to the dialog.
    await mounted.setProps({ allowedToolNames: ["dbx_list_tables"] });
    expect(hostText(detail())).toContain("settings.mcpToolsetCloseKeepsDraft");
    if (method === "footer")
      dispatch(
        findOne(detail(), (node) => node.props["data-mcp-toolset-close"] !== undefined),
        "click",
      );
    else
      dispatch(
        findOne(mounted.root, (node) => node.props["data-dialog-dismiss"] !== undefined),
        "click",
      );
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined)).toEqual([]);
    expect(saveToolset).not.toHaveBeenCalled();
    mounted.exposed.value.openDetail("sql.schema");
    await nextTick();
    expect(hostText(detail())).toContain('settings.mcpToolsetPending {"count":1}');
    const switches = findAll(detail(), (node) => node.props["data-stub"] === "Switch");
    expect(switches.map((node) => node.props["model-value"] ?? node.props.modelValue)).toEqual([true, false]);
    await mounted.setProps({ allowedToolNames: null });
    expect(findOne(detail(), (node) => node.props["data-mcp-toolset-apply"] !== undefined).props.disabled).toBe(true);
    expect(hostText(detail())).not.toContain("settings.mcpToolsetPending");
    mounted.unmount();
  });

  it("renders compact coverage without resource ids or per-tool type summaries", () => {
    const { mounted } = mountPanel();
    const schema = hostText(card(mounted.root, "sql.schema"));
    expect(schema).toContain("对象结构");
    expect(schema).toContain('settings.mcpBrowser.coverageConnections {"count":2}');
    // SQLite is reached by list_tables but not by routine source.
    expect(schema).toContain('settings.mcpBrowser.coveragePartialConnections {"count":1}');
    expect(schema).not.toContain("settings.mcpCoverageToolTypes");
    expect(findAll(card(mounted.root, "sql.schema"), (node) => node.props["data-mcp-scope-kinds"] !== undefined)).toEqual([]);

    expect(hostText(card(mounted.root, "salesforce"))).toContain("settings.mcpBrowser.noMatchingConnections");
    expect(hostText(card(mounted.root, "admin.connections"))).toContain("settings.mcpCoverageNotBound");
  });

  it("leaves page search and headings to the browser", () => {
    const { mounted } = mountPanel();
    expect(findAll(mounted.root, (node) => node.type === "input" || node.type === "header")).toEqual([]);
  });

  it("scopes the list to requested toolsets and applies the enabled filter", () => {
    const { mounted } = mountPanel({ visibleToolsetIds: ["sql.schema", "salesforce"], onlyEnabled: true, allowedToolNames: ["dbx_list_tables"] });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset"] !== undefined).map((node) => node.props["data-mcp-toolset"])).toEqual(["sql.schema"]);
    expect(hostText(card(mounted.root, "sql.schema"))).toContain('settings.mcpBrowser.enabledToolCount {"enabled":1,"total":2}');
    expect(hostText(card(mounted.root, "sql.schema"))).toContain("settings.mcpBrowser.partialEnabled");
  });

  it("keeps toolsets configurable when there are no matching connections", () => {
    const { mounted, setToolset } = mountPanel({ connections: [], allowedToolNames: [] });
    const row = card(mounted.root, "salesforce");
    expect(row.props.class).not.toContain("opacity");
    const toggle = findOne(row, (node) => node.props["data-stub"] === "Switch");
    expect(toggle.props.disabled).toBe(false);
    (toggle.props["onUpdate:modelValue"] as (value: boolean) => void)(true);
    expect(setToolset).toHaveBeenCalledWith(catalog.toolsets[1], true);
  });

  it("emits toolset switches from the allowlist state", () => {
    const { mounted, setToolset } = mountPanel({ allowedToolNames: ["dbx_list_tables"] });
    const toggle = findOne(card(mounted.root, "sql.schema"), (node) => node.props["data-stub"] === "Switch");
    expect(toggle.props["model-value"] ?? toggle.props.modelValue).toBe(true);
    const handler = toggle.props["onUpdate:modelValue"] as (value: boolean) => void;
    handler(false);
    expect(setToolset).toHaveBeenCalledWith(catalog.toolsets[0], false);

    const salesforceToggle = findOne(card(mounted.root, "salesforce"), (node) => node.props["data-stub"] === "Switch");
    expect(salesforceToggle.props["model-value"] ?? salesforceToggle.props.modelValue).toBe(false);
  });

  it("opens the coverage detail with only supported types, grouped by category", async () => {
    const { mounted } = mountPanel();
    dispatch(
      findOne(card(mounted.root, "sql.schema"), (node) => node.props["data-mcp-coverage-link"] !== undefined),
      "click",
    );
    await nextTick();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-coverage-detail"] !== undefined);
    const text = hostText(detail);
    expect(text).toContain("connection.databaseCategorySql");
    expect(text).toContain("connection.databaseCategoryLightweight");
    expect(text).toContain("MySQL");
    expect(text).toContain("SQLite");
    // No unsupported type is listed (catalog-wide types such as Salesforce stay out).
    expect(text).not.toContain("Salesforce");
    // SQLite is reached by list_tables only: it carries the partial marker, and a
    // tool supporting none of a row is not spelled out as "0 of N".
    expect(text).toContain("SQLite *");
    expect(text).not.toContain("settings.mcpCoveragePartialTool");
  });

  it("recomputes partial coverage counts for the types matching the search", async () => {
    const toolset = catalog.toolsets[0];
    const { mounted } = mountPanel({
      catalog: {
        toolsets: [
          {
            ...toolset,
            tools: [
              { ...toolset.tools[0], databaseTypes: ["mysql", "postgres", "tidb"] },
              { ...toolset.tools[1], databaseTypes: ["mysql", "tidb"] },
            ],
          },
        ],
      },
    });
    mounted.exposed.value.openDetail("sql.schema", "coverage");
    await nextTick();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-coverage-detail"] !== undefined);
    const input = findOne(detail, (node) => node.props["data-stub"] === "Input");
    input.props["onUpdate:modelValue"]("sql");
    await nextTick();
    const text = hostText(detail);
    expect(text).toContain("MySQL");
    expect(text).toContain("PostgreSQL");
    expect(text).not.toContain("TiDB");
    expect(text).toContain('settings.mcpCoveragePartialTool {"tool":"settings.mcpToolGetRoutineSource","count":1,"total":2}');
    mounted.unmount();
  });

  it("lists every tool with its own switch and an expandable detail", async () => {
    const { mounted, setTool } = mountPanel({ allowedToolNames: ["dbx_list_tables"] });
    const opener = findAll(card(mounted.root, "sql.schema"), (node) => node.type === "button")[0];
    dispatch(opener, "click");
    await nextTick();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    // Unsupported connections collapse into a count until the tool is expanded.
    expect(hostText(detail)).toContain('settings.mcpToolSkippedConnections {"count":1}');
    expect(findAll(detail, (node) => node.props["data-mcp-tool-detail"] !== undefined)).toEqual([]);

    const switches = findAll(detail, (node) => node.props["data-stub"] === "Switch");
    expect(switches.map((node) => node.props["model-value"] ?? node.props.modelValue)).toEqual([true, false]);
    (switches[1].props["onUpdate:modelValue"] as (value: boolean) => void)(true);
    expect(setTool).toHaveBeenCalledWith("dbx_get_routine_source", true);

    const listTables = findOne(detail, (node) => node.props["data-mcp-tool"] === "dbx_list_tables");
    dispatch(
      findOne(listTables, (node) => node.props["data-mcp-tool-toggle"] !== undefined),
      "click",
    );
    await nextTick();
    const expanded = hostText(findOne(mounted.root, (node) => node.props["data-mcp-tool-detail"] !== undefined));
    expect(expanded).toContain("List tables and views for a database connection");
    expect(expanded).toContain("connection_id");
    expect(expanded).toContain("settings.mcpToolDetailParameterRequiredYes");
    expect(expanded).toContain('settings.mcpToolDetailParameterDefault {"value":"100"}');
    expect(expanded).toContain('settings.mcpToolDetailCoverage {"count":2}');
    expect(expanded).toContain("MySQL");
    expect(expanded).toContain("SQLite");
  });

  it("names the connections a tool skips inside its expanded detail", async () => {
    const { mounted } = mountPanel();
    dispatch(findAll(card(mounted.root, "sql.schema"), (node) => node.type === "button")[0], "click");
    await nextTick();
    const routine = findOne(mounted.root, (node) => node.props["data-mcp-tool"] === "dbx_get_routine_source");
    dispatch(
      findOne(routine, (node) => node.props["data-mcp-tool-toggle"] !== undefined),
      "click",
    );
    await nextTick();
    const coverage = hostText(findOne(routine, (node) => node.props["data-mcp-tool-coverage"] !== undefined));
    expect(coverage).toContain('settings.mcpToolDetailSkippedConnections {"names":"notes"}');
    expect(coverage).toContain("MySQL");
    expect(coverage).not.toContain("SQLite");
  });

  it("shows the load error instead of cards", () => {
    const { mounted } = mountPanel({ catalog: null, loadError: "boom" });
    expect(hostText(mounted.root)).toContain('settings.mcpCapabilitiesLoadFailed {"error":"boom"}');
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset"] !== undefined)).toEqual([]);
  });

  it("emits retry and disables retry while loading", async () => {
    const retry = vi.fn();
    const { mounted } = mountPanel({ catalog: null, loadError: "boom", onRetry: retry });
    const button = () => findOne(mounted.root, (node) => node.props["data-mcp-catalog-retry"] !== undefined);
    dispatch(button(), "click");
    expect(retry).toHaveBeenCalledTimes(1);
    await mounted.setProps({ loading: true });
    dispatch(button(), "click");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps details open when the row is filtered away or its last tool is disabled", async () => {
    const { mounted } = mountPanel({ visibleToolsetIds: ["sql.schema"], onlyEnabled: true, titlePath: "数据库" });
    dispatch(
      findOne(card(mounted.root, "sql.schema"), (node) => node.props["data-mcp-toolset-open"] !== undefined),
      "click",
    );
    await nextTick();
    await mounted.setProps({ allowedToolNames: [] });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset"] !== undefined)).toEqual([]);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-tool"] !== undefined)).toHaveLength(2);
    await mounted.setProps({ visibleToolsetIds: ["salesforce"], filterKind: "plugin", titlePath: "Salesforce" });
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    expect(hostText(detail)).toContain("数据库 / 对象结构");
    expect(hostText(detail)).not.toContain("Salesforce / 对象结构");
  });

  it("exposes detail opening for a hidden result and expands the requested tool", async () => {
    const { mounted } = mountPanel({ visibleToolsetIds: [], listHidden: true });
    mounted.exposed.value.openDetail("sql.schema", "tools", "dbx_list_tables");
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-capability-list"] !== undefined)).toEqual([]);
    const tool = findOne(mounted.root, (node) => node.props["data-mcp-tool"] === "dbx_list_tables");
    expect(findOne(tool, (node) => node.props["data-mcp-tool-toggle"] !== undefined).props["aria-expanded"]).toBe(true);
    expect(hostText(tool)).toContain("List tables and views for a database connection");
    const other = findOne(mounted.root, (node) => node.props["data-mcp-tool"] === "dbx_get_routine_source");
    expect(findOne(other, (node) => node.props["data-mcp-tool-toggle"] !== undefined).props["aria-expanded"]).toBe(false);
  });

  it("translates resource kinds in details only", async () => {
    const resourceKinds = ["database", "dbIndex", "topic", "queue", "org", "namespace"];
    const { mounted } = mountPanel({ catalog: { toolsets: [{ ...catalog.toolsets[0], resourceKinds }] } });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-scope-kinds"] !== undefined)).toEqual([]);
    mounted.exposed.value.openDetail("sql.schema");
    await nextTick();
    const scopes = hostText(findOne(mounted.root, (node) => node.props["data-mcp-scope-kinds"] !== undefined));
    expect(scopes).toContain("settings.mcpBrowser.resourceScopes");
    for (const kind of resourceKinds) expect(scopes).toContain(`settings.mcpBrowser.resourceKind.${kind}`);
  });

  it("restores focus to the row that opened the detail", async () => {
    const { mounted } = mountPanel();
    const opener = findOne(card(mounted.root, "sql.schema"), (node) => node.props["data-mcp-toolset-open"] !== undefined);
    dispatch(opener, "click");
    await nextTick();
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-toolset-close"] !== undefined),
      "click",
    );
    await nextTick();
    expect(opener.focused).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined)).toEqual([]);
  });

  it("restores focus to an external search trigger through dialog close autofocus", async () => {
    const { mounted } = mountPanel({ listHidden: true });
    const searchTrigger = document.createElement("button");
    document.body.append(searchTrigger);
    searchTrigger.focus();
    try {
      mounted.exposed.value.openDetail("sql.schema", "tools", "dbx_list_tables");
      await nextTick();
      searchTrigger.blur();
      const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
      const event = new Event("close-auto-focus", { cancelable: true });
      detail.props.onCloseAutoFocus(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(searchTrigger);
    } finally {
      searchTrigger.remove();
      mounted.unmount();
    }
  });

  it("preserves default focus recovery when the search trigger was removed", async () => {
    const { mounted } = mountPanel({ listHidden: true });
    const searchTrigger = document.createElement("button");
    document.body.append(searchTrigger);
    mounted.exposed.value.openDetail("sql.schema", "tools", undefined, searchTrigger);
    await nextTick();
    searchTrigger.remove();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    const event = new Event("close-auto-focus", { cancelable: true });
    detail.props.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(false);
    mounted.unmount();
  });

  it("uses the supplied focus fallback when filtering removed the detail trigger", async () => {
    const trigger = document.createElement("button");
    const fallbackTarget = document.createElement("input");
    document.body.append(trigger, fallbackTarget);
    const focusFallback = vi.fn(() => fallbackTarget.focus());
    const { mounted } = mountPanel({ listHidden: true, focusFallback });
    try {
      mounted.exposed.value.openDetail("sql.schema", "tools", undefined, trigger);
      await nextTick();
      const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
      const closeAutoFocus = detail.props.onCloseAutoFocus;
      trigger.remove();
      dispatch(
        findOne(detail, (node) => node.props["data-mcp-toolset-close"] !== undefined),
        "click",
      );
      await nextTick();
      expect(focusFallback).toHaveBeenCalled();
      expect(document.activeElement).toBe(fallbackTarget);
      const event = new Event("close-auto-focus", { cancelable: true });
      closeAutoFocus(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      mounted.unmount();
      trigger.remove();
      fallbackTarget.remove();
    }
  });

  it("keeps unknown toolsets usable without displaying missing translation keys", async () => {
    const { mounted, setToolset } = mountPanel({ catalog: { toolsets: [{ ...catalog.toolsets[0], id: "future.inspect" }] }, titlePath: "其他能力" });
    const row = card(mounted.root, "future.inspect");
    expect(hostText(row)).toContain("future.inspect");
    expect(hostText(row)).not.toContain("settings.mcpToolset.futureInspect");
    const toggle = findOne(row, (node) => node.props["data-stub"] === "Switch");
    (toggle.props["onUpdate:modelValue"] as (value: boolean) => void)(false);
    expect(setToolset).toHaveBeenCalledWith(expect.objectContaining({ id: "future.inspect" }), false);
    mounted.exposed.value.openDetail("future.inspect");
    await nextTick();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-toolset-detail"] !== undefined);
    expect(hostText(detail)).toContain("其他能力 / future.inspect");
    expect(findAll(detail, (node) => node.props["data-mcp-tool"] !== undefined)).toHaveLength(2);
    mounted.unmount();
  });

  it("scrolls to and focuses a direct tool after the real DOM detail is rendered", async () => {
    const container = document.createElement("div");
    const trigger = document.createElement("button");
    document.body.append(trigger, container);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const app = createApp(McpCapabilitiesPanel, { catalog, allowedToolNames: null, connections, listHidden: true });
    const panel = app.mount(container) as unknown as { openDetail: (id: string, view: string, toolName: string, trigger: HTMLElement) => void };
    try {
      panel.openDetail("sql.schema", "tools", "dbx_get_routine_source", trigger);
      await nextTick();
      const row = container.querySelector('[data-mcp-tool="dbx_get_routine_source"]');
      const opener = row?.querySelector("[data-mcp-tool-toggle]");
      expect(row).not.toBeNull();
      expect(opener?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(opener);
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts).toContain(row);
      (container.querySelector("[data-mcp-toolset-close]") as HTMLButtonElement).click();
      await nextTick();
      expect(document.activeElement).toBe(trigger);
    } finally {
      app.unmount();
      scroll.mockRestore();
      trigger.remove();
      container.remove();
    }
  });
});
