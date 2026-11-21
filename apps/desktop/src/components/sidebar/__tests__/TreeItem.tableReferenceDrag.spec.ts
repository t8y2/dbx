// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import treeItemSource from "../TreeItem.vue?raw";
import { parse } from "vue/compiler-sfc";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { DBX_TABLE_REFERENCE_DROP_EVENT, type QueryEditorTableReferenceDropDetail } from "@/lib/editor/queryEditorTableDrop";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";
import { applyTableVGroupsToChildren, moveDatabaseVGroupMember, moveTableToVGroup, normalizeTableVGroupLayout, tableVGroupPathForTable, tableVGroupScopeKey, type TableVGroupLayout, type TableVGroupScope } from "@/lib/table/tableVGroup";
import { tableVGroupDropTargetNodeId, tableVGroupDropTargetPosition } from "@/lib/sidebar/sidebarTableVGroupDrag";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "connection-1", db_type: "sqlite" }),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null,
  selectedTreeNodeIds: [],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [] as TreeNode[],
  tableVGroupLayouts: {} as Record<string, TableVGroupLayout>,
  moveTableToVGroup: vi.fn(),
  treeSelectionAnchorId: null,
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { openDataInNewTab: "" },
      sidebarActivation: "single",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
      sidebarCopyTableNameSeparator: "comma",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const tableNode: TreeNode = {
  id: "table-orders",
  label: "orders",
  type: "table",
  connectionId: "connection-1",
  database: "main",
};

// Load the real component styles: state-only tests cannot catch a line whose
// absolute positioning is overridden by the connection-tint content layer.
const treeItemStyles = parse(treeItemSource)
  .descriptor.styles.map((style) => style.content)
  .join("\n");
const originalElementsFromPoint = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
const mountedApps: App[] = [];
const dropListeners: EventListener[] = [];

async function mountTreeItem(props: { node?: TreeNode; reorderDisabled?: boolean; referenceDragDisabled?: boolean }) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(TreeItem, {
          node: tableNode,
          depth: 2,
          ...props,
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, createSidebarTreeRuntime());
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Tree item row was not rendered: ${container.innerHTML}`);
  return row;
}

function listenForTableReferenceDrop() {
  const listener = vi.fn<(event: Event) => void>();
  dropListeners.push(listener);
  window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, listener);
  return listener;
}

function mockEditorDropTarget() {
  const editor = document.createElement("div");
  editor.dataset.queryEditorRoot = "";
  document.body.append(editor);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(editor);
}

function dragToEditor(row: HTMLElement) {
  row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 20 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
}

afterEach(() => {
  for (const listener of dropListeners.splice(0)) window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, listener);
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  if (originalElementsFromPoint) Object.defineProperty(document, "elementsFromPoint", originalElementsFromPoint);
  else Reflect.deleteProperty(document, "elementsFromPoint");
  connectionStore.moveTableToVGroup.mockReset();
  connectionStore.treeNodes = [];
  connectionStore.tableVGroupLayouts = {};
});

describe("TreeItem table reference dragging", () => {
  it.each(["before", "after"] as const)("renders an absolute %s indicator above a colored database folder", async (position) => {
    vi.spyOn(connectionStore, "getConfig").mockImplementation(() => ({ id: "connection-1", db_type: "sqlite", color: "#8967d9" }));
    const scope: TableVGroupScope = { connectionId: "connection-1", objectType: "databases" };
    const source: TreeNode = { id: "db-source", type: "database", label: "aaa", connectionId: "connection-1", database: "aaa" };
    const layout: TableVGroupLayout = { groups: [{ id: "b", name: "正式", collapsed: false }], order: [{ type: "group", id: "b", children: [] }] };
    const root: TreeNode = { id: "connection-1", type: "connection", label: "Connection", connectionId: "connection-1", children: applyTableVGroupsToChildren([source], layout, scope) };
    connectionStore.treeNodes = [root];
    connectionStore.tableVGroupLayouts = { [tableVGroupScopeKey(scope)!]: layout };
    const sourceRow = await mountTreeItem({ node: source });
    const targetRow = await mountTreeItem({ node: root.children![0] });
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 100, height: 30 } as DOMRect);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [targetRow] });
    const compiler = await compile("@tailwind utilities;");
    const styles = document.createElement("style");
    styles.textContent = compiler.build(["absolute", "relative"]) + treeItemStyles;
    document.body.append(styles);

    sourceRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: position === "before" ? 101 : 129 }));
    await nextTick();
    expect(tableVGroupDropTargetPosition.value).toBe(position);
    // Target is a mounted TreeItem, not an artificial div standing in for it.
    const indicator = targetRow.querySelector<HTMLElement>(":scope > div.pointer-events-none");
    expect(indicator).not.toBeNull();
    expect(getComputedStyle(indicator!).position).toBe("absolute");
    expect(Number(getComputedStyle(indicator!).zIndex)).toBeGreaterThan(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await nextTick();
    expect(targetRow.querySelector(":scope > div.pointer-events-none")).toBeNull();
  });

  it.each(["database", "redis-db", "mongo-db", "vector-database"] as const)("moves %s between groups and back to the connection with pointer events", async (type) => {
    const scope: TableVGroupScope = { connectionId: "connection-1", objectType: "databases" };
    const key = tableVGroupScopeKey(scope)!;
    const source: TreeNode = { id: "db-source", type, label: "Displayed database", connectionId: "connection-1", database: "real-name", children: [] };
    const root: TreeNode = { id: "connection-1", type: "connection", label: "Connection", connectionId: "connection-1", children: [] };
    const layout: TableVGroupLayout = {
      groups: [
        { id: "a", name: "A", collapsed: false },
        { id: "b", name: "B", collapsed: true },
      ],
      order: [
        { type: "group", id: "a", children: [{ type: "table", name: "real-name", rowType: type }] },
        { type: "group", id: "b", children: [] },
      ],
    };
    root.children = applyTableVGroupsToChildren([source], layout, scope);
    connectionStore.treeNodes = [root];
    connectionStore.tableVGroupLayouts = { [key]: layout };
    connectionStore.moveTableToVGroup.mockImplementation((targetScope, name, groupId, rowType, placement) => {
      expect(targetScope).toEqual(scope);
      const next = placement ? moveDatabaseVGroupMember(connectionStore.tableVGroupLayouts[key], source, placement, root.children!) : moveTableToVGroup(connectionStore.tableVGroupLayouts[key], name, groupId, rowType);
      connectionStore.tableVGroupLayouts[key] = next;
      root.children = applyTableVGroupsToChildren(root.children!, next, scope);
    });
    const target = document.createElement("div");
    target.dataset.nodeId = "table-vgroup:b";
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 60 } as DOMRect);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [target] });
    const onDrop = listenForTableReferenceDrop();
    const row = await mountTreeItem({ node: source, reorderDisabled: true });
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 20 }));
    // The same row uses a line at its edges and a box only in its middle.
    expect(tableVGroupDropTargetNodeId.value).toBe("table-vgroup:b");
    expect(tableVGroupDropTargetPosition.value).toBe("before");
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 30 }));
    expect(tableVGroupDropTargetPosition.value).toBe("inside");
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 55 }));
    expect(tableVGroupDropTargetPosition.value).toBe("after");
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 30 }));
    expect(tableVGroupDropTargetPosition.value).toBe("inside");
    expect(document.body.textContent).toContain("Displayed database");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
    expect(tableVGroupPathForTable(connectionStore.tableVGroupLayouts[key], "real-name", type)).toEqual(["b"]);
    expect(root.children?.find((node) => node.vgroupId === "b")?.children?.[0]).toBe(source);
    expect(tableVGroupDropTargetNodeId.value).toBeNull();
    // Release between folders, not over the connection: this must leave B.
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 5 }));
    expect(tableVGroupDropTargetPosition.value).toBe("before");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 30, clientY: 5 }));
    expect(tableVGroupPathForTable(connectionStore.tableVGroupLayouts[key], "real-name", type)).toEqual([]);
    expect(root.children?.map((node) => node.label)).toEqual(["A", "Displayed database", "B"]);
    expect(connectionStore.moveTableToVGroup).toHaveBeenLastCalledWith(scope, "real-name", null, type, expect.objectContaining({ position: "before", target: expect.objectContaining({ id: "table-vgroup:b" }) }));
    const restoredLayout = normalizeTableVGroupLayout(JSON.parse(JSON.stringify(connectionStore.tableVGroupLayouts[key])));
    expect(applyTableVGroupsToChildren([source], restoredLayout, scope).map((node) => node.label)).toEqual(["A", "Displayed database", "B"]);
    target.dataset.nodeId = root.id;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 20 }));
    expect(tableVGroupDropTargetNodeId.value).toBe(root.id);
    expect(tableVGroupDropTargetPosition.value).toBe("after");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
    expect(tableVGroupDropTargetNodeId.value).toBeNull();
    expect(tableVGroupDropTargetPosition.value).toBe("inside");
    expect(tableVGroupPathForTable(connectionStore.tableVGroupLayouts[key], "real-name", type)).toEqual([]);
    expect(root.children?.map((node) => node.label)).toEqual(["Displayed database", "A", "B"]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancels database dragging with Escape without emitting an editor drop", async () => {
    mockEditorDropTarget();
    const onDrop = listenForTableReferenceDrop();
    const source: TreeNode = { id: "db", type: "database", label: "main", connectionId: "connection-1", database: "main" };
    const row = await mountTreeItem({ node: source });
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 20 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(connectionStore.moveTableToVGroup).not.toHaveBeenCalled();
    expect(tableVGroupDropTargetNodeId.value).toBeNull();
  });

  it("preserves database reference drops into the query editor", async () => {
    mockEditorDropTarget();
    const onDrop = listenForTableReferenceDrop();
    const row = await mountTreeItem({ node: { id: "db", type: "database", label: "main", connectionId: "connection-1", database: "main" } });
    dragToEditor(row);
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0][0] as CustomEvent<QueryEditorTableReferenceDropDetail>).detail.payload).toMatchObject({ referenceType: "database", database: "main" });
    expect(connectionStore.moveTableToVGroup).not.toHaveBeenCalled();
  });
  it("keeps table reference dragging enabled when tree reordering is disabled", async () => {
    mockEditorDropTarget();
    const onDrop = listenForTableReferenceDrop();

    const row = await mountTreeItem({ reorderDisabled: true });
    dragToEditor(row);

    expect(onDrop).toHaveBeenCalledOnce();
    const detail = (onDrop.mock.calls[0][0] as CustomEvent<QueryEditorTableReferenceDropDetail>).detail;
    expect(detail).toEqual({
      payload: {
        kind: "dbx-table-reference",
        connectionId: "connection-1",
        database: "main",
        tableName: "orders",
        databaseType: "sqlite",
      },
      clientX: 30,
      clientY: 30,
    });
  });

  it("does not start table reference dragging when it is explicitly disabled", async () => {
    mockEditorDropTarget();
    const onDrop = listenForTableReferenceDrop();

    const row = await mountTreeItem({ referenceDragDisabled: true });
    dragToEditor(row);

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("drags multiple selected columns from the same table", async () => {
    mockEditorDropTarget();
    const onDrop = listenForTableReferenceDrop();
    const columnA: TreeNode = {
      id: "column-id",
      label: "id (INTEGER)",
      type: "column",
      connectionId: "connection-1",
      database: "main",
      schema: "main",
      tableName: "orders",
      meta: { name: "id" },
    };
    const columnB: TreeNode = {
      id: "column-name",
      label: "name (TEXT)",
      type: "column",
      connectionId: "connection-1",
      database: "main",
      schema: "main",
      tableName: "orders",
      meta: { name: "name" },
    };
    connectionStore.selectedTreeNodeIds = [columnA.id, columnB.id];
    connectionStore.selectedTreeNodeIdsSet = new Set([columnA.id, columnB.id]);
    connectionStore.selectedTreeNodeId = columnA.id;
    connectionStore.treeNodes = [columnA, columnB];

    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () => h(TreeItem, { node: columnA, depth: 3 }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.provide(sidebarTreeRuntimeKey, createSidebarTreeRuntime());
    app.mount(container);
    await nextTick();

    const row = container.querySelector<HTMLElement>("[tabindex]");
    if (!row) throw new Error("Tree item row was not rendered");
    dragToEditor(row);

    expect(onDrop).toHaveBeenCalledOnce();
    const detail = (onDrop.mock.calls[0][0] as CustomEvent<QueryEditorTableReferenceDropDetail>).detail;
    expect(detail.payload.referenceType).toBe("column");
    expect(detail.payload.columnNames).toEqual(["id", "name"]);
    expect(detail.payload.columnNameSeparator).toBe("comma");
  });
});
