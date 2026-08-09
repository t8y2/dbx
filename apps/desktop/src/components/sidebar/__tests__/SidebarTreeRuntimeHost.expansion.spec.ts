// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  sidebarSearchQuery: "",
  canUseLoadedTreeNodeToggle: vi.fn(() => true),
  releaseCollapsedTreeNodeChildren: vi.fn(),
  getConfig: vi.fn(() => ({ db_type: "mysql" })),
};

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "connection attempt cancelled",
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: {} }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: vi.fn() }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({ useSidebarDatabaseSpecificMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  connectionStore.sidebarSearchQuery = "";
  vi.clearAllMocks();
});

describe("SidebarTreeRuntimeHost expansion", () => {
  it("publishes a rendered group collapse and synchronizes the live tree", async () => {
    const liveGroup: TreeNode = {
      id: "connection:database:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "connection",
      database: "database",
      isExpanded: true,
      children: [],
    };
    const renderedGroup: TreeNode = { ...liveGroup };
    connectionStore.treeNodes = [liveGroup];

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const toggled = vi.fn((node: TreeNode, expanded: boolean) => {
      syncSidebarTreeNodeExpansion(connectionStore.treeNodes, node, expanded);
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: renderedGroup, depth: 0, onNodeToggled: toggled }),
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    host.value?.toggleNode(renderedGroup);
    await nextTick();

    expect(toggled).toHaveBeenCalledWith(renderedGroup, false);
    expect(liveGroup.isExpanded).toBe(false);
  });
});
