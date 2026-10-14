// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionGroup, SidebarLayout, TreeNode } from "@/types/database";

// Session-scoped unlock state: only groups whose id is present here count as
// unlocked. Mirrors the in-memory `unlockedConnectionGroupIds` ref of the real
// store so each case can independently set up lock/unlock.
const unlockedGroupIds = new Set<string>();
const layoutGroups: ConnectionGroup[] = [];

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [{ id: "connection-1" }],
  getConfig: () => ({
    id: "connection-1",
    name: "Orders",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
  }),
  getSidebarVisibleFilterSummary: () => null,
  clearConnectionError: vi.fn(),
  isConnectionGroupUnlocked: (groupId: string) => unlockedGroupIds.has(groupId),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarLayout: { groups: layoutGroups, order: [] } as SidebarLayout,
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [] as TreeNode[],
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
      sidebarDensity: "default",
      sidebarShowTooltips: false,
      sidebarIndent: 16,
      sidebarTableSearchLocal: true,
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mountedApps: App[] = [];

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
  unlockedGroupIds.clear();
  layoutGroups.splice(0, layoutGroups.length);
});

function runtimeHost(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    resolveContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    openDdlForSelection: vi.fn(async () => false),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

async function mountTreeItem(node: TreeNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 2 }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Tree item row was not rendered: ${container.innerHTML}`);
  return row;
}

function groupNode(id: string): TreeNode {
  return { id, label: `Group ${id}`, type: "connection-group", children: [] };
}

function protectedGroup(id: string): ConnectionGroup {
  return { id, name: `Group ${id}`, collapsed: false, passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==" };
}

describe("TreeItem connection group lock badge", () => {
  it("shows the closed lock badge while a protected group is locked", async () => {
    layoutGroups.push(protectedGroup("group-1"));
    const row = await mountTreeItem(groupNode("group-1"));

    const badge = row.querySelector("svg.lucide-lock-keyhole");
    expect(badge).not.toBeNull();
    const title = badge?.getAttribute("title");
    expect(title).toBe(i18n.global.t("connectionGroup.lockedTooltip"));
    expect(title).not.toContain("connectionGroup");
    expect(row.querySelector("svg.lucide-lock-keyhole-open")).toBeNull();
  });

  it("shows the open lock badge for a protected group unlocked in this session", async () => {
    layoutGroups.push(protectedGroup("group-1"));
    unlockedGroupIds.add("group-1");
    const row = await mountTreeItem(groupNode("group-1"));

    const badge = row.querySelector("svg.lucide-lock-keyhole-open");
    expect(badge).not.toBeNull();
    const title = badge?.getAttribute("title");
    expect(title).toBe(i18n.global.t("connectionGroup.unlockedTooltip"));
    expect(title).not.toContain("connectionGroup");
    expect(row.querySelector("svg.lucide-lock-keyhole")).toBeNull();
  });

  it("shows no badge for an unprotected group", async () => {
    layoutGroups.push({ id: "group-1", name: "Group group-1", collapsed: false });
    const row = await mountTreeItem(groupNode("group-1"));

    expect(row.querySelector("svg.lucide-lock-keyhole")).toBeNull();
    expect(row.querySelector("svg.lucide-lock-keyhole-open")).toBeNull();
  });

  it("shows no open lock badge when a stale unlock entry exists without a stored password", async () => {
    layoutGroups.push({ id: "group-1", name: "Group group-1", collapsed: false });
    unlockedGroupIds.add("group-1");
    const row = await mountTreeItem(groupNode("group-1"));

    expect(row.querySelector("svg.lucide-lock-keyhole")).toBeNull();
    expect(row.querySelector("svg.lucide-lock-keyhole-open")).toBeNull();
  });

  it("shows no badge for a group missing from the sidebar layout", async () => {
    const row = await mountTreeItem(groupNode("group-1"));

    expect(row.querySelector("svg.lucide-lock-keyhole")).toBeNull();
    expect(row.querySelector("svg.lucide-lock-keyhole-open")).toBeNull();
  });

  it("shows no protection badge on non-group rows", async () => {
    layoutGroups.push(protectedGroup("group-1"));
    unlockedGroupIds.add("group-1");
    const row = await mountTreeItem({ id: "connection-1", label: "Orders", type: "connection", connectionId: "connection-1" });

    expect(row.querySelector("svg.lucide-lock-keyhole")).toBeNull();
    expect(row.querySelector("svg.lucide-lock-keyhole-open")).toBeNull();
  });
});
