import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isReactive } from "vue";
import type { ColumnInfo, ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  } as ConnectionConfig;
}

function columns(count: number): ColumnInfo[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        name: `col_${index}`,
        data_type: "text",
        is_nullable: true,
        column_default: null,
        is_primary_key: index === 0,
        comment: null,
      }) as unknown as ColumnInfo,
  );
}

function findById(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

const GROUP_ID = "pg-1:app:public:users:__columns";

async function setupStoreWithColumnGroup() {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

  async function loadStore(getColumns: ReturnType<typeof vi.fn>) {
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      getColumns,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "pg-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [
              {
                id: "pg-1:app:public:users",
                label: "users",
                type: "table",
                connectionId: connection.id,
                database: "app",
                schema: "public",
                tableName: "users",
                isExpanded: true,
                children: [
                  {
                    id: GROUP_ID,
                    label: "Columns",
                    type: "group-columns",
                    connectionId: connection.id,
                    database: "app",
                    schema: "public",
                    tableName: "users",
                    isExpanded: false,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    return store;
  }

  return { loadStore };
}

describe("connectionStore schema tree memory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("marks leaf column nodes raw so Vue does not deep-wrap them", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(5));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);

    const group = findById(store.treeNodes, GROUP_ID);
    expect(group?.children).toHaveLength(5);
    // The container group stays reactive so expand/collapse still drives the UI...
    expect(isReactive(group!)).toBe(true);
    // ...but every leaf column (and, transitively, its `meta`) is raw.
    for (const leaf of group!.children ?? []) {
      expect(isReactive(leaf)).toBe(false);
      expect(isReactive(leaf.meta as object)).toBe(false);
    }
  });

  it("releases a large collapsed subtree and reloads it on demand", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(500));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toHaveLength(500);
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(true);

    const released = store.releaseCollapsedTreeNodeChildren(GROUP_ID);

    expect(released).toBe(true);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toEqual([]);
    // Forgetting the loaded id is what makes a later expand reload the children.
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(false);
  });

  it("keeps a small collapsed subtree so routine expand/collapse stays instant", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(20));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);

    const released = store.releaseCollapsedTreeNodeChildren(GROUP_ID);

    expect(released).toBe(false);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toHaveLength(20);
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(true);
  });
});
