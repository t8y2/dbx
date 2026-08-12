// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "mqtt-1",
  connectedIds: new Set(["mqtt-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "mqtt-1", name: "test-mqtt", db_type: "mqtt" }),
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

async function mountMqttConsoleNode() {
  const container = document.createElement("div");
  document.body.append(container);
  const node: TreeNode = {
    id: "mqtt-1:mqtt-topic:__console__",
    label: "connection.mqttConsoleTitle",
    type: "mqtt-topic",
    connectionId: "mqtt-1",
    children: [],
  };
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 1 }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`MQTT console row was not rendered: ${container.innerHTML}`);
  return row;
}

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  await setLocale("en");
  vi.restoreAllMocks();
});

describe("TreeItem MQTT console i18n", () => {
  it("updates the existing synthetic node when the locale changes", async () => {
    await setLocale("en");
    const row = await mountMqttConsoleNode();

    expect(row.textContent).toContain("MQTT Console");

    await setLocale("zh-CN");
    await nextTick();

    expect(row.textContent).toContain("MQTT 控制台");
    expect(row.textContent).not.toContain("MQTT Console");
  });
});
