// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { SidebarVisibleFilterSummary } from "@/lib/sidebar/sidebarVisibleFilterSummary";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const state: {
  config: ConnectionConfig;
  summary: SidebarVisibleFilterSummary;
} = {
  config: mysqlConnection(),
  summary: { mode: "database", isActive: true, selected: 2, total: 3 },
};

function mysqlConnection(): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Filtered connection",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "filter_alpha",
  } as ConnectionConfig;
}

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => state.config,
  getSidebarVisibleFilterSummary: () => state.summary,
  clearConnectionError: vi.fn(),
  isDefaultDatabase: () => false,
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
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mountedApps: App[] = [];

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

async function openConnectionTooltip() {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const node: TreeNode = {
    id: "connection-1",
    label: "Filtered connection",
    type: "connection",
    connectionId: "connection-1",
    isExpanded: true,
    children: [],
  };
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 0 }),
    }),
  );
  mountedApps.push(app);
  const runtime = createSidebarTreeRuntime();
  const host = runtimeHost();
  runtime.bindHost(host);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Connection row was not rendered: ${container.innerHTML}`);
  const trigger = row.parentElement;
  if (!trigger) throw new Error(`Connection tooltip trigger was not rendered: ${container.innerHTML}`);
  vi.spyOn(row, "matches").mockImplementation((selector) => selector === ":hover");
  trigger.dispatchEvent(new MouseEvent("mouseenter"));
  await vi.runAllTimersAsync();
  await nextTick();
  return { host, node };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
  state.config = mysqlConnection();
  state.summary = { mode: "database", isActive: true, selected: 2, total: 3 };
});

describe("TreeItem visible filter connection detail", () => {
  it("shows an active database filter count in the connection tooltip", async () => {
    const { host, node } = await openConnectionTooltip();

    expect(document.body.textContent).toContain("Visible databases");
    expect(document.body.textContent).toContain("2/3");
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "2/3");
    expect(action).toBeDefined();
    expect(action?.getAttribute("aria-label")).toBe('Configure visible databases for "Filtered connection"');
    expect(action?.classList.contains("bg-primary/10")).toBe(true);
    expect(action?.classList.contains("underline")).toBe(false);
    expect(action?.classList.contains("hover:underline")).toBe(true);
    expect(action?.classList.contains("hover:bg-primary/10")).toBe(false);
    action?.click();
    expect(host.openPrimaryVisibleFilter).toHaveBeenCalledWith(node);
  });

  it("uses the schema label for a schema-mode summary", async () => {
    state.config = { ...mysqlConnection(), db_type: "oracle", database: "ORCL" };
    state.summary = { mode: "schema", isActive: true, selected: 1, total: 4 };

    await openConnectionTooltip();

    expect(document.body.textContent).toContain("Visible schemas");
    expect(document.body.textContent).toContain("1/4");
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "1/4");
    expect(action?.getAttribute("aria-label")).toBe('Configure visible schemas for "Filtered connection"');
  });

  it("uses the namespace label for a Nacos connection", async () => {
    state.config = { ...mysqlConnection(), db_type: "nacos" };
    state.summary = { mode: "namespace", isActive: true, selected: 2, total: 3 };

    await openConnectionTooltip();

    expect(document.body.textContent).toContain("Visible namespaces");
    expect(document.body.textContent).toContain("2/3");
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "2/3");
    expect(action?.getAttribute("aria-label")).toBe('Configure visible namespaces for "Filtered connection"');
  });

  it("shows a clickable detail row when the effective selection is full", async () => {
    state.summary = { mode: "database", isActive: false, selected: 3, total: 3 };

    const { host, node } = await openConnectionTooltip();

    expect(document.body.textContent).toContain("Visible databases");
    expect(document.body.textContent).toContain("3/3");
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "3/3");
    expect(action).toBeDefined();
    action?.click();
    expect(host.openPrimaryVisibleFilter).toHaveBeenCalledWith(node);
  });
});
