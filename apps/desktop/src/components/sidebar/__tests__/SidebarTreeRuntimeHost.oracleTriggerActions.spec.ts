// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, watch, type App } from "vue";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, ObjectSource, TreeNode, TriggerInfo } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";
import { compileErrorMessage, showCompileErrorDialog, showBatchDropConfirm } from "../sidebarTreeDialogState";
import SidebarTreeRuntimeHost from "../SidebarTreeRuntimeHost.vue";
import SidebarTreeItemDialogs from "../SidebarTreeItemDialogs.vue";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { useSidebarRemoteSearch } from "@/composables/useSidebarRemoteSearch";
import { useToast } from "@/composables/useToast";

const rpc = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  executeQuery: vi.fn(),
  listTriggers: vi.fn(),
  buildDropObjectSql: vi.fn(),
  checkConnectionHealth: vi.fn(async () => undefined),
  listPlugins: vi.fn(async () => []),
  listInstalledAgents: vi.fn(async () => []),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => undefined),
  deleteSchemaCachePrefix: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...rpc }));
const owner = " Trigger.Owner ",
  parent = " Parent.Owner ";
const names = [' Tr"igger ', "SecondTrigger"];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const configs = { id: "native-trigger-menu", name: "Test", db_type: "oceanbase-oracle", database: "service", username: "Execution.Owner" } as ConnectionConfig;
const cleanup: (() => void)[] = [];
let enabled = false,
  invalid = false,
  denyGlobal = false;
let gone = new Set<string>();
let objectIds = new Map<string, string>();
let parentId = "parent-id";
let ddl: string[];
let request: SidebarDangerDialogRequest | undefined;
function trigger(name: string): TriggerInfo {
  return {
    name,
    timing: "INSTEAD OF",
    event: "UPDATE",
    enabled,
    valid: !invalid,
    oracle_metadata: {
      contractVersion: 1,
      identityMode: "exact",
      engine: configs.db_type === "dameng" ? "dm" : "oceanbase-oracle",
      engineVersion: configs.db_type === "dameng" ? "8.1.3" : "4.2.5.7_107",
      owner,
      name,
      objectId: objectIds.get(name) ?? `900719925474099${names.indexOf(name) + 3}`,
      scope: "VIEW",
      parent: { owner: parent, name: "V", objectType: "VIEW" },
      definition: { origin: "catalog-body", format: "body", complete: false },
      errors: invalid ? [{ sequence: 1, line: 2, position: 3, text: "Missing procedure" }] : [],
      reads: { identity: { state: "available" }, scope: { state: "available" }, parent: { state: "available" }, enabled: { state: "available" }, validity: { state: "available" }, definition: { state: "denied" }, errors: { state: "available" } },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useToast().message.value = "";
  configs.db_type = "oceanbase-oracle";
  configs.is_production = false;
  localStorage.clear();
  rpc.deleteSchemaCachePrefix.mockResolvedValue(undefined);
  enabled = false;
  invalid = false;
  denyGlobal = false;
  gone = new Set();
  objectIds = new Map();
  parentId = "parent-id";
  ddl = [];
  request = undefined;
  setActivePinia(createPinia());
  showCompileErrorDialog.value = false;
  showBatchDropConfirm.value = false;
  rpc.getObjectSource.mockImplementation(async (_id, _db, _owner, name) => {
    const info = trigger(name);
    if (gone.has(name)) {
      info.oracle_metadata!.objectId = null;
      info.oracle_metadata!.reads.identity = { state: "empty" };
    }
    return { name, schema: owner, object_type: "TRIGGER", source: gone.has(name) ? "" : "BEGIN NULL; END;", editable: false, trigger: info } as ObjectSource;
  });
  rpc.listTriggers.mockImplementation(async () => names.filter((name) => !gone.has(name)).map(trigger));
  rpc.buildDropObjectSql.mockImplementation(async (input) => `DROP TRIGGER ${quote(input.schema)}.${quote(input.name)};`);
  rpc.executeQuery.mockImplementation(async (_id, _db, sql) => {
    if (sql.startsWith("SELECT USER")) return { columns: ["SESSION_USER"], rows: [["Execution.Owner"]] };
    if (sql.includes("DBA_OBJECTS")) {
      if (denyGlobal) throw new Error("global dictionary denied");
      return { columns: ["OWNER", "OBJECT_NAME"], rows: [] };
    }
    if (sql.startsWith("SELECT")) return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [[parent, "V", "VIEW", parentId]] };
    ddl.push(sql);
    if (sql.startsWith("DROP")) gone.add(names.find((name) => sql.includes(quote(name)))!);
    if (sql.endsWith(" ENABLE;")) enabled = true;
    return { columns: [], rows: [], affected_rows: 0 };
  });
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  useSqlExecutionDangerStore().cancelAll();
  useProductionSafetyStore().cancel();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
async function mount(count = 1, searchProjection = false) {
  const store = useConnectionStore();
  store.connections = [configs];
  store.connectedIds.add(configs.id);
  const group: TreeNode = { id: "trigger-parent-group", label: "Triggers", type: "group-triggers", connectionId: configs.id, database: "service", schema: parent, tableName: "V", isExpanded: true };
  const nodes: TreeNode[] = names.slice(0, count).map((name) => ({ id: `trigger-node:${name}`, label: `${name} (display only)`, objectName: name, type: "trigger", connectionId: configs.id, database: "service", schema: owner, tableName: "V", meta: trigger(name) }));
  group.children = nodes;
  store.treeNodes = searchProjection ? [] : [group];
  const visibleNodes = ref(searchProjection ? [] : nodes);
  let removeSearchNode = (_node: TreeNode) => {};
  store.selectedTreeNodeId = nodes[0].id;
  store.selectedTreeNodeIds = nodes.map((node) => node.id);
  const component = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const dialogController = ref<Record<string, any>>();
  const openSource = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app: App = createApp({
    setup() {
      if (searchProjection) {
        const query = ref("");
        const remote = useSidebarRemoteSearch({
          query,
          enabled: ref(true),
          context: [() => store.sidebarObjectSearchRevision],
          load: async () => [{ parentNodeId: group.id, nodeType: group.type, connectionId: configs.id, database: "service", schema: parent, children: nodes.filter((node) => !gone.has(node.objectName!)) }],
          onError: (error) => {
            throw error;
          },
        });
        watch(
          remote.results,
          (results) => {
            visibleNodes.value = results.flatMap((result) => result.children);
          },
          { flush: "sync" },
        );
        removeSearchNode = remote.removeVerifiedTriggerNode;
        query.value = "trigger";
      }
      return () =>
        h("div", [
          h(SidebarTreeRuntimeHost, {
            ref: component,
            node: group,
            depth: 0,
            onOpenObjectSource: openSource,
            onOpenDangerDialog: (next) => {
              request = next;
            },
            onOpenDialogController: (next) => {
              dialogController.value = next;
            },
          }),
          dialogController.value ? h(SidebarTreeItemDialogs, { controller: dialogController.value }) : null,
        ]);
    },
  });
  app.use(getActivePinia()!);
  app.use(i18n);
  if (searchProjection) app.provide(sidebarTreeContextKey, { getVisibleNodes: () => visibleNodes.value, getVisibleNodeIndex: (id) => visibleNodes.value.findIndex((node) => node.id === id), isSearchProjectionActive: () => true, removeVerifiedTriggerNode: (node) => removeSearchNode(node) });
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    host.remove();
  };
  cleanup.push(unmount);
  await nextTick();
  if (searchProjection) await vi.waitFor(() => expect(visibleNodes.value).toHaveLength(count));
  const buildMenu = (node: TreeNode) => (component.value as unknown as { buildContextMenu(node: TreeNode): ContextMenuItem[] }).buildContextMenu(node);
  return { store, nodes, group, visibleNodes, openSource, buildMenu, unmount, menu: buildMenu(nodes[0]) };
}
const flatten = (items: ContextMenuItem[]): ContextMenuItem[] => items.flatMap((item) => [item, ...flatten(item.children ?? [])]);

describe("exact trigger actions through the actual tree menu", () => {
  it.each(["contextMenu.enableTrigger", "processList.oracleInvalidObjects.compile", "delete"])("executes %s for an exact search-only result", async (label) => {
    const { menu, store, visibleNodes } = await mount(1, true);
    const pending = flatten(menu).find((item) => (label === "delete" ? item.variant === "destructive" : item.label === i18n.global.t(label)))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await pending;
    await vi.waitFor(() => expect(ddl).toHaveLength(1));
    expect(store.treeNodes).toEqual([]);
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toContain(quote(names[0]));
    if (label === "delete") await vi.waitFor(() => expect(visibleNodes.value).toEqual([]));
    if (label !== "contextMenu.enableTrigger") {
      const feedbackKey = label === "delete" ? "contextMenu.dropTableChildObjectSuccess" : "contextMenu.compileObjectSuccess";
      expect(i18n.global.te(feedbackKey)).toBe(true);
      await vi.waitFor(() => expect(useToast().message.value).toBe(i18n.global.t(feedbackKey, { name: names[0] })));
    }
  });

  it("deletes a search-only trigger batch through the original guarded sequence", async () => {
    const { menu, visibleNodes } = await mount(2, true);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    await request!.confirm();
    expect(ddl).toEqual(names.map((name) => `DROP TRIGGER ${quote(owner)}.${quote(name)};`));
    await vi.waitFor(() => expect(visibleNodes.value).toEqual([]));
  });

  it("retains a search-only result when deletion cannot be authoritatively verified", async () => {
    denyGlobal = true;
    const { menu, visibleNodes } = await mount(1, true);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(showCompileErrorDialog.value).toBe(true));
    expect(visibleNodes.value).toHaveLength(1);
    expect(ddl).toEqual([`DROP TRIGGER ${quote(owner)}.${quote(names[0])};`]);
  });

  it("cancels an unissued search-only action when its projection disappears", async () => {
    const { menu, visibleNodes } = await mount(1, true);
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("contextMenu.enableTrigger"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    visibleNodes.value = [];
    danger.confirm();
    await pending;
    expect(ddl).toEqual([]);
  });

  it("does not dispatch a search-only deletion batch after the projection disappears", async () => {
    const { menu, visibleNodes } = await mount(2, true);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    visibleNodes.value = [];
    await request!.confirm();
    expect(ddl).toEqual([]);
  });

  it.each(["unmount", "selection"])("cancels the unissued batch production confirmation on %s", async (change) => {
    configs.is_production = true;
    const { menu, store, group, unmount } = await mount(2);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    const pending = request!.confirm();
    const production = useProductionSafetyStore();
    await vi.waitFor(() => expect(production.pending).toBeDefined());
    if (change === "unmount") unmount();
    else {
      store.selectedTreeNodeId = group.id;
      store.selectedTreeNodeIds = [group.id];
    }
    await vi.waitFor(() => expect(production.pending).toBeUndefined());
    await pending;
    expect(ddl).toEqual([]);
    expect(showCompileErrorDialog.value).toBe(false);
  });

  it("finishes the dispatched deletion on its fixed target but stops remaining batch objects after a UI selection change", async () => {
    const { menu, store, nodes, group } = await mount(2);
    const [first, second] = nodes;
    const execute = rpc.executeQuery.getMockImplementation()!;
    let finish!: () => void;
    rpc.executeQuery.mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[2].startsWith("DROP") && ddl.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return result;
    });
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    const pending = request!.confirm();
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.selectedTreeNodeId = group.id;
    store.selectedTreeNodeIds = [group.id];
    finish();
    await pending;
    expect(ddl).toEqual([`DROP TRIGGER ${quote(owner)}.${quote(names[0])};`]);
    expect(store.treeNodes[0].children?.some((node) => node.id === first.id)).toBe(false);
    expect(store.treeNodes[0].children?.some((node) => node.id === second.id)).toBe(true);
    expect(compileErrorMessage.value).toContain(i18n.global.t("oceanbasePrimaryKey.notExecuted"));
    expect(compileErrorMessage.value).not.toContain(i18n.global.t("oceanbasePrimaryKey.unknown"));
  });

  it("reviews a trigger deletion batch once in the production guard, with both confirmed SQL statements", async () => {
    configs.is_production = true;
    const { menu } = await mount(2);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    const production = useProductionSafetyStore();
    let settled = false;
    const pending = Promise.resolve(request!.confirm()).finally(() => {
      settled = true;
    });
    const reviews: string[] = [];
    for (let index = 0; index < 3 && !settled; index++) {
      await vi.waitFor(() => expect(settled || !!production.pending).toBe(true));
      if (production.pending) {
        reviews.push(production.pending.sql);
        production.confirm();
      }
    }
    await pending;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(quote(names[0]));
    expect(reviews[0]).toContain(quote(names[1]));
    expect(ddl).toHaveLength(2);
  });

  it("keeps batch unknown nodes and pins, then removes only the read-only verified deletion without replay", async () => {
    denyGlobal = true;
    const { menu, store, nodes } = await mount(2);
    const [first, second] = nodes;
    nodes.forEach((node) => store.toggleTreeNodePin(node));
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    await request!.confirm();
    expect(ddl).toEqual([`DROP TRIGGER ${quote(owner)}.${quote(names[0])};`]);
    expect(store.isTreeNodePinned(first)).toBe(true);
    expect(store.isTreeNodePinned(second)).toBe(true);
    await nextTick();
    const verify = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t("oracleTrigger.verifyReadOnly"));
    expect(verify()).toBeDefined();
    denyGlobal = false;
    verify()!.click();
    await vi.waitFor(() =>
      expect(
        store.treeNodes[0].children?.some((node) => node.id === first.id),
        compileErrorMessage.value,
      ).toBe(false),
    );
    expect(store.treeNodes[0].children?.some((node) => node.id === second.id)).toBe(true);
    expect(store.isTreeNodePinned(first)).toBe(false);
    expect(store.isTreeNodePinned(second)).toBe(true);
    await request!.confirm();
    expect(ddl).toHaveLength(1);
  });

  it("keeps a recreated row and its pin when the original batch deletion was verified before cache cleanup", async () => {
    const { menu, store, nodes } = await mount(2);
    const first = nodes[0];
    store.toggleTreeNodePin(first);
    let replaced = false;
    rpc.deleteSchemaCachePrefix.mockImplementation(async () => {
      if (!replaced && ddl.length) {
        replaced = true;
        gone.delete(names[0]);
        objectIds.set(names[0], "recreated-after-verify");
        const live = store.treeNodes[0].children!.find((node) => node.id === first.id)!;
        const meta = JSON.parse(JSON.stringify(live.meta)) as TriggerInfo;
        meta.oracle_metadata!.objectId = "recreated-after-verify";
        live.meta = meta;
      }
    });
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled).toBe(true));
    await request!.confirm();
    const live = store.treeNodes[0].children!.find((node) => node.id === first.id);
    expect((live?.meta as TriggerInfo | undefined)?.oracle_metadata?.objectId).toBe("recreated-after-verify");
    expect(store.isTreeNodePinned(first)).toBe(true);
    expect(ddl).toHaveLength(1);
  });

  it.each(["dialog", "query-tab"] as const)("opens DM8 trigger dependencies in the existing %s container without a general query or DDL", async (mode) => {
    configs.db_type = "dameng";
    useSettingsStore().editorSettings.routineSourceOpenMode = mode;
    const { menu, openSource } = await mount();
    const dependencies = flatten(menu).find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"));
    expect(dependencies).toBeDefined();
    await dependencies!.action!();
    if (mode === "dialog") expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ type: "trigger", schema: owner, objectName: names[0], meta: expect.objectContaining({ oracle_metadata: expect.objectContaining({ engine: "dm" }) }) }), false, "dependencies");
    else {
      const store = useQueryStore();
      await vi.waitFor(() => expect(store.tabs.some((tab) => tab.objectSource?.name === names[0])).toBe(true), { timeout: 30_000 });
      const tab = store.tabs.find((item) => item.objectSource?.name === names[0])!;
      expect(tab.objectDetails).toMatchObject({ schema: owner, name: names[0], objectType: "TRIGGER", section: "dependencies" });
      expect(store.oracleTriggerSourceState(tab.id)?.baseline?.metadata.engine).toBe("dm");
    }
    expect(ddl).toEqual([]);
    expect(rpc.executeQuery).not.toHaveBeenCalled();
  });

  it("does not replace the displayed physical identity from a mismatched post-compile snapshot", async () => {
    const { menu, store, nodes } = await mount();
    const source = rpc.getObjectSource.getMockImplementation()!;
    rpc.getObjectSource.mockImplementation(async (...args) => {
      const result = await source(...args);
      if (ddl.length) result.trigger!.oracle_metadata!.objectId = "replacement-id";
      return result;
    });
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("processList.oracleInvalidObjects.compile"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await pending;
    expect(showCompileErrorDialog.value).toBe(true);
    expect(compileErrorMessage.value).toContain("mismatch");
    const live = store.treeNodes[0].children!.find((node) => node.id === nodes[0].id)!;
    expect((live.meta as TriggerInfo).oracle_metadata?.objectId).toBe("9007199254740993");
    expect(ddl).toHaveLength(1);
    expect(rpc.listTriggers).not.toHaveBeenCalled();
  });

  it.each(["contextMenu.enableTrigger", "processList.oracleInvalidObjects.compile"])("rejects a same-name replacement before confirming %s", async (label) => {
    const { menu } = await mount();
    const source = rpc.getObjectSource.getMockImplementation()!;
    rpc.getObjectSource.mockImplementation(async (...args) => {
      const result = await source(...args);
      result.trigger.oracle_metadata.objectId = "replacement-id";
      return result;
    });
    let settled = false;
    const pending = Promise.resolve(flatten(menu).find((item) => item.label === i18n.global.t(label))!.action!()).finally(() => {
      settled = true;
    });
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(settled || !!danger.pending).toBe(true));
    expect(danger.pending).toBeUndefined();
    await pending;
    expect(ddl).toEqual([]);
  });

  it("cancels a pending trigger confirmation when the tree host unmounts", async () => {
    const { menu, unmount } = await mount();
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("contextMenu.enableTrigger"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    unmount();
    await nextTick();
    expect(danger.pending).toBeUndefined();
    await pending;
    expect(ddl).toEqual([]);
  });

  it.each(["deleted", "parent-replaced", "trigger-replaced"])("retains an unverified deletion and reconciles it without replay (%s)", async (after) => {
    denyGlobal = true;
    const { menu, store, nodes } = await mount();
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(showCompileErrorDialog.value).toBe(true));
    expect(store.treeNodes[0].children?.some((node) => node.id === nodes[0].id)).toBe(true);
    await nextTick();
    const verify = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("oracleTrigger.verifyReadOnly"));
    expect(verify).toBeDefined();
    denyGlobal = false;
    if (after === "parent-replaced") parentId = "new-parent-id";
    if (after === "trigger-replaced") gone.delete(names[0]);
    verify!.click();
    await vi.waitFor(() => expect(verify!.getAttribute("aria-busy")).not.toBe("true"));
    await vi.waitFor(() => expect(compileErrorMessage.value).toContain(after === "deleted" ? i18n.global.t("processList.oracleInvalidObjects.batchStatus.deleted") : after === "parent-replaced" ? "owning object changed" : "trigger still exists"));
    expect(store.treeNodes[0].children?.some((node) => node.id === nodes[0].id)).toBe(after !== "deleted");
    expect(ddl).toEqual([`DROP TRIGGER ${quote(owner)}.${quote(names[0])};`]);
  });

  it("finishes the original readback without reopening a dialog after an in-flight compile unmounts", async () => {
    invalid = true;
    const { menu, unmount } = await mount();
    const execute = rpc.executeQuery.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched = false;
    rpc.executeQuery.mockImplementation(async (...args) => {
      if (!args[2].startsWith("SELECT")) {
        dispatched = true;
        await gate;
      }
      return execute(...args);
    });
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("processList.oracleInvalidObjects.compile"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await vi.waitFor(() => expect(dispatched).toBe(true));
    unmount();
    release();
    await pending;
    expect(ddl).toEqual([`ALTER TRIGGER ${quote(owner)}.${quote(names[0])} COMPILE`]);
    expect(rpc.getObjectSource.mock.calls.at(-1)?.slice(0, 5)).toEqual([configs.id, "service", owner, names[0], "TRIGGER"]);
    expect(rpc.listTriggers).not.toHaveBeenCalled();
    expect(showCompileErrorDialog.value).toBe(false);
  });

  it("opens creation from an empty Schema trigger group without requiring an existing trigger", async () => {
    const { store, group, buildMenu, openSource } = await mount();
    group.children = [];
    group.tableName = undefined;
    group.schema = owner;
    store.selectedTreeNodeId = group.id;
    store.selectedTreeNodeIds = [group.id];
    const create = flatten(buildMenu(group)).find((item) => item.label === i18n.global.t("contextMenu.createTrigger"));
    expect(create).toBeDefined();
    await create!.action!();
    expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ type: "trigger", schema: owner, objectName: "TRG_NEW" }), true, undefined, expect.objectContaining({ target: expect.objectContaining({ id: group.id, type: "group-triggers" }), payload: { scope: "TABLE" } }));
    expect(ddl).toEqual([]);
    expect(rpc.getObjectSource).not.toHaveBeenCalled();
  });

  it("uses the raw trigger owner and refreshes its independent parent after native enable", async () => {
    const { menu } = await mount();
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("contextMenu.enableTrigger"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    expect(danger.pending?.sql).toBe(`ALTER TRIGGER ${quote(owner)}.${quote(names[0])} ENABLE;`);
    danger.confirm();
    await pending;
    expect(ddl).toEqual([`ALTER TRIGGER ${quote(owner)}.${quote(names[0])} ENABLE;`]);
    expect(rpc.listTriggers).toHaveBeenCalledWith(configs.id, "service", parent, "V", undefined, { identityMode: "exact" });
  });

  it.each(["dialog", "query-tab"] as const)("shows real INVALID diagnostics and opens the fixed source target in %s mode", async (mode) => {
    invalid = true;
    useSettingsStore().editorSettings.routineSourceOpenMode = mode;
    const { menu, store, group, openSource } = await mount();
    const pending = flatten(menu).find((item) => item.label === i18n.global.t("processList.oracleInvalidObjects.compile"))!.action!();
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toBeDefined());
    danger.confirm();
    await pending;
    expect(ddl).toEqual([`ALTER TRIGGER ${quote(owner)}.${quote(names[0])} COMPILE`]);
    expect(showCompileErrorDialog.value).toBe(true);
    expect(compileErrorMessage.value).toContain("Missing procedure");
    expect(enabled).toBe(false);
    store.selectedTreeNodeId = group.id;
    store.selectedTreeNodeIds = [group.id];
    await nextTick();
    const source = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("contextMenu.viewSource"));
    expect(source).toBeDefined();
    source!.click();
    await nextTick();
    if (mode === "dialog") expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ type: "trigger", schema: owner, objectName: names[0] }), false, undefined);
    else await vi.waitFor(() => expect(useQueryStore().tabs.some((tab) => tab.objectSource?.schema === owner && tab.objectSource.name === names[0])).toBe(true));
    expect(showCompileErrorDialog.value).toBe(false);
    expect(ddl).toHaveLength(1);
  });

  it.each([true, false])("stops remaining confirmed batch targets only when deletion is unverified (global denied=%s)", async (denied) => {
    denyGlobal = denied;
    const { menu } = await mount(2);
    flatten(menu).find((item) => item.variant === "destructive")!.action!();
    await vi.waitFor(() => expect(request && !request.confirmDisabled && request.sql?.includes(quote(names[1]))).toBe(true));
    await request!.confirm();
    expect(ddl).toEqual((denied ? names.slice(0, 1) : names).map((name) => `DROP TRIGGER ${quote(owner)}.${quote(name)};`));
    if (denied) {
      expect(compileErrorMessage.value).toContain("global dictionary denied");
      expect(compileErrorMessage.value).toContain(i18n.global.t("oceanbasePrimaryKey.notExecuted"));
    }
  });
});
