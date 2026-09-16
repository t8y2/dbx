// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";

const renameConnection = vi.fn();
const toast = vi.fn();
const connection: ConnectionConfig = {
  id: "connection-1",
  name: "Reporting",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "",
};
const connectionStore = {
  activeConnectionId: connection.id,
  connectedIds: new Set([connection.id]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [connection],
  getConfig: () => connection,
  getSidebarVisibleFilterSummary: () => null,
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  renameConnection,
  selectedTreeNodeId: connection.id as string | null,
  selectedTreeNodeIds: [connection.id],
  selectedTreeNodeIdsSet: new Set([connection.id]),
  sidebarLayout: { groups: [], order: [] } as SidebarLayout,
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [] as TreeNode[],
  treeSelectionAnchorId: connection.id as string | null,
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
      sidebarActivation: "double",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
      sidebarTableSearchLocal: false,
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/connection/ConnectionErrorIndicator.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/ui/badge", () => ({ Badge: { template: "<span><slot /></span>" } }));
vi.mock("@/components/ui/input", () => ({ Input: { template: "<input />" } }));
vi.mock("@/components/ui/switch", () => ({ Switch: { template: "<input />" } }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: { template: "<span><slot /></span>" } }));

const mountedApps: App[] = [];
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      connection: {
        saveFailed: "Failed to save connection: {message}",
      },
    },
  },
});

function runtimeHost(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

async function mountConnectionRename() {
  const container = document.createElement("div");
  document.body.append(container);
  const node: TreeNode = {
    id: connection.id,
    label: connection.name,
    type: "connection",
    connectionId: connection.id,
    children: [],
  };
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 0, pendingRename: true }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`Connection rename input was not rendered: ${container.innerHTML}`);
  return { container, input };
}

function typeName(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  renameConnection.mockReset().mockResolvedValue(true);
  toast.mockReset();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("TreeItem connection quick rename", () => {
  it("trims and persists the edited name on Enter", async () => {
    const { input } = await mountConnectionRename();
    typeName(input, "  Reporting EU  ");

    press(input, "Enter");

    await vi.waitFor(() => expect(renameConnection).toHaveBeenCalledWith(connection.id, "Reporting EU"));
    expect(renameConnection).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   ", connection.name])("cancels blank or unchanged input %j", async (name) => {
    const { input } = await mountConnectionRename();
    typeName(input, name);

    press(input, "Enter");
    await nextTick();

    expect(renameConnection).not.toHaveBeenCalled();
  });

  it("cancels on Escape without persisting", async () => {
    const { container, input } = await mountConnectionRename();
    typeName(input, "Reporting EU");

    press(input, "Escape");
    await nextTick();

    expect(renameConnection).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain(connection.name);
  });

  it("surfaces persistence failures", async () => {
    renameConnection.mockRejectedValueOnce(new Error("disk full"));
    const { input } = await mountConnectionRename();
    typeName(input, "Reporting EU");

    press(input, "Enter");

    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("disk full"), 5000));
  });

  it("keeps Enter scoped to the table-search input without triggering a tree row action", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let bubbledKeydowns = 0;
    container.addEventListener("keydown", () => {
      bubbledKeydowns += 1;
    });
    const host = runtimeHost();
    const runtime = createSidebarTreeRuntime();
    runtime.bindHost(host);
    const setTableSearchQuery = vi.fn();
    const node: TreeNode = {
      id: "connection-1:app:__table_search",
      label: "sidebar.searchTablesInCurrentScope",
      type: "table-search-control",
      connectionId: connection.id,
      database: "app",
      tableSearchParentId: "connection-1:app",
    };
    const app = createApp(
      defineComponent({
        setup: () => () => h(TreeItem, { node, depth: 2 }),
      }),
    );
    app.use(i18n);
    app.provide(sidebarTreeRuntimeKey, runtime);
    app.provide(sidebarTreeContextKey, {
      getVisibleNodes: () => [],
      getVisibleNodeIndex: () => -1,
      setTableSearchQuery,
    });
    app.mount(container);
    mountedApps.push(app);
    await nextTick();

    const input = container.querySelector<HTMLInputElement>("[data-sidebar-table-search-parent-id]");
    expect(input).toBeTruthy();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(bubbledKeydowns).toBe(0);
    expect(host.handleRowKeydown).not.toHaveBeenCalled();
    expect(setTableSearchQuery).not.toHaveBeenCalled();
  });
});
