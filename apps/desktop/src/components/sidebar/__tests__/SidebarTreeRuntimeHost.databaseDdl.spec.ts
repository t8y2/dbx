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
import { useQueryStore } from "@/stores/queryStore";

const mysql = { id: "mysql-1", name: "MySQL", db_type: "mysql", host: "localhost", port: 3306, username: "root", password: "" };
const postgres = { id: "pg-1", name: "Postgres", db_type: "postgres", host: "localhost", port: 5432, username: "postgres", password: "" };
const databaseNode = (connection: { id: string; name: string }, database: string): TreeNode => ({ id: `${connection.id}:${database}`, type: "database", label: database, connectionId: connection.id, database });
const mountedApps: App<Element>[] = [];
const tr = (key: string) => i18n.global.t(key);

async function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [mysql, postgres] as never;
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: databaseNode(mysql, "shop"), depth: 0 }) });
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

describe("database node View DDL", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("opens a query tab with SHOW CREATE DATABASE for a MySQL database", async () => {
    const host = await mountHost();
    const item = host.buildContextMenu(databaseNode(mysql, "shop")).find((entry) => entry.label === tr("contextMenu.viewDdl"));
    expect(item).toBeDefined();

    await item!.action!();
    await nextTick();

    const tab = useQueryStore().tabs.at(-1);
    expect(tab).toMatchObject({ connectionId: "mysql-1", database: "shop", sql: "SHOW CREATE DATABASE `shop`;" });
    expect(tab?.title).toBe(`shop - ${tr("contextMenu.viewDdl")}`);
  });

  it("does not offer View DDL on a PostgreSQL database node", async () => {
    const host = await mountHost();
    const labels = host.buildContextMenu(databaseNode(postgres, "app")).map((entry) => entry.label);
    expect(labels).not.toContain(tr("contextMenu.viewDdl"));
  });
});
