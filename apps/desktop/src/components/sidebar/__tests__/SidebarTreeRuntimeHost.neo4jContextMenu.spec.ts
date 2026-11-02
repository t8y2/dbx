// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { DatabaseType, TreeNode } from "@/types/database";
import { supportsTableTruncate } from "@/lib/database/databaseFeatureSupport";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, listPlugins: vi.fn().mockResolvedValue([]) };
});

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";

const node = (type: TreeNode["type"], label: string): TreeNode => ({ id: `sample:${type}:${label}`, type, label, connectionId: "sample", database: "sample", tableName: label });
const mountedApps: App<Element>[] = [];
const labels = (items: ContextMenuItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? labels(item.children) : [])]);
const tr = (key: string) => i18n.global.t(key);

async function mountHost(dbType: DatabaseType = "neo4j") {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [{ id: "sample", name: "Sample", db_type: dbType, driver_profile: dbType, host: "localhost", port: 7687, username: "sample", password: "" }];
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: node("connection", "Sample"), depth: 0 }) });
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

describe("Neo4j sidebar capabilities", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("keeps database browsing and queries without relational comparisons or transfers", async () => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node("database", "sample")));
    expect(items).toEqual(expect.arrayContaining([tr("contextMenu.newQuery"), tr("contextMenu.openObjectBrowser"), tr("contextMenu.refreshChildren"), tr("sqlFile.title")]));
    for (const key of ["transfer.dataTransfer", "diff.title", "dataCompare.title", "contextMenu.exportDatabase", "dataDictionary.title"]) expect(items).not.toContain(tr(key));
  });

  it.each(["table", "view"] as const)("keeps %s data browsing without SQL structure mutations", async (type) => {
    const host = await mountHost();
    const items = labels(host.buildContextMenu(node(type, "Person")));
    expect(items).toEqual(expect.arrayContaining([tr("contextMenu.viewData"), tr("contextMenu.newQuery"), tr("contextMenu.exportData")]));
    for (const key of ["contextMenu.viewDdl", "contextMenu.generateSql", "contextMenu.duplicateStructure", "contextMenu.dropTable", "contextMenu.dropView", "contextMenu.truncateTable", "contextMenu.emptyTable", "contextMenu.exportDatabase", "dataCompare.title"]) expect(items).not.toContain(tr(key));
  });

  it("does not offer SQL view creation or relational database backups", async () => {
    const host = await mountHost();
    expect(labels(host.buildContextMenu(node("group-views", "Views")))).not.toContain(tr("contextMenu.createView"));
    const connectionItems = labels(host.buildContextMenu(node("connection", "Sample")));
    expect(connectionItems).toContain(tr("contextMenu.newQuery"));
    expect(connectionItems).not.toContain(tr("contextMenu.exportAllDatabases"));
    expect(supportsTableTruncate("neo4j")).toBe(false);
  });

  it("preserves MySQL relational menus", async () => {
    const host = await mountHost("mysql");
    expect(labels(host.buildContextMenu(node("database", "sample")))).toContain(tr("transfer.dataTransfer"));
    expect(labels(host.buildContextMenu(node("table", "Person")))).toContain(tr("contextMenu.generateSql"));
    expect(supportsTableTruncate("mysql")).toBe(true);
  });
});
