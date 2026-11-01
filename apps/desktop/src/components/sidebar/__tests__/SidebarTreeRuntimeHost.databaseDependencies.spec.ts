// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

const backend = vi.hoisted(() => ({
  executeMulti: vi.fn().mockResolvedValue([{ columns: ["DIRECTION"], rows: [["DEPENDS_ON"]], affected_rows: 0, execution_time_ms: 3 }]),
  prepareQueryPaginationExecutionPlan: vi.fn(async ({ sql }: { sql: string }) => ({ sqlToExecute: sql, pageSql: sql, pageLimit: 100, useAgentResultSession: false })),
  checkConnectionHealth: vi.fn(async () => undefined),
  getObjectSource: vi.fn(async () => ({ name: "BATCH_API", object_type: "PACKAGE", source: "package source", editable: false })),
  buildEditableObjectSource: vi.fn(async (input: { source: string }) => input.source),
  analyzeEditableQueryEditability: vi.fn(async () => ({ editable: false, reason: "set-operation" })),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...backend,
  listPlugins: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/backend/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/http")>()),
  ...backend,
}));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const mounted: { app: App; container: HTMLElement; pinia: Pinia }[] = [];

async function mountContextMenu(databaseType: DatabaseType, mode: "query-tab" | "dialog" = "query-tab") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.addEphemeralConnection({ id: "dependency-test", name: "Test", db_type: databaseType, driver_profile: databaseType, host: "localhost", port: 1, username: "test", password: "" });
  connections.connectedIds.add("dependency-test");
  useSettingsStore().editorSettings.routineSourceOpenMode = mode;
  const queries = useQueryStore();
  const onOpenObjectSource = vi.fn();

  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const rootNode: TreeNode = { id: "dependency-test", type: "connection", label: "Test", connectionId: "dependency-test", database: "APP" };
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: rootNode, depth: 0, onOpenObjectSource }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push({ app, container, pinia });
  await nextTick();

  return { host: host.value as unknown as { buildContextMenu(node: TreeNode): ContextMenuItem[] }, queries, onOpenObjectSource };
}

describe("routine dependency context-menu action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const { app, container, pinia } of mounted.splice(0)) {
      app.unmount();
      container.remove();
      disposePinia(pinia);
    }
    setActivePinia(undefined);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("opens table relations in existing properties without executing table data in %s", async (databaseType) => {
    const { host, queries, onOpenObjectSource } = await mountContextMenu(databaseType);
    const node: TreeNode = { id: "T", type: "table", label: "Mixed.Table", objectName: "Mixed.Table", schema: "Other.Owner", connectionId: "dependency-test", database: "APP", catalog: "Captured.Catalog" };
    const action = host.buildContextMenu(node).find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))?.action;
    expect(action).toBeDefined();
    await action?.();
    const tab = queries.tabs[0]!;
    expect(tab.mode).toBe("objects");
    expect(tab.objectPropertiesRequest).toMatchObject({ connectionId: "dependency-test", database: "APP", schema: "Other.Owner", name: "Mixed.Table", objectType: "TABLE", catalog: "Captured.Catalog", initialTab: "relations" });
    const request = tab.objectPropertiesRequest!.requestId;
    await action?.();
    expect(queries.tabs).toHaveLength(1);
    expect(tab.objectPropertiesRequest!.requestId).not.toBe(request);
    expect(backend.executeMulti).not.toHaveBeenCalled();
    expect(onOpenObjectSource).not.toHaveBeenCalled();
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("opens object dependencies from an Oracle package member in %s", async (databaseType) => {
    const { host, queries } = await mountContextMenu(databaseType);
    const member: TreeNode = {
      id: "dependency-test:package-member",
      type: "procedure",
      label: "RUN_JOB",
      objectName: "RUN_JOB",
      parentType: "package",
      parentName: "BATCH_API",
      parentSchema: "APP",
      schema: "APP",
      connectionId: "dependency-test",
      database: "APP",
    };
    const menu = host.buildContextMenu(member);
    const action = menu.find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))?.action;
    expect(action).toBeDefined();

    await action?.();

    const queryTab = queries.tabs.find((tab) => tab.mode === "query");
    expect(queryTab?.title).toBe("Source - BATCH_API");
    expect(queryTab?.objectDetails).toMatchObject({ connectionId: "dependency-test", database: "APP", schema: "APP", name: "BATCH_API", objectType: "PACKAGE", section: "dependencies" });
    expect(backend.executeMulti).not.toHaveBeenCalled();
    expect(queryTab?.result).toBeUndefined();
  });

  it("retains an index identity inside its parent property request", async () => {
    const { host, queries } = await mountContextMenu("oceanbase-oracle");
    const node: TreeNode = { id: "I", type: "index", label: "Idx.Dot", objectName: "Idx.Dot", schema: "Index.Owner", parentSchema: "Parent.Owner", parentName: "Parent.Table", parentType: "table", connectionId: "dependency-test", database: "APP" };
    const action = host.buildContextMenu(node).find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))?.action;
    expect(action).toBeDefined();
    await action?.();
    expect(queries.tabs[0]?.objectPropertiesRequest).toMatchObject({ schema: "Parent.Owner", name: "Parent.Table", objectType: "TABLE", initialTab: "relations", focusObject: { owner: "Index.Owner", name: "Idx.Dot", type: "INDEX" } });
    expect(backend.executeMulti).not.toHaveBeenCalled();
  });

  it("preserves the existing dialog preference and forwards its initial section", async () => {
    const { host, queries, onOpenObjectSource } = await mountContextMenu("oracle", "dialog");
    const node: TreeNode = { id: "P", type: "procedure", label: "P", schema: "APP", connectionId: "dependency-test", database: "APP" };
    await host
      .buildContextMenu(node)
      .find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))
      ?.action?.();
    expect(onOpenObjectSource).toHaveBeenCalledWith(expect.objectContaining({ type: "procedure", schema: "APP", label: "P" }), false, "dependencies");
    expect(queries.tabs).toHaveLength(0);
  });

  it("keeps the Xugu standalone dependency query path", async () => {
    const { host, queries } = await mountContextMenu("xugu");
    const node: TreeNode = { id: "P", type: "procedure", label: "P", schema: "APP", connectionId: "dependency-test", database: "APP" };
    await host
      .buildContextMenu(node)
      .find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))
      ?.action?.();
    expect(queries.tabs[0]?.objectDetails).toBeUndefined();
    expect(backend.executeMulti).toHaveBeenCalledTimes(1);
    expect(queries.tabs[0]?.result).toMatchObject({ columns: ["DIRECTION"], rows: [["DEPENDS_ON"]] });
    await vi.waitFor(() => expect(queries.tabs[0]?.queryEditabilityReason).toBe("set-operation"));
  });

  it("keeps package-member dependency action hidden for Xugu", async () => {
    const { host } = await mountContextMenu("xugu");
    const member: TreeNode = {
      id: "dependency-test:package-member",
      type: "procedure",
      label: "RUN_JOB",
      objectName: "RUN_JOB",
      parentType: "package",
      parentName: "BATCH_API",
      parentSchema: "APP",
      schema: "APP",
      connectionId: "dependency-test",
      database: "APP",
    };
    expect(host.buildContextMenu(member).map((item) => item.label)).not.toContain(i18n.global.t("contextMenu.viewDependencies"));
  });
});
