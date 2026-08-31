// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { DBX_TABLE_REFERENCE_DROP_EVENT, type QueryEditorTableReferenceDropDetail } from "@/lib/editor/queryEditorTableDrop";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

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
  treeNodes: [],
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

const mountedApps: App[] = [];
const dropListeners: EventListener[] = [];

async function mountTreeItem(props: { reorderDisabled?: boolean; referenceDragDisabled?: boolean }) {
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
});

describe("TreeItem table reference dragging", () => {
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
});
