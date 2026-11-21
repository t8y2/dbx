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

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const node = (type: TreeNode["type"], label: string, extra?: Partial<TreeNode>): TreeNode => ({
  id: `test-conn:db:${type}:${label}`,
  type,
  label,
  objectName: label,
  connectionId: "test-conn",
  database: "testdb",
  schema: "public",
  ...extra,
});

const mountedApps: App<Element>[] = [];
const labels = (items: ContextMenuItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? labels(item.children) : [])]);
const tr = (key: string) => i18n.global.t(key);

async function mountHost(dbType: DatabaseType = "postgres") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "test-conn", name: "TestDB", db_type: dbType, driver_profile: dbType, host: "localhost", port: 5432, username: "postgres", password: "password" }];
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
  return host.value as any;
}

describe("Procedure and function sidebar context menu", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("exposes editObject and viewSource for standalone procedures", async () => {
    const host = await mountHost("postgres");
    const procNode = node("procedure", "calculate_total");
    const menu = host.buildContextMenu(procNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.editObject"));
    expect(itemLabels).toContain(tr("contextMenu.viewSource"));

    const editItem = menu.find((item: ContextMenuItem) => item.sidebarActionId === "contextMenu.editObject");
    expect(editItem).toBeDefined();

    const queryStore = useQueryStore();
    const openSpy = vi.spyOn(queryStore, "openObjectSourceTabPending");
    await editItem?.action?.();
    expect(openSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEditing: true,
        request: expect.objectContaining({ name: "calculate_total", objectType: "PROCEDURE" }),
      }),
    );
  });

  it("exposes editObject and viewSource for standalone functions", async () => {
    const host = await mountHost("postgres");
    const funcNode = node("function", "get_status");
    const menu = host.buildContextMenu(funcNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.editObject"));
    expect(itemLabels).toContain(tr("contextMenu.viewSource"));

    const editItem = menu.find((item: ContextMenuItem) => item.sidebarActionId === "contextMenu.editObject");
    expect(editItem).toBeDefined();

    const queryStore = useQueryStore();
    const openSpy = vi.spyOn(queryStore, "openObjectSourceTabPending");
    await editItem?.action?.();
    expect(openSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEditing: true,
        request: expect.objectContaining({ name: "get_status", objectType: "FUNCTION" }),
      }),
    );
  });

  it("omits editObject for package members", async () => {
    const host = await mountHost("oracle");
    const memberNode = node("procedure", "pkg_member", {
      parentType: "package",
      parentName: "my_package",
    });
    const menu = host.buildContextMenu(memberNode);
    const itemLabels = labels(menu);
    expect(itemLabels).not.toContain(tr("contextMenu.editObject"));
    expect(itemLabels).toContain(tr("contextMenu.viewSource"));
  });

  it("exposes editObject and viewSource for package nodes", async () => {
    const host = await mountHost("oracle");
    const pkgNode = node("package", "user_management");
    const menu = host.buildContextMenu(pkgNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.editObject"));
    expect(itemLabels).toContain(tr("contextMenu.viewSource"));
  });
});
