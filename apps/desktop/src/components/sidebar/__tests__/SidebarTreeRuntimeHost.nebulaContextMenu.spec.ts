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

const connection = { id: "nebula-1", name: "NebulaGraph", db_type: "nebula", driver_profile: "nebula", host: "localhost", port: 9669, username: "root", password: "" };
const node = (type: TreeNode["type"], label: string): TreeNode => ({ id: `nebula-1:space:${type}:${label}`, type, label, connectionId: connection.id, database: "space", tableName: label });
const mountedApps: App<Element>[] = [];
const labels = (items: ContextMenuItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? labels(item.children) : [])]);
const tr = (key: string) => i18n.global.t(key);

async function mountHost() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connection];
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: node("connection", connection.name), depth: 0 }) });
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

describe("NebulaGraph sidebar context menus", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("keeps space browsing and queries without relational database operations", async () => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node("database", "space")));
    expect(items).toEqual(expect.arrayContaining([tr("contextMenu.copyName"), tr("contextMenu.newQuery"), tr("contextMenu.openObjectBrowser"), tr("contextMenu.refreshChildren")]));
    for (const key of ["transfer.dataTransfer", "diff.title", "dataCompare.title", "contextMenu.exportDatabase", "dataDictionary.title", "sqlFile.title"]) {
      expect(items).not.toContain(tr(key));
    }
  });

  it.each(["table", "view"] as const)("keeps %s reads and DDL without SQL table mutations", async (type) => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node(type, type === "table" ? "person" : "knows")));
    expect(items).toEqual(expect.arrayContaining([tr("contextMenu.copyName"), tr("contextMenu.newQuery"), tr("contextMenu.viewData"), tr("contextMenu.viewDdl"), tr("contextMenu.refreshChildren")]));
    for (const key of ["contextMenu.generateSql", "contextMenu.exportDatabase", "contextMenu.exportData", "contextMenu.editView", "contextMenu.dropView", "contextMenu.dropTable", "contextMenu.emptyTable", "contextMenu.duplicateStructure", "dataCompare.title"]) {
      expect(items).not.toContain(tr(key));
    }
  });

  it("does not offer SQL view creation on the edge group", async () => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node("group-views", "Edges")));
    expect(items).toContain(tr("contextMenu.refreshChildren"));
    expect(items).not.toContain(tr("contextMenu.createView"));
  });

  it("does not offer SQL files or all-database export on the connection", async () => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node("connection", connection.name)));
    expect(items).toContain(tr("contextMenu.newQuery"));
    expect(items).not.toContain(tr("sqlFile.title"));
    expect(items).not.toContain(tr("contextMenu.exportAllDatabases"));
  });
});
