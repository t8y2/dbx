// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { DatabaseType, TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]) };
});

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

async function mountHost(dbType: DatabaseType = "firebird") {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [{ id: "test-conn", name: "TestDB", db_type: dbType, driver_profile: dbType, host: "localhost", port: 3050, username: "sysdba", password: "masterkey" }];
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
});
