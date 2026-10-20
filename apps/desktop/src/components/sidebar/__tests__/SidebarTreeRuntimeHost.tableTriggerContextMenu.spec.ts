// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { DatabaseType, TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    listPlugins: vi.fn().mockResolvedValue([]),
    executeQuery: vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] }),
  };
});
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";

const node = (type: TreeNode["type"], label: string, tableName?: string): TreeNode => ({
  id: `test-conn:db:${type}:${label}`,
  type,
  label,
  objectName: label,
  tableName,
  connectionId: "test-conn",
  database: "testdb",
});
const mountedApps: App<Element>[] = [];
const labels = (items: ContextMenuItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? labels(item.children) : [])]);
const tr = (key: string) => i18n.global.t(key);

async function mountHost(dbType: DatabaseType = "firebird", treeNodes: TreeNode[] = []) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.treeNodes = treeNodes;
  store.connections = [{ id: "test-conn", name: "TestDB", db_type: dbType, driver_profile: dbType, host: "localhost", port: 3050, username: "sysdba", password: "masterkey" }];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined as any);
  vi.spyOn(store, "refreshTreeNode").mockResolvedValue(undefined as any);
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: node("connection", "TestDB"), depth: 0 }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return host.value as { buildContextMenu(node: TreeNode): ContextMenuItem[] };
}

describe("Table trigger context menu", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("exposes view source and change open mode for table triggers", async () => {
    const host = await mountHost("firebird");
    const items = labels(host.buildContextMenu(node("trigger", "TR_ORDERS_BI", "ORDERS")));
    expect(items).toContain(tr("contextMenu.viewSource"));
    expect(items).toContain(tr("contextMenu.changeOpenMode"));
    expect(items).toContain(tr("contextMenu.copyName"));
  });

  it("exposes view source for database-level triggers", async () => {
    const host = await mountHost("firebird");
    const items = labels(host.buildContextMenu(node("trigger", "TR_CONN")));
    expect(items).toContain(tr("contextMenu.viewSource"));
    expect(items).toContain(tr("contextMenu.changeOpenMode"));
  });

  it("offers Copy Qualified Name for MySQL routines without schema metadata", async () => {
    const host = await mountHost("mysql");
    const routineNode: TreeNode = { ...node("procedure", "rebuild"), schema: undefined };
    const itemLabels = labels(host.buildContextMenu(routineNode));
    expect(itemLabels).toContain(tr("contextMenu.copyQualifiedName"));
  });

  it("offers and executes Copy Qualified Name for a column", async () => {
    const { copyToClipboard } = await import("@/lib/common/clipboard");
    vi.mocked(copyToClipboard).mockClear();
    const host = await mountHost("postgres");
    const column: TreeNode = {
      ...node("column", "id (bigint)", "users"),
      schema: "sales",
      meta: { name: "id" },
    };
    const menu = host.buildContextMenu(column);
    const copyItem = menu.flatMap((item) => item.children ?? []).find((item) => item.label === tr("contextMenu.copyQualifiedName"));
    expect(copyItem).toBeDefined();
    await copyItem?.action?.();
    expect(copyToClipboard).toHaveBeenCalledWith('"sales"."users"."id"');
  });

  it("uses the JDBC driver's identifier quote for a Phoenix column in the real menu action", async () => {
    const { copyToClipboard } = await import("@/lib/common/clipboard");
    vi.mocked(copyToClipboard).mockClear();
    const host = await mountHost("jdbc");
    const store = useConnectionStore();
    store.connections[0]!.driver_profile = "phoenix";
    vi.spyOn(store, "connectionIdentifierQuote").mockReturnValue('"');
    const column: TreeNode = {
      ...node("column", "first name", "T"),
      schema: "APP",
      meta: { name: "first name" },
    };
    const menu = host.buildContextMenu(column);
    const copyItem = menu.flatMap((item) => item.children ?? []).find((item) => item.label === tr("contextMenu.copyQualifiedName"));
    expect(copyItem).toBeDefined();
    await copyItem?.action?.();
    expect(copyToClipboard).toHaveBeenCalledWith('"APP"."T"."first name"');
  });

  it("rejects cross-connection qualified-name selections before writing the clipboard", async () => {
    const { copyToClipboard } = await import("@/lib/common/clipboard");
    const active = { ...node("table", "orders"), schema: "sales" };
    const other = { ...node("table", "customers"), id: "other:db:table:customers", connectionId: "other", schema: "crm" };
    const host = await mountHost("mysql", [active, other]);
    const store = useConnectionStore();
    store.selectedTreeNodeId = active.id;
    store.selectedTreeNodeIds = [active.id, other.id];
    const menu = host.buildContextMenu(active);
    const copyItem = menu.flatMap((item) => item.children ?? []).find((item) => item.label === tr("contextMenu.copyQualifiedName"));
    expect(copyItem).toBeDefined();
    await copyItem?.action?.();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("rejects a selected object whose SQL namespace is unavailable before writing the clipboard", async () => {
    const { copyToClipboard } = await import("@/lib/common/clipboard");
    const active = { ...node("table", "orders"), schema: "sales" };
    const unqualified = { ...node("procedure", "rebuild"), id: "test-conn:db:procedure:rebuild", schema: undefined };
    const host = await mountHost("postgres", [active, unqualified]);
    const store = useConnectionStore();
    store.selectedTreeNodeId = active.id;
    store.selectedTreeNodeIds = [active.id, unqualified.id];
    const menu = host.buildContextMenu(active);
    const copyItem = menu.flatMap((item) => item.children ?? []).find((item) => item.label === tr("contextMenu.copyQualifiedName"));
    expect(copyItem).toBeDefined();
    await copyItem?.action?.();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("copies fully qualified names for same-connection cross-schema selections in tree order", async () => {
    const { copyToClipboard } = await import("@/lib/common/clipboard");
    vi.mocked(copyToClipboard).mockClear();
    const active = { ...node("table", "orders"), schema: "sales" };
    const second = { ...node("view", "customer view"), id: "test-conn:db:view:customer-view", schema: "crm" };
    const host = await mountHost("postgres", [active, second]);
    const store = useConnectionStore();
    store.selectedTreeNodeId = active.id;
    store.selectedTreeNodeIds = [active.id, second.id];
    const menu = host.buildContextMenu(active);
    const copyItem = menu.flatMap((item) => item.children ?? []).find((item) => item.label === tr("contextMenu.copyQualifiedName"));
    expect(copyItem).toBeDefined();
    await copyItem?.action?.();
    expect(copyToClipboard).toHaveBeenCalledWith('"sales"."orders"\n"crm"."customer view"');
  });

  it("exposes disableTrigger for enabled SQL Server table trigger and executes SQL on action", async () => {
    const api = await import("@/lib/backend/api");
    const executeQueryMock = vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] });
    (api as any).executeQuery = executeQueryMock;

    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.disableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.enableTrigger"));

    const disableItem = menu.find((item) => item.label === tr("contextMenu.disableTrigger"));
    expect(disableItem).toBeDefined();
    await disableItem?.action?.();
    expect(executeQueryMock).toHaveBeenCalledWith("test-conn", "testdb", "DISABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];", "dbo", undefined, { timeoutSecs: expect.any(Number) });
  });

  it("exposes enableTrigger for disabled SQL Server table trigger and executes SQL on action", async () => {
    const api = await import("@/lib/backend/api");
    const executeQueryMock = vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] });
    (api as any).executeQuery = executeQueryMock;

    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: false },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.disableTrigger"));

    const enableItem = menu.find((item) => item.label === tr("contextMenu.enableTrigger"));
    expect(enableItem).toBeDefined();
    await enableItem?.action?.();
    expect(executeQueryMock).toHaveBeenCalledWith("test-conn", "testdb", "ENABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];", "dbo", undefined, { timeoutSecs: expect.any(Number) });
  });

  it("exposes both enable and disable when trigger enabled status is unknown", async () => {
    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT" },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).toContain(tr("contextMenu.disableTrigger"));
  });

  it("does not expose trigger toggle actions for unsupported databases like mysql", async () => {
    const host = await mountHost("mysql");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).not.toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.disableTrigger"));
  });
});
