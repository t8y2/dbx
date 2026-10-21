// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const commentMode = ref("comment-inline");
const allowHorizontalScroll = ref(false);

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
      get sidebarAllowHorizontalScroll() {
        return allowHorizontalScroll.value;
      },
      sidebarHiddenTablePrefixes: [],
      get sidebarObjectInfoMode() {
        return commentMode.value;
      },
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
  commentMode.value = "comment-inline";
  allowHorizontalScroll.value = false;
  await setLocale("en");
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await setLocale("en");
});

describe("TreeItem routine and object comments (#9962)", () => {
  const tableNode: TreeNode = {
    id: "connection-1:master:dbo:orders:TABLE",
    label: "orders",
    type: "table",
    comment: "Customer orders",
    sizeBytes: 1536,
    connectionId: "connection-1",
    database: "master",
    schema: "dbo",
  };

  it.each([
    ["both", "Customer orders", 1536],
    ["comment only", "Customer orders", undefined],
    ["size only", undefined, 1536],
    ["neither", undefined, undefined],
  ] as const)("renders available metadata in combination mode: %s", async (_name, comment, sizeBytes) => {
    commentMode.value = "comment-and-size";
    const { container } = await mountTreeItem({ ...tableNode, comment, sizeBytes });
    expect(container.querySelector(".sidebar-object-comment")?.textContent ?? null).toBe(comment ?? null);
    expect(container.querySelector(".tabular-nums")?.textContent ?? null).toBe(sizeBytes === undefined ? null : "1.5 KB");
  });

  it("updates both metadata fields when lazy-loaded object data arrives", async () => {
    commentMode.value = "comment-and-size";
    const { container, node } = await mountTreeItem({ ...tableNode, comment: undefined, sizeBytes: undefined });
    node.value.comment = "Loaded comment";
    node.value.sizeBytes = 0;
    await nextTick();
    expect(container.querySelector(".sidebar-object-comment")?.textContent).toBe("Loaded comment");
    expect(container.querySelector(".tabular-nums")?.textContent).toBe("0 B");
  });

  it.each([false, true])("reserves the right-hand size slot when horizontal scrolling is %s", async (horizontalScroll) => {
    commentMode.value = "comment-and-size";
    allowHorizontalScroll.value = horizontalScroll;
    const { container } = await mountTreeItem({ ...tableNode, label: "long_table_name_".repeat(20), comment: "Long comment ".repeat(40) });
    const comment = container.querySelector(".sidebar-object-comment")!;
    const label = container.querySelector(".tree-object-label")!;
    const size = container.querySelector(".tabular-nums")!;
    const metadata = comment.parentElement!;
    expect(metadata.contains(label)).toBe(true);
    expect(metadata.contains(size)).toBe(false);
    expect(metadata.parentElement).toBe(size.parentElement);
    expect(metadata.classList.contains("min-w-0")).toBe(true);
    expect(metadata.classList.contains("overflow-hidden")).toBe(true);
    expect((label.parentElement as HTMLElement).style.maxWidth).toBe("max(0px, calc(100% - 1rem))");
    expect(comment.classList.contains("truncate")).toBe(true);
    expect(label.classList.contains("truncate")).toBe(true);
    expect(size.classList.contains("shrink-0")).toBe(true);
    expect(size.classList.contains("ml-auto")).toBe(true);
  });

  it.each(["comment-inline", "comment-aligned", "size", "hidden"])("preserves the existing %s mode", async (mode) => {
    commentMode.value = mode;
    const { container } = await mountTreeItem(tableNode, 100);
    expect(container.querySelector(".sidebar-object-comment")?.textContent ?? null).toBe(mode.startsWith("comment-") ? "Customer orders" : null);
    expect(container.querySelector(".tabular-nums")?.textContent ?? null).toBe(mode === "size" ? "1.5 KB" : null);
  });

  it("preserves right-aligned comments without displaying size", async () => {
    commentMode.value = "comment-right";
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { container } = await mountTreeItem(tableNode);
    const leading = container.querySelector(".tree-object-label")!.parentElement!;
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 100 });
    Object.defineProperty(leading.parentElement!, "clientWidth", { configurable: true, value: 400 });
    for (const callback of frames.splice(0)) callback(0);
    await nextTick();
    expect(container.querySelector(".sidebar-object-comment--right")?.textContent).toBe("Customer orders");
    expect(container.querySelector(".tabular-nums")).toBeNull();
  });

  it("switches between existing and combined modes without remounting", async () => {
    const { container } = await mountTreeItem(tableNode);
    for (const mode of ["comment-and-size", "size", "hidden", "comment-inline", "comment-and-size"]) {
      commentMode.value = mode;
      await nextTick();
      expect(container.querySelector(".sidebar-object-comment")?.textContent ?? null).toBe(mode.startsWith("comment-") ? "Customer orders" : null);
      expect(container.querySelector(".tabular-nums")?.textContent ?? null).toBe(mode === "size" || mode === "comment-and-size" ? "1.5 KB" : null);
    }
  });

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
