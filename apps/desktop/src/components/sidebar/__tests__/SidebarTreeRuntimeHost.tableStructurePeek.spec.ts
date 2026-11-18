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

const connection = { id: "mysql-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql", host: "localhost", port: 3306, username: "root", password: "" };
const tableNode: TreeNode = { id: "mysql-1:app:public:table:users", type: "table", label: "users", connectionId: connection.id, database: "app", schema: "public" };
const viewNode: TreeNode = { id: "mysql-1:app:public:view:active_users", type: "view", label: "active_users", connectionId: connection.id, database: "app", schema: "public" };

const tr = (key: string) => i18n.global.t(key);
const mountedApps: App<Element>[] = [];
const findItem = (items: ContextMenuItem[], label: string): ContextMenuItem | undefined => items.find((item) => item.label === label) ?? items.flatMap((item) => (item.children ? [findItem(item.children, label)] : [])).find(Boolean);

async function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connection];
  const host = ref<{ buildContextMenu(node: TreeNode): ContextMenuItem[] } | null>(null);
  const onPeekStructure = vi.fn();
  const root = defineComponent({
    setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: { id: "__root__", label: "", type: "connection-group" } as TreeNode, depth: 0, onPeekStructure }),
  });
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
  return { host: host.value as { buildContextMenu(node: TreeNode): ContextMenuItem[] }, onPeekStructure };
}

describe("sidebar read-only table structure preview", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("offers the read-only structure entry next to the structure editor on tables", async () => {
    const { host } = await mountHost();
    const items = host.buildContextMenu(tableNode);
    expect(findItem(items, tr("contextMenu.peekStructure"))).toBeTruthy();
    expect(findItem(items, tr("contextMenu.editStructure"))).toBeTruthy();
  });

  it("emits the target table when the preview entry is clicked", async () => {
    const { host, onPeekStructure } = await mountHost();
    const peek = findItem(host.buildContextMenu(tableNode), tr("contextMenu.peekStructure"));
    expect(peek?.action).toBeTypeOf("function");

    peek?.action?.();

    expect(onPeekStructure).toHaveBeenCalledTimes(1);
    expect(onPeekStructure.mock.calls[0]?.[0]).toMatchObject({ label: "users", database: "app", schema: "public", connectionId: connection.id });
  });

  it("keeps the preview off views, which already have dedicated source actions", async () => {
    const { host } = await mountHost();
    const items = host.buildContextMenu(viewNode);
    expect(findItem(items, tr("contextMenu.peekStructure"))).toBeUndefined();
    expect(findItem(items, tr("contextMenu.viewSource"))).toBeTruthy();
  });
});
