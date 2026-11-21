// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]) };
});

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";

const mountedApps: App<Element>[] = [];
const tr = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params || {});

async function mountHost(groupNode: TreeNode) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: groupNode, depth: 0 }) });
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
  return { host: host.value as { buildContextMenu(node: TreeNode): ContextMenuItem[] }, store };
}

describe("Connection group context menu in SidebarTreeRuntimeHost", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("includes open and close connection actions with appropriate counts and enabled states", async () => {
    const groupNode: TreeNode = {
      id: "group-1",
      label: "My Group",
      type: "connection-group",
      isExpanded: true,
      children: [],
    };
    const { host, store } = await mountHost(groupNode);

    // Mock connections in group
    vi.spyOn(store, "connectionIdsInGroups").mockReturnValue(["conn-1", "conn-2"]);
    store.connectedIds = new Set(["conn-1"]);

    const menu = host.buildContextMenu(groupNode);
    const openItem = menu.find((item) => item.sidebarActionId === "connectionGroup.openConnections");
    const closeItem = menu.find((item) => item.sidebarActionId === "connectionGroup.closeConnections");

    expect(openItem).toBeDefined();
    expect(openItem?.label).toBe(tr("connectionGroup.openConnections", { count: 1 }));
    expect(openItem?.disabled).toBe(false);

    expect(closeItem).toBeDefined();
    expect(closeItem?.label).toBe(tr("connectionGroup.closeConnections", { count: 1 }));
    expect(closeItem?.disabled).toBe(false);
  });

  it("disables openConnections when all connections in group are already connected", async () => {
    const groupNode: TreeNode = {
      id: "group-1",
      label: "My Group",
      type: "connection-group",
      isExpanded: true,
      children: [],
    };
    const { host, store } = await mountHost(groupNode);

    vi.spyOn(store, "connectionIdsInGroups").mockReturnValue(["conn-1", "conn-2"]);
    store.connectedIds = new Set(["conn-1", "conn-2"]);

    const menu = host.buildContextMenu(groupNode);
    const openItem = menu.find((item) => item.sidebarActionId === "connectionGroup.openConnections");
    const closeItem = menu.find((item) => item.sidebarActionId === "connectionGroup.closeConnections");

    expect(openItem?.disabled).toBe(true);
    expect(openItem?.label).toBe(tr("connectionGroup.openConnections", { count: 0 }));

    expect(closeItem?.disabled).toBe(false);
    expect(closeItem?.label).toBe(tr("connectionGroup.closeConnections", { count: 2 }));
  });
});
