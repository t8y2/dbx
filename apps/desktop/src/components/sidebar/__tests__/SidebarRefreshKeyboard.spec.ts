// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: vi.fn() }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));

const mountedApps: App<Element>[] = [];

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await nextTick();
}

function mountHost(node: TreeNode) {
  const pinia = createPinia();
  setActivePinia(pinia);

  const hostRef = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const container = document.createElement("div");
  document.body.append(container);

  const Root = defineComponent({
    setup() {
      return () => h(SidebarTreeRuntimeHost, { ref: hostRef, node, depth: 0 });
    },
  });

  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);

  return { hostRef, container, pinia };
}

describe("Sidebar F5 refresh shortcut and connection database reload (#12246)", () => {
  afterEach(() => {
    for (const app of mountedApps) app.unmount();
    mountedApps.length = 0;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("exposes refreshNode and refreshes a connection node and its databases", async () => {
    const connNode: TreeNode = {
      id: "mysql-1",
      label: "MySQL Production",
      type: "connection",
      connectionId: "mysql-1",
      isExpanded: true,
      children: [],
    };

    const { hostRef } = mountHost(connNode);
    await flush();

    const connectionStore = useConnectionStore();
    connectionStore.treeNodes = [connNode];
    connectionStore.connectedIds.add("mysql-1");
    const refreshConnectionSpy = vi.spyOn(connectionStore, "refreshConnectionTreeNode").mockResolvedValue(undefined);

    expect(typeof hostRef.value?.refreshNode).toBe("function");

    const result = hostRef.value?.refreshNode(connNode);
    expect(result).toBe(true);
    await flush();
    expect(refreshConnectionSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "mysql-1", type: "connection" }));
  });

  it("refreshes a database node when selected", async () => {
    const dbNode: TreeNode = {
      id: "mysql-1:shop_db",
      label: "shop_db",
      type: "database",
      connectionId: "mysql-1",
      database: "shop_db",
      isExpanded: true,
      children: [],
    };

    const { hostRef } = mountHost(dbNode);
    await flush();

    const connectionStore = useConnectionStore();
    connectionStore.treeNodes = [dbNode];
    connectionStore.connectedIds.add("mysql-1");
    const refreshTreeNodeSpy = vi.spyOn(connectionStore, "refreshTreeNode").mockResolvedValue(undefined);

    const result = hostRef.value?.refreshNode(dbNode);
    expect(result).toBe(true);
    await flush();
    expect(refreshTreeNodeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "mysql-1:shop_db", type: "database" }));
  });

  it("updates context menu shortcut based on configured refreshData shortcut", async () => {
    const connNode: TreeNode = {
      id: "conn-1",
      label: "Local DB",
      type: "connection",
      connectionId: "conn-1",
    };

    const { hostRef } = mountHost(connNode);
    await flush();

    const connectionStore = useConnectionStore();
    connectionStore.connections = [{ id: "conn-1", name: "Local DB", db_type: "mysql" } as any];

    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.shortcuts.refreshData = "F5";
    await flush();

    const menu = hostRef.value?.buildContextMenu(connNode);
    const refreshItem = menu?.find((item) => item.sidebarActionId === "contextMenu.refreshChildren" || item.label.includes("刷新") || item.label.includes("Refresh"));
    expect(refreshItem?.shortcut).toBe("F5");

    settingsStore.editorSettings.shortcuts.refreshData = "Mod+R";
    await flush();

    const updatedMenu = hostRef.value?.buildContextMenu(connNode);
    const updatedRefreshItem = updatedMenu?.find((item) => item.sidebarActionId === "contextMenu.refreshChildren" || item.label.includes("刷新") || item.label.includes("Refresh"));
    expect(updatedRefreshItem?.shortcut).toBe("Mod+R");
  });

  it("verifies ConnectionTree, AppSidebar, and App.vue routing for F5 sidebar refresh", () => {
    const cwd = process.cwd();
    const appSource = readFileSync(resolve(cwd, "apps/desktop/src/App.vue"), "utf8");
    const appSidebarSource = readFileSync(resolve(cwd, "apps/desktop/src/components/layout/AppSidebar.vue"), "utf8");
    const connectionTreeSource = readFileSync(resolve(cwd, "apps/desktop/src/components/sidebar/ConnectionTree.vue"), "utf8");

    // In App.vue: refreshData shortcut checks isSidebarFocusedTarget and delegates to appSidebarRef.value?.refreshSidebar()
    expect(appSource).toContain("isRefreshDataShortcut(e, shortcuts)");
    expect(appSource).toMatch(/isSidebarFocusedTarget\(target,\s*lastFocusedSidebarSurface\.value\)/);
    expect(appSource).toContain("appSidebarRef.value?.refreshSidebar?.()");

    // In AppSidebar.vue: refreshSidebar delegates to ConnectionTree
    expect(appSidebarSource).toContain("connectionTreeRef.value?.refreshSidebar?.()");
    expect(appSidebarSource).toContain("refreshSidebar,");
    expect(appSidebarSource).toContain("refreshShortcutLabel");

    // In ConnectionTree.vue: handles isRefreshDataShortcut and exposes refreshSidebar
    expect(connectionTreeSource).toContain("isRefreshDataShortcut(event, settingsStore.editorSettings.shortcuts)");
    expect(connectionTreeSource).toContain("requestSelectedSidebarRefresh()");
    expect(connectionTreeSource).toContain("refreshSidebar: requestSelectedSidebarRefresh");
  });
});
