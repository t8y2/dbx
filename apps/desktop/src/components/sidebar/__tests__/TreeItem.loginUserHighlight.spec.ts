// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";

let connectionConfig: ConnectionConfig;

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => connectionConfig,
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

function config(dbType: ConnectionConfig["db_type"], username: string): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Test connection",
    db_type: dbType,
    host: "127.0.0.1",
    port: dbType === "oracle" ? 1521 : 5432,
    username,
    password: "",
    database: dbType === "oracle" ? "ORCL" : "app",
  } as ConnectionConfig;
}

async function mountSchema(label: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const node: TreeNode = {
    id: `connection-1:${label}`,
    label,
    type: "schema",
    connectionId: "connection-1",
    database: connectionConfig.database,
    schema: label,
  };
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 1 }),
    }),
  );
  mountedApps.push(app);
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const labelElement = [...container.querySelectorAll<HTMLElement>("span.min-w-0.truncate")].find((element) => element.textContent?.trim() === label);
  if (!labelElement) throw new Error(`Schema label was not rendered: ${container.innerHTML}`);
  return labelElement;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("TreeItem login user highlighting", () => {
  it("keeps PostgreSQL schema nodes at the normal weight", async () => {
    connectionConfig = config("postgres", "postgres");

    const label = await mountSchema("postgres");

    expect(label.classList.contains("tree-object-label")).toBe(true);
    expect(label.classList.contains("font-semibold")).toBe(false);
  });

  it("highlights only the matching Oracle login user schema", async () => {
    connectionConfig = config("oracle", "scott");

    const loginSchema = await mountSchema("SCOTT");
    const otherSchema = await mountSchema("SYSTEM");

    expect(loginSchema.classList.contains("tree-object-label")).toBe(true);
    expect(loginSchema.classList.contains("font-semibold")).toBe(true);
    expect(otherSchema.classList.contains("tree-object-label")).toBe(true);
    expect(otherSchema.classList.contains("font-semibold")).toBe(false);
  });
});
