// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { DatabaseType, TreeNode, TriggerInfo } from "@/types/database";

let databaseType: DatabaseType = "sqlserver";
const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "connection-1", db_type: databaseType }),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [],
  treeSelectionAnchorId: null as string | null,
};

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { openDataInNewTab: "" },
      sidebarActivation: "double",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
      sidebarShowTooltips: true,
    },
  }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const mountedApps: App[] = [];
const disabledSelector = '[data-disabled-trigger-indicator="true"]';
const invalidSelector = '[data-invalid-object-indicator="true"]';
const statuses = [false, true, undefined, null] as const;

function triggerNode(enabled: TriggerInfo["enabled"], valid?: TreeNode["valid"]): TreeNode {
  return {
    id: "connection-1:app:dbo:orders:__triggers:trg_orders_audit",
    label: "trg_orders_audit (AFTER UPDATE)",
    type: "trigger",
    connectionId: "connection-1",
    database: "app",
    schema: "dbo",
    tableName: "orders",
    objectName: "trg_orders_audit",
    valid,
    meta: { name: "trg_orders_audit", timing: "AFTER", event: "UPDATE", enabled },
  };
}

async function mountTreeItem(initialNode: TreeNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const node = ref(initialNode);
  const host: SidebarTreeRuntimeHost = {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(host);
  const app = createApp(defineComponent({ setup: () => () => h(TreeItem, { node: node.value, depth: 4 }) }));
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();
  return { container, node, host };
}

beforeEach(async () => {
  databaseType = "sqlserver";
  await setLocale("en");
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  await setLocale("en");
});

describe("TreeItem trigger status", () => {
  it.each(statuses.flatMap((enabled) => statuses.map((valid) => ({ enabled, valid }))))("renders independent disabled and invalid indicators for enabled=$enabled, valid=$valid", async ({ enabled, valid }) => {
    const initialNode = triggerNode(enabled, valid);
    const { container } = await mountTreeItem(initialNode);
    const disabled = container.querySelector(disabledSelector);
    const invalid = container.querySelector(invalidSelector);

    expect(disabled !== null).toBe(enabled === false);
    expect(invalid !== null).toBe(valid === false);
    expect(container.querySelector(".tree-object-label")?.textContent).toBe(`${initialNode.label}${valid === false ? " · INVALID" : ""}`);
    if (disabled && invalid) {
      expect(disabled.classList.contains("-left-1")).toBe(true);
      expect(invalid.classList.contains("-right-1")).toBe(true);
    }
  });

  it("does not infer disabled status when trigger metadata is missing", async () => {
    const initialNode = triggerNode(undefined);
    delete initialNode.meta;
    const { container } = await mountTreeItem(initialNode);

    expect(container.querySelector(disabledSelector)).toBeNull();
    expect(container.querySelector(invalidSelector)).toBeNull();
  });

  it.each(["postgres", "oracle", "xugu"] as const)("respects explicit disabled metadata for %s without changing its label", async (dbType) => {
    databaseType = dbType;
    const initialNode = triggerNode(false);
    if (dbType === "xugu") initialNode.label = "trg_orders_audit (AFTER · UPDATE · Disabled)";
    const { container } = await mountTreeItem(initialNode);

    expect(container.querySelector(disabledSelector)).not.toBeNull();
    expect(container.querySelector(".tree-object-label")?.textContent).toBe(initialNode.label);
  });

  it.each(["table", "view", "index", "function", "group-triggers"] as const)("does not mark unrelated %s nodes as disabled", async (type) => {
    const { container } = await mountTreeItem({ ...triggerNode(false, false), type });

    expect(container.querySelector(disabledSelector)).toBeNull();
    expect(container.querySelector(invalidSelector)).not.toBeNull();
  });

  it("updates the badge after metadata refresh and virtual row reuse", async () => {
    const { container, node } = await mountTreeItem(triggerNode(true));
    expect(container.querySelector(disabledSelector)).toBeNull();

    node.value = triggerNode(false);
    await nextTick();
    expect(container.querySelector(disabledSelector)).not.toBeNull();

    (node.value.meta as TriggerInfo).enabled = true;
    await nextTick();
    expect(container.querySelector(disabledSelector)).toBeNull();

    (node.value.meta as TriggerInfo).enabled = false;
    await nextTick();
    expect(container.querySelector(disabledSelector)).not.toBeNull();

    node.value = triggerNode(null);
    await nextTick();
    expect(container.querySelector(disabledSelector)).toBeNull();

    node.value = triggerNode(false);
    await nextTick();
    node.value = { ...triggerNode(false), id: "connection-1:app:dbo:orders", type: "table" };
    await nextTick();
    expect(container.querySelector(disabledSelector)).toBeNull();
  });

  it("localizes the badge tooltip and accessible name without disabling row activation", async () => {
    const initialNode = triggerNode(false);
    const { container, host } = await mountTreeItem(initialNode);
    const disabled = container.querySelector<HTMLElement>(disabledSelector);
    expect(disabled).not.toBeNull();
    expect(disabled?.getAttribute("role")).toBe("img");
    expect(disabled?.getAttribute("aria-label")).toBe(i18n.global.t("objects.disabled"));
    expect(disabled?.getAttribute("title")).toBe(i18n.global.t("objects.disabled"));
    expect(disabled?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    await setLocale("zh-CN");
    await nextTick();
    expect(disabled?.getAttribute("aria-label")).toBe("禁用");
    expect(disabled?.getAttribute("title")).toBe("禁用");
    expect(container.querySelector(".tree-object-label")?.textContent).toBe(initialNode.label);

    const row = container.querySelector<HTMLElement>("[data-node-id]")!;
    const event = new MouseEvent("dblclick", { bubbles: true });
    row.dispatchEvent(event);
    expect(host.handleRowDoubleClick).toHaveBeenCalledWith(initialNode, event);
    expect(row.getAttribute("aria-disabled")).toBeNull();
  });
});
