import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

function connection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    connect_timeout_inherit: false,
    query_timeout_inherit: false,
  };
}

const groupedLayout: SidebarLayout = {
  groups: [
    { id: "parent", name: "Parent", collapsed: false },
    { id: "child", name: "Child", collapsed: false },
  ],
  order: [
    {
      type: "group",
      id: "parent",
      children: [{ type: "group", id: "child", children: [{ type: "connection", id: "existing" }] }],
    },
  ],
};

describe("connectionStore creating connections in groups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
    setActivePinia(createPinia());
  });

  it("places a new connection in the explicitly selected nested group", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = structuredClone(groupedLayout);

    await store.addConnection(connection("created"), "child");

    expect(store.groupIdForConnection("created")).toBe("child");
    expect(store.connectionGroupPaths.get("created")).toEqual(["Parent", "Child"]);
  });

  it("places a new connection at the top level when ungrouped is selected", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = structuredClone(groupedLayout);
    store.startCreatingConnectionInGroup("child");

    await store.addConnection(connection("created"), null);

    expect(store.groupIdForConnection("created")).toBeNull();
    expect(store.sidebarLayout.order.at(-1)).toEqual({ type: "connection", id: "created" });
    expect(store.newConnectionGroupId).toBeNull();
  });

  it("derives the default group from a selected descendant node", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = structuredClone(groupedLayout);
    store.addEphemeralConnection(connection("existing"));
    store.treeNodes = [
      {
        id: "parent",
        label: "Parent",
        type: "connection-group",
        children: [
          {
            id: "child",
            label: "Child",
            type: "connection-group",
            children: [
              {
                id: "existing",
                label: "existing",
                type: "connection",
                connectionId: "existing",
                children: [{ id: "existing:demo", label: "demo", type: "database", connectionId: "existing" }],
              },
            ],
          },
        ],
      },
    ];

    store.selectedTreeNodeId = "existing:demo";

    expect(store.selectedConnectionGroupId).toBe("child");
  });
});
