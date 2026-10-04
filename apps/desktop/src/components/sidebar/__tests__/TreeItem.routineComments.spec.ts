// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";

let commentMode = "comment-inline";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: (): ConnectionConfig =>
    ({
      id: "connection-1",
      name: "Local SQL Server",
      db_type: "sqlserver",
      host: "127.0.0.1",
      port: 1433,
      username: "sa",
      database: "master",
    }) as ConnectionConfig,
  getSidebarVisibleFilterSummary: () => null,
  clearConnectionError: vi.fn(),
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
      sidebarObjectInfoMode: commentMode,
      sidebarShowConnectionNotes: false,
      sidebarShowTooltips: true,
    },
  }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const mountedApps: App[] = [];

async function mountTreeItem(initialNode: TreeNode, commentLabelWidth?: number) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const node = ref(initialNode);
  const host: SidebarTreeRuntimeHost = {
    activeConnectionId: () => "connection-1",
    connectionConfig: () => connectionStore.getConfig(),
    isExpanded: () => false,
    isLoading: () => false,
    isSelected: () => false,
    isFocused: () => false,
    loadChildren: vi.fn(),
    toggleNode: vi.fn(),
  };
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(host);
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node: node.value, depth: 3, commentLabelWidth }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();
  return { container, node, host };
}

beforeEach(async () => {
  commentMode = "comment-inline";
  await setLocale("en");
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  await setLocale("en");
});

describe("TreeItem routine and object comments (#9962)", () => {
  it("renders inline comments for procedures and functions", async () => {
    const procedureNode: TreeNode = {
      id: "connection-1:master:dbo:usp_calculate_tax:PROCEDURE",
      label: "usp_calculate_tax",
      type: "procedure",
      comment: "Calculates order taxes",
      connectionId: "connection-1",
      database: "master",
      schema: "dbo",
    };

    const { container } = await mountTreeItem(procedureNode);
    const commentEl = container.querySelector(".sidebar-object-comment");
    expect(commentEl).not.toBeNull();
    expect(commentEl?.textContent).toBe("Calculates order taxes");
  });

  it("renders inline comments for functions", async () => {
    const functionNode: TreeNode = {
      id: "connection-1:master:dbo:fn_get_total:FUNCTION",
      label: "fn_get_total",
      type: "function",
      comment: "Sums line items",
      connectionId: "connection-1",
      database: "master",
      schema: "dbo",
    };

    const { container } = await mountTreeItem(functionNode);
    const commentEl = container.querySelector(".sidebar-object-comment");
    expect(commentEl).not.toBeNull();
    expect(commentEl?.textContent).toBe("Sums line items");
  });

  it("does not render comment element when procedure has no comment", async () => {
    const procedureNode: TreeNode = {
      id: "connection-1:master:dbo:usp_no_comment:PROCEDURE",
      label: "usp_no_comment",
      type: "procedure",
      connectionId: "connection-1",
      database: "master",
      schema: "dbo",
    };

    const { container } = await mountTreeItem(procedureNode);
    expect(container.querySelector(".sidebar-object-comment")).toBeNull();
  });
});
