// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { InstalledPlugin, TreeNode } from "@/types/database";

const { listPlugins, invokePlugin } = vi.hoisted(() => ({ listPlugins: vi.fn(), invokePlugin: vi.fn() }));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins, invokePlugin };
});
vi.mock("@/components/plugins/PluginWorkbenchHost.vue", () => ({ default: { props: ["plugin", "contribution", "context"], template: '<div data-test="plugin-dialog-workbench">{{ contribution.id }}:{{ context.id }}</div>' } }));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const connection = {
  id: "conn-1",
  name: "Test MySQL",
  db_type: "mysql",
  driver_profile: "mysql",
  host: "localhost",
  port: 3306,
  username: "",
  password: "",
};

function contextMenuPlugin(id: string, menu: "connection" | "table", label: string): InstalledPlugin {
  return {
    compatibility: { compatible: true },
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      drivers: [],
      contributions: [{ type: "context-menu", id: "example.generate", label, menu, action: { type: "open-workbench", workbench: `${id}.workbench` } }],
    },
  };
}

function connectionNode(): TreeNode {
  return { id: "conn-1", label: connection.name, type: "connection", connectionId: connection.id };
}

function tableNode(): TreeNode {
  return { id: "conn-1:app:users", label: "users", type: "table", connectionId: connection.id, database: "app", tableName: "users" };
}

const mountedApps: App<Element>[] = [];

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection];

  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: connectionNode(), depth: 0 }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await flush();
  expect(host.value).not.toBeNull();
  return { host: host as unknown as { value: { buildContextMenu(node: TreeNode): ContextMenuItem[]; resolveContextMenu(node: TreeNode, items: ContextMenuItem[]): Promise<ContextMenuItem[]> | ContextMenuItem[] } }, container };
}

function menuLabels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? menuLabels(item.children) : [])]);
}

describe("SidebarTreeRuntimeHost plugin context-menu refresh", () => {
  beforeEach(() => {
    listPlugins.mockReset();
    listPlugins.mockResolvedValue([]);
    invokePlugin.mockReset();
  });

  it("resolves connection-specific second-level items on each open and dispatches the selected id", async () => {
    listPlugins.mockResolvedValue([
      {
        compatibility: { compatible: true },
        manifest: {
          id: "com.example.tunnels",
          name: "Tunnels",
          version: "1.0.0",
          drivers: [],
          contributions: [{ type: "context-menu", id: "tunnels", label: "Tunnels", menu: "connection", dynamic: true }],
        },
      },
    ]);
    invokePlugin.mockResolvedValue({});
    invokePlugin.mockResolvedValueOnce({ items: [{ label: "Tunnels", children: [{ label: "Start saved", action: { type: "invoke", id: "start-all" } }] }] });
    const { host } = await mountHost();
    const first = await host.value.resolveContextMenu(connectionNode(), host.value.buildContextMenu(connectionNode()));
    expect(menuLabels(first)).toContain("Start saved");
    expect(invokePlugin).toHaveBeenCalledWith("com.example.tunnels", "contextMenu/resolve/tunnels", { connection: { id: "conn-1", dbType: "mysql", name: "Test MySQL", database: "" }, locale: expect.any(String) }, 500);
    first.find((item) => item.label === "Tunnels")?.children?.[0].action?.();
    await flush();
    expect(invokePlugin).toHaveBeenCalledWith("com.example.tunnels", "contextMenu/tunnels", expect.objectContaining({ itemId: "start-all" }));

    invokePlugin.mockResolvedValueOnce({ items: [{ label: "Tunnels", children: [{ label: "Stop all", action: { type: "invoke", id: "stop-all" } }] }] });
    const second = await host.value.resolveContextMenu(connectionNode(), host.value.buildContextMenu(connectionNode()));
    expect(menuLabels(second)).toContain("Stop all");
    expect(menuLabels(second)).not.toContain("Start saved");
  });

  it("opens a declared plugin workbench in a dialog without creating a tab", async () => {
    listPlugins.mockResolvedValue([
      {
        compatibility: { compatible: true },
        manifest: {
          id: "com.example.forwards",
          name: "Port forwards",
          version: "1.0.0",
          drivers: [],
          contributions: [
            { type: "context-menu", id: "forwards", label: "Port forwards", menu: "connection", dynamic: true },
            { type: "workbench", id: "com.example.forwards.manager", label: "Port forwards" },
          ],
        },
      },
    ]);
    invokePlugin.mockResolvedValue({ items: [{ label: "Port forwards", children: [{ label: "Manage port forwards", action: { type: "open-workbench", workbench: "com.example.forwards.manager", presentation: "dialog" } }] }] });
    const { host } = await mountHost();
    const openTab = vi.spyOn(useQueryStore(), "openPluginWorkbench");
    const items = await host.value.resolveContextMenu(connectionNode(), host.value.buildContextMenu(connectionNode()));
    items.find((item) => item.label === "Port forwards")?.children?.[0].action?.();
    await flush();
    expect(document.querySelector('[data-test="plugin-dialog-workbench"]')?.textContent).toContain("com.example.forwards.manager:conn-1");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("passes canonical table context to dynamic menu resolvers", async () => {
    listPlugins.mockResolvedValue([
      {
        compatibility: { compatible: true },
        manifest: {
          id: "com.example.table",
          name: "Table",
          version: "1.0.0",
          drivers: [],
          contributions: [{ type: "context-menu", id: "table.actions", label: "Actions", menu: "table", dynamic: true }],
        },
      },
    ]);
    invokePlugin.mockResolvedValue({ items: [{ label: "Inspect" }] });
    const { host } = await mountHost();
    const items = await host.value.resolveContextMenu(tableNode(), host.value.buildContextMenu(tableNode()));
    expect(menuLabels(items)).toContain("Inspect");
    expect(invokePlugin).toHaveBeenCalledWith("com.example.table", "contextMenu/resolve/table.actions", { table: { connectionId: "conn-1", database: "app", table: "users" }, locale: expect.any(String) }, 500);
  });

  it("restores an inactive plugin connection before retrying an opted-in menu action", async () => {
    listPlugins.mockResolvedValue([
      {
        compatibility: { compatible: true },
        manifest: {
          id: "com.example.tunnels",
          name: "Tunnels",
          version: "1.0.0",
          drivers: [],
          contributions: [{ type: "context-menu", id: "tunnels", label: "Tunnels", menu: "connection", dynamic: true }],
        },
      },
    ]);
    invokePlugin.mockResolvedValueOnce({ items: [{ label: "Tunnels", children: [{ label: "Start saved", action: { type: "invoke", id: "start-all", reopenConnectionOnMissing: true } }] }] });
    invokePlugin.mockRejectedValueOnce(new Error("Connection is not active; reopen it from DBX"));
    invokePlugin.mockResolvedValueOnce({ message: "Started 1 tunnel" });
    const { host } = await mountHost();
    const reconnect = vi.spyOn(useConnectionStore(), "reopenPluginConnection").mockResolvedValue(undefined);
    const items = await host.value.resolveContextMenu(connectionNode(), host.value.buildContextMenu(connectionNode()));
    items.find((item) => item.label === "Tunnels")?.children?.[0].action?.();
    await flush();
    expect(reconnect).toHaveBeenCalledWith("conn-1", "com.example.tunnels");
    expect(invokePlugin.mock.calls.filter((call) => call[1] === "contextMenu/tunnels")).toHaveLength(2);
  });

  it("passes plugin ownership to a dynamic connection resolver", async () => {
    listPlugins.mockResolvedValue([
      {
        compatibility: { compatible: true },
        manifest: {
          id: "com.example.tunnels",
          name: "Tunnels",
          version: "1.0.0",
          drivers: [],
          contributions: [{ type: "context-menu", id: "tunnels", label: "Tunnels", menu: "connection", dynamic: true }],
        },
      },
    ]);
    invokePlugin.mockResolvedValue({ items: [] });
    const { host } = await mountHost();
    useConnectionStore().connections = [{ ...connection, db_type: "plugin", plugin_id: "com.example.tunnels" }];
    await host.value.resolveContextMenu(connectionNode(), host.value.buildContextMenu(connectionNode()));
    expect(invokePlugin).toHaveBeenCalledWith("com.example.tunnels", "contextMenu/resolve/tunnels", expect.objectContaining({ ownerPluginId: "com.example.tunnels" }), 500);
  });

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("adds a table context-menu contribution installed after mount without remounting the host", async () => {
    const { host } = await mountHost();
    expect(menuLabels(host.value.buildContextMenu(tableNode()))).not.toContain("Generate test data");

    listPlugins.mockResolvedValue([contextMenuPlugin("com.example.schema-seed", "table", "Generate test data")]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(menuLabels(host.value.buildContextMenu(tableNode()))).toContain("Generate test data");
  });

  it("adds a connection context-menu contribution installed after mount without remounting the host", async () => {
    const { host } = await mountHost();
    expect(menuLabels(host.value.buildContextMenu(connectionNode()))).not.toContain("Inspect connection");

    listPlugins.mockResolvedValue([contextMenuPlugin("com.example.inspector", "connection", "Inspect connection")]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(menuLabels(host.value.buildContextMenu(connectionNode()))).toContain("Inspect connection");
  });

  it("keeps each contribution on its own menu surface", async () => {
    listPlugins.mockResolvedValue([contextMenuPlugin("com.example.schema-seed", "table", "Generate test data")]);
    const { host } = await mountHost();

    expect(menuLabels(host.value.buildContextMenu(tableNode()))).toContain("Generate test data");
    expect(menuLabels(host.value.buildContextMenu(connectionNode()))).not.toContain("Generate test data");
  });

  it("drops the contribution after the plugin set becomes empty again", async () => {
    listPlugins.mockResolvedValue([contextMenuPlugin("com.example.schema-seed", "table", "Generate test data")]);
    const { host } = await mountHost();
    expect(menuLabels(host.value.buildContextMenu(tableNode()))).toContain("Generate test data");

    listPlugins.mockResolvedValue([]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(menuLabels(host.value.buildContextMenu(tableNode()))).not.toContain("Generate test data");
  });

  it("ignores plugins that are not compatible with the current host", async () => {
    const incompatible: InstalledPlugin = { ...contextMenuPlugin("com.example.legacy", "table", "Legacy action"), compatibility: { compatible: false } };
    listPlugins.mockResolvedValue([incompatible]);
    const { host } = await mountHost();

    expect(menuLabels(host.value.buildContextMenu(tableNode()))).not.toContain("Legacy action");
  });

  it("keeps the previous contributions when a refresh fails", async () => {
    listPlugins.mockResolvedValue([contextMenuPlugin("com.example.schema-seed", "table", "Generate test data")]);
    const { host } = await mountHost();

    listPlugins.mockRejectedValue(new Error("backend unavailable"));
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(menuLabels(host.value.buildContextMenu(tableNode()))).toContain("Generate test data");
  });

  it("stops refreshing after the host is unmounted", async () => {
    await mountHost();
    expect(listPlugins).toHaveBeenCalledTimes(1);

    mountedApps.splice(0).forEach((app) => app.unmount());
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(listPlugins).toHaveBeenCalledTimes(1);
  });

  it("does not stack listeners when the host remounts", async () => {
    await mountHost();
    mountedApps.splice(0).forEach((app) => app.unmount());

    await mountHost();
    const callsAfterMount = listPlugins.mock.calls.length;

    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(listPlugins).toHaveBeenCalledTimes(callsAfterMount + 1);
  });
});
