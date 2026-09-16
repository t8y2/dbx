import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";

function postgresConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Reporting",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "secret",
    database: "analytics",
    read_only: false,
    note: "Production reporting",
    ...overrides,
  } as ConnectionConfig;
}

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

async function createStore(saveConnections: ReturnType<typeof vi.fn>) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    saveConnections,
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  return useConnectionStore();
}

describe("connectionStore quick rename", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists only the trimmed name while preserving runtime and tree identity", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const store = await createStore(saveConnections);
    const connection = postgresConnection();
    const layout: SidebarLayout = {
      groups: [{ id: "group-1", name: "Production", collapsed: false }],
      order: [{ type: "group", id: "group-1", children: [{ type: "connection", id: connection.id }] }],
    };
    const existingNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [],
    };
    store.connections = [connection];
    store.sidebarLayout = layout;
    store.treeNodes = [existingNode];
    store.connectedIds.add(connection.id);
    store.activeConnectionId = connection.id;
    store.selectedTreeNodeId = connection.id;
    store.selectedTreeNodeIds = [connection.id];

    await expect(store.renameConnection(connection.id, "  Reporting EU  ")).resolves.toBe(true);

    expect(saveConnections).toHaveBeenCalledWith([{ ...connection, name: "Reporting EU" }]);
    expect(store.getConfig(connection.id)).toEqual({ ...connection, name: "Reporting EU" });
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.activeConnectionId).toBe(connection.id);
    expect(store.selectedTreeNodeId).toBe(connection.id);
    expect(store.selectedTreeNodeIds).toEqual([connection.id]);
    expect(store.sidebarLayout).toStrictEqual(layout);
    const renamedNode = store.treeNodes[0]?.children?.find((node) => node.id === connection.id);
    expect(renamedNode).toEqual(expect.objectContaining({ id: connection.id, label: "Reporting EU", isExpanded: true }));
  });

  it("does not mutate the connection when persistence fails", async () => {
    const saveConnections = vi.fn().mockRejectedValue(new Error("disk full"));
    const store = await createStore(saveConnections);
    const connection = postgresConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await expect(store.renameConnection(connection.id, "Renamed")).rejects.toThrow("disk full");

    expect(store.getConfig(connection.id)).toEqual(connection);
    expect(store.connectedIds.has(connection.id)).toBe(true);
  });

  it("ignores blank, unchanged, and missing connection names", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const store = await createStore(saveConnections);
    const connection = postgresConnection();
    store.connections = [connection];

    await expect(store.renameConnection(connection.id, "   ")).resolves.toBe(false);
    await expect(store.renameConnection(connection.id, ` ${connection.name} `)).resolves.toBe(false);
    await expect(store.renameConnection("missing", "Renamed")).resolves.toBe(false);

    expect(saveConnections).not.toHaveBeenCalled();
    expect(store.getConfig(connection.id)).toEqual(connection);
  });
});
