// @vitest-environment happy-dom

import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { McpConnectionPolicy } from "@/lib/backend/tauri";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`,
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { ChevronDown: icon, ChevronRight: icon, Database: icon, Folder: icon, History: icon, Loader2: icon, Plus: icon, Search: icon, Server: icon, X: icon };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Select: createPassthroughStub("Select", "div"),
    SelectContent: createPassthroughStub("SelectContent", "div"),
    SelectItem: createPassthroughStub("SelectItem", "div"),
    SelectTrigger: createPassthroughStub("SelectTrigger", "button"),
    SelectValue: createPassthroughStub("SelectValue", "span"),
  };
});

vi.mock("@/components/settings/McpDatabaseAccessDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("McpDatabaseAccessDialog", "div") }));

import McpAccessTree from "@/components/settings/McpAccessTree.vue";

function connection(id: string, dbType = "mysql"): ConnectionConfig {
  return { id, name: `${id}-name`, db_type: dbType, host: "h", port: 1, username: "u", password: "" } as ConnectionConfig;
}

const layout: SidebarLayout = {
  groups: [{ id: "prod", name: "Production", collapsed: false }] as SidebarLayout["groups"],
  order: [
    { type: "group", id: "prod", children: [{ type: "connection", id: "c1" }] },
    { type: "connection", id: "sf" },
  ],
};

function rule(patch: Partial<McpConnectionPolicy> & { connectionId: string }): McpConnectionPolicy {
  return { readOnly: false, allowDangerousSql: false, executionModeConfigured: false, executionModePolicyVersion: 1, databaseScope: "all", allowedDatabases: [], databasePolicies: [], allowSalesforceDml: false, ...patch };
}

function mountTree(policyPatch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const listeners = {
    "onSet:scope-mode": vi.fn(),
    "onSet:group-visible": vi.fn(),
    "onSet:connection-visible": vi.fn(),
    "onSet:group-level": vi.fn(),
    "onSet:connection-level": vi.fn(),
    "onSet:database-access": vi.fn(),
    "onSet:database-scope": vi.fn(),
    "onSet:database-allowed": vi.fn(),
    "onSet:database-level": vi.fn(),
    "onSet:salesforce-dml": vi.fn(),
  };
  const mounted = mountComponent(McpAccessTree, {
    policy: { readOnly: true, allowDangerousSql: false, allowedConnectionIds: null, allowedGroupIds: [], connectionPolicies: [], groupPolicies: [], ...policyPatch },
    layout,
    connections: [connection("c1"), connection("sf", "salesforce")],
    ...listeners,
    ...extra,
  });
  return { mounted, listeners };
}

const row = (root: ReturnType<typeof mountComponent>["root"], key: string) => findOne(root, (node) => node.props["data-mcp-access-row"] === key);
const control = (root: ReturnType<typeof mountComponent>["root"], attr: string, value: string) => findOne(root, (node) => node.props[attr] === value);

/** Picks a value in the shared Select whose trigger carries `attr=value`. */
function choose(root: ReturnType<typeof mountComponent>["root"], attr: string, value: string, picked: string) {
  const select = findAll(root, (node) => node.props["data-stub"] === "Select").find((node) => findAll(node, (child) => child.props[attr] === value).length > 0);
  if (!select) throw new Error(`no Select for ${attr}=${value}`);
  (select.props["onUpdate:modelValue"] as (value: string) => void)(picked);
}

describe("McpAccessTree", () => {
  it("opens groups by name and updates inherited permissions while keeping group and database overrides", async () => {
    const policy = {
      readOnly: true,
      allowDangerousSql: false,
      allowedConnectionIds: null,
      allowedGroupIds: [],
      groupPolicies: [{ groupId: "prod", readOnly: true, allowDangerousSql: false }],
      connectionPolicies: [rule({ connectionId: "sf", databaseScope: "selected", allowedDatabases: ["billing"], databasePolicies: [{ databaseName: "billing", readOnly: true, allowDangerousSql: false }] })],
    };
    const { mounted, listeners } = mountTree(policy);
    const groupName = () => control(mounted.root, "data-mcp-access-group-name", "prod");
    expect(groupName().type).toBe("button");
    expect(groupName().props["aria-expanded"]).toBe(false);
    dispatch(groupName(), "click");
    dispatch(control(mounted.root, "data-mcp-access-toggle", "connection:sf"), "click");
    await nextTick();
    await mounted.setProps({ policy: { ...policy, readOnly: false } });
    const effective = (key: string) => hostText(control(mounted.root, "data-mcp-access-effective", key));
    expect(effective("connection:sf")).toContain("settings.mcpExecutionModeSafeWrite");
    expect(effective("connection:sf")).toContain("settings.mcpAccessTreeSourceGlobal");
    expect(effective("connection:c1")).toContain("settings.mcpExecutionModeReadOnly");
    expect(effective("connection:c1")).toContain("settings.mcpAccessTreeSourceGroup");
    expect(effective("database:sf:billing")).toContain("settings.mcpExecutionModeReadOnly");
    expect(effective("database:sf:billing")).toContain("settings.mcpAccessTreeSourceDatabase");
    expect(groupName().props["aria-expanded"]).toBe(true);
    dispatch(groupName(), "click");
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-row"] === "connection:c1")).toHaveLength(0);
    dispatch(control(mounted.root, "data-mcp-access-toggle", "group:prod"), "click");
    await nextTick();
    expect(row(mounted.root, "connection:c1")).toBeDefined();
    expect(groupName().props["aria-expanded"]).toBe(true);
    expect(listeners["onSet:group-visible"]).not.toHaveBeenCalled();
    expect(listeners["onSet:group-level"]).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it.each(["selected", "none", "all"] as const)("keeps immediately saved %s scopes visible in the exceptions filter under collapsed groups", async (mode) => {
    const { mounted } = mountTree(
      {},
      {
        connections: [connection("c1", "nacos"), { ...connection("sf"), plugin_id: "test-plugin" }],
        pluginScopes: { "test-plugin": { kind: "workspace", title: "Workspace" } },
        accessPolicy: {
          version: 2,
          defaultAccess: "read",
          confirm: "never",
          visibility: "all",
          rules: [
            { target: { kind: "connection", id: "c1" }, subScope: mode, subScopeKind: "namespace" },
            ...(mode === "all" ? [{ target: { kind: "scope", connectionId: "c1", scope: "namespace", value: "public" }, visible: true, access: "read" }] : []),
            { target: { kind: "connection", id: "sf" }, subScope: "none", subScopeKind: "workspace" },
          ],
        },
        savePluginScope: vi.fn(),
      },
    );
    const toggle = findOne(mounted.root, (node) => node.props["data-mcp-access-exceptions-only"] !== undefined);
    dispatch(toggle, "update:modelValue", true);
    await nextTick();
    expect(hostText(mounted.root)).toContain('"connections":2');
    expect(row(mounted.root, "group:prod")).toBeDefined();
    expect(row(mounted.root, "connection:c1")).toBeDefined();
    expect(row(mounted.root, "connection:sf")).toBeDefined();
    mounted.unmount();
  });

  it("shows an inaccessible state instead of full access for a hidden connection", () => {
    const { mounted } = mountTree({ readOnly: false, allowDangerousSql: true, allowedConnectionIds: [] });
    const effective = hostText(control(mounted.root, "data-mcp-access-effective", "connection:sf"));
    expect(effective).toContain("settings.mcpAccessTreeHidden");
    expect(effective).not.toContain("settings.mcpExecutionModeHighRiskWrite");
    mounted.unmount();
  });

  it("shows a mixed group and a descendant count instead of hidden when only children are granted", async () => {
    const { mounted, listeners } = mountTree(
      { allowedConnectionIds: ["c1"] },
      {
        layout: {
          groups: layout.groups,
          order: [
            {
              type: "group",
              id: "prod",
              children: [
                { type: "connection", id: "c1" },
                { type: "connection", id: "sf" },
              ],
            },
          ],
        },
      },
    );
    const visibility = control(mounted.root, "data-mcp-access-visible", "group:prod");
    expect(visibility.props).toMatchObject({ checked: false, indeterminate: true, "aria-checked": "mixed", disabled: false });
    expect(hostText(control(mounted.root, "data-mcp-access-effective", "group:prod"))).toBe('settings.mcpAccessTreeGroupPartiallyVisible {"visible":1,"total":2}');
    expect(row(mounted.root, "group:prod").props.class).not.toContain("text-muted-foreground");
    const permission = findAll(mounted.root, (node) => node.props["data-stub"] === "Select").find((node) => findAll(node, (child) => child.props["data-mcp-access-setting"] === "group:prod").length)!;
    expect(permission.props.disabled).toBe(false);
    choose(mounted.root, "data-mcp-access-setting", "group:prod", "read_only");
    expect(listeners["onSet:group-level"]).toHaveBeenCalledExactlyOnceWith("prod", "read_only");
    expect(listeners["onSet:group-visible"]).not.toHaveBeenCalled();
    dispatch(visibility, "change", { target: { checked: true } });
    expect(listeners["onSet:group-visible"]).toHaveBeenCalledExactlyOnceWith("prod", true);
    expect(listeners["onSet:connection-visible"]).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("keeps a group mixed when all current children are individually selected", () => {
    const { mounted } = mountTree({ allowedConnectionIds: ["c1"] });
    expect(control(mounted.root, "data-mcp-access-visible", "group:prod").props).toMatchObject({ checked: false, indeterminate: true, "aria-checked": "mixed" });
    expect(hostText(control(mounted.root, "data-mcp-access-effective", "group:prod"))).toBe('settings.mcpAccessTreeGroupCurrentVisible {"visible":1,"total":1}');
    mounted.unmount();
  });

  it("updates saved scope exceptions reactively and counts an overlapping connection rule once", async () => {
    const { mounted } = mountTree(
      { connectionPolicies: [rule({ connectionId: "c1", executionModeConfigured: true })] },
      {
        connections: [connection("c1", "nacos"), { ...connection("sf"), plugin_id: "test-plugin" }, connection("sql")],
        pluginScopes: { "test-plugin": { kind: "workspace", title: "Workspace" } },
        accessPolicy: { version: 2, defaultAccess: "read", rules: [] },
      },
    );
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-access-exceptions-only"] !== undefined),
      "update:modelValue",
      true,
    );
    await nextTick();
    expect(hostText(mounted.root)).toContain('"connections":1');
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-row"] === "connection:sf")).toHaveLength(0);
    await mounted.setProps({
      accessPolicy: {
        version: 2,
        defaultAccess: "read",
        rules: [
          { target: { kind: "connection", id: "c1" }, subScope: "none", subScopeKind: "namespace" },
          { target: { kind: "connection", id: "sf" }, subScope: "selected", subScopeKind: "workspace" },
          // SQL changes use the staged v1 policy, not an older v2 snapshot.
          { target: { kind: "connection", id: "sql" }, subScope: "none" },
        ],
      },
    });
    expect(hostText(mounted.root)).toContain('"connections":2');
    expect(row(mounted.root, "connection:c1")).toBeDefined();
    expect(row(mounted.root, "connection:sf")).toBeDefined();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-row"] === "connection:sql")).toHaveLength(0);
    await mounted.setProps({ accessPolicy: { version: 2, defaultAccess: "read", rules: [] } });
    expect(hostText(mounted.root)).toContain('"connections":1');
    expect(row(mounted.root, "connection:c1")).toBeDefined();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-row"] === "connection:sf")).toHaveLength(0);
    mounted.unmount();
  });

  it("shows the effective level and its source per row", async () => {
    const { mounted } = mountTree({ groupPolicies: [{ groupId: "prod", readOnly: false, allowDangerousSql: false }] });
    expect(hostText(row(mounted.root, "group:prod"))).toContain("settings.mcpExecutionModeSafeWrite");
    dispatch(control(mounted.root, "data-mcp-access-toggle", "group:prod"), "click");
    await nextTick();
    const c1 = hostText(row(mounted.root, "connection:c1"));
    expect(c1).toContain("settings.mcpExecutionModeSafeWrite");
    expect(c1).toContain('settings.mcpAccessTreeSourceGroup {"group":"Production"}');
    expect(hostText(row(mounted.root, "connection:sf"))).toContain("settings.mcpAccessTreeSourceGlobal");
  });

  it("delegates level edits to the settings owner without a duplicate confirmation", async () => {
    const { mounted, listeners } = mountTree();
    choose(mounted.root, "data-mcp-access-setting", "connection:sf", "safe_write");
    expect(listeners["onSet:connection-level"]).toHaveBeenCalledWith("sf", "safe_write");
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    choose(mounted.root, "data-mcp-access-setting", "group:prod", "high_risk_write");
    expect(confirm).not.toHaveBeenCalled();
    expect(listeners["onSet:group-level"]).toHaveBeenCalledExactlyOnceWith("prod", "high_risk_write");
    vi.unstubAllGlobals();
  });

  it("locks visibility under all-connections and emits it under a custom scope", () => {
    const all = mountTree();
    expect(control(all.mounted.root, "data-mcp-access-visible", "connection:sf").props.disabled).toBe(true);
    const custom = mountTree({ allowedConnectionIds: [], allowedGroupIds: [] });
    expect(hostText(row(custom.mounted.root, "connection:sf"))).toContain("settings.mcpAccessTreeHidden");
    dispatch(control(custom.mounted.root, "data-mcp-access-visible", "connection:sf"), "change", { target: { checked: true } });
    expect(custom.listeners["onSet:connection-visible"]).toHaveBeenCalledWith("sf", true);
    dispatch(control(custom.mounted.root, "data-mcp-access-scope-mode", "all"), "click");
    expect(custom.listeners["onSet:scope-mode"]).toHaveBeenCalledWith("all");
  });

  it("shows a database summary and read-only child rows, opening the transfer editor with the saved baseline", async () => {
    const savedPolicy = { readOnly: true, allowDangerousSql: false, allowedConnectionIds: null, allowedGroupIds: [], connectionPolicies: [], groupPolicies: [] };
    const saveDatabaseAccess = vi.fn();
    const { mounted, listeners } = mountTree({ connectionPolicies: [rule({ connectionId: "sf", databaseScope: "selected", allowedDatabases: ["billing"], databasePolicies: [{ databaseName: "billing", readOnly: false, allowDangerousSql: false }] })] }, { savedPolicy, saveDatabaseAccess });
    dispatch(control(mounted.root, "data-mcp-access-toggle", "connection:sf"), "click");
    await nextTick();
    expect(hostText(row(mounted.root, "database:sf:billing"))).toContain("settings.mcpAccessTreeSourceDatabase");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-setting"] === "database:sf:billing")).toHaveLength(0);
    dispatch(control(mounted.root, "data-mcp-access-pick-databases", "sf"), "click", { currentTarget: null });
    await nextTick();
    const dialog = findOne(mounted.root, (node) => node.props["data-stub"] === "McpDatabaseAccessDialog");
    expect(dialog.props.value.allowedDatabases).toEqual(["billing"]);
    expect(dialog.props["saved-value"].databaseScope).toBe("all");
    expect(dialog.props.save).toBe(saveDatabaseAccess);
    dialog.props.onChange({ databaseScope: "none", allowedDatabases: [], databasePolicies: [] });
    expect(listeners["onSet:database-access"]).toHaveBeenCalledWith("sf", { databaseScope: "none", allowedDatabases: [], databasePolicies: [] });
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-access-exceptions-only"] !== undefined),
      "update:modelValue",
      true,
    );
    await nextTick();
    expect(findOne(mounted.root, (node) => node.props["data-stub"] === "McpDatabaseAccessDialog")).toBeDefined();
    mounted.unmount();
  });

  it("offers the Salesforce write switch only on Salesforce connections", () => {
    const { mounted, listeners } = mountTree({ readOnly: false });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-access-salesforce"] === "c1")).toEqual([]);
    dispatch(control(mounted.root, "data-mcp-access-salesforce", "sf"), "change", { target: { checked: true } });
    expect(listeners["onSet:salesforce-dml"]).toHaveBeenCalledWith("sf", true);
  });

  it("offers a direct MCP history link for connection resources", () => {
    const listener = vi.fn();
    window.addEventListener("dbx:open-mcp-call-history", listener);
    const { mounted } = mountTree();
    dispatch(control(mounted.root, "data-mcp-access-history", "connection:sf"), "click");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ connectionId: "sf", database: undefined });
    window.removeEventListener("dbx:open-mcp-call-history", listener);
  });
});
