import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

// Verbatim shape of the WeChat report: an encrypted handshake that fails on a
// SQL Server 2014 instance, then a no-encryption fallback that reaches the login
// stage and is rejected because the saved database no longer exists (4060).
const LEGACY_SQLSERVER_CONNECT_ERROR = [
  "SQL Server connection failed: An error occured during the attempt of performing I/O: tls handshake eof",
  "",
  "This may be caused by an old SQL Server TLS/encryption configuration. If you are connecting to SQL Server 2008/2008 R2/2012 or another legacy instance, try SQL Server legacy compatibility mode. It first behaves like encrypt=false and, when explicitly enabled, DBX can also fall back to the SQL Server legacy compatibility driver for TLS 1.0 encrypted transport. Only use this mode on trusted networks, VPNs, or SSH tunnels.",
  "",
  "Automatic native legacy fallback also failed: login-only encryption failed: SQL Server connection failed: An error occured during the attempt of performing I/O: tls handshake eof",
  "no-encryption compatibility fallback failed: SQL Server connection failed: Token error: '无法打开登录所请求的数据库 \"cwxt2025\"。登录失败。' on server iZw1wl8nyooomlZ executing  on line 1 (code: 4060, state: 1, class: 11)",
].join("\n");

function sqlServerConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "mssql-1",
    name: "iZw1wl8nyooomlZ",
    db_type: "sqlserver",
    host: "10.0.0.9",
    port: 1433,
    username: "sa",
    password: "secret",
    database: "cwxt2025",
    read_only: false,
    ...overrides,
  } as ConnectionConfig;
}

function connectionTree(connection: ConnectionConfig): { connectionNode: TreeNode; tablesGroup: TreeNode } {
  const tablesGroup: TreeNode = {
    id: `${connection.id}:${connection.database}:__tables`,
    label: "tree.tables",
    type: "group-tables",
    connectionId: connection.id,
    database: connection.database,
    isExpanded: true,
    children: [],
  };
  const connectionNode: TreeNode = {
    id: connection.id,
    label: connection.name,
    type: "connection",
    connectionId: connection.id,
    isExpanded: true,
    children: [
      {
        id: `${connection.id}:${connection.database}`,
        label: String(connection.database),
        type: "database",
        connectionId: connection.id,
        database: connection.database,
        isExpanded: true,
        children: [tablesGroup],
      },
    ],
  };
  return { connectionNode, tablesGroup };
}

function mockBackend(connectDb: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockRejectedValue(new Error("back end pool is gone")),
    connectDb,
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }));
}

describe("connectionStore sidebar search connection failures", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
  });

  it("keeps only a one-line skip hint when a background search load cannot reconnect", async () => {
    const connectDb = vi.fn().mockRejectedValue(new Error(LEGACY_SQLSERVER_CONNECT_ERROR));
    mockBackend(connectDb);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = sqlServerConnection();
    const { connectionNode, tablesGroup } = connectionTree(connection);
    store.connections = [connection];
    store.treeNodes = [connectionNode];
    store.connectedIds = new Set([connection.id]);
    store.activeConnectionId = connection.id;

    await expect(store.loadObjectGroupChildren(tablesGroup, { force: true, sidebarSearch: true })).rejects.toThrow();

    expect(connectDb).toHaveBeenCalled();
    const recorded = store.connectionErrors[connection.id];
    // Search is a background projection: the node keeps one actionable line
    // instead of the raw driver transcript with the misleading TLS hint.
    expect(recorded).toBe(`Search skipped this connection: ${LEGACY_SQLSERVER_CONNECT_ERROR.split("\n")[0]}`);
    expect(recorded).not.toContain("\n");
    expect(recorded).not.toContain("This may be caused by an old SQL Server TLS/encryption configuration");
    expect(store.connectedIds.has(connection.id)).toBe(false);
  }, 15_000);

  it("still surfaces the full driver error for the same failure outside a search load", async () => {
    const connectDb = vi.fn().mockRejectedValue(new Error(LEGACY_SQLSERVER_CONNECT_ERROR));
    mockBackend(connectDb);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = sqlServerConnection();
    const { connectionNode, tablesGroup } = connectionTree(connection);
    store.connections = [connection];
    store.treeNodes = [connectionNode];
    store.connectedIds = new Set([connection.id]);

    await expect(store.loadObjectGroupChildren(tablesGroup, { force: true })).rejects.toThrow();

    // An explicit action keeps the whole error so the user can read the real cause.
    expect(store.connectionErrors[connection.id]).toBe(LEGACY_SQLSERVER_CONNECT_ERROR);
  }, 15_000);

  // A live connection whose metadata query fails with a query-level error (SQL
  // Server code 229, SELECT permission denied) must survive a background search:
  // before the markConnectionLost gate, any non-cancelled search-driven failure
  // silently disconnected it and cleared activeConnectionId.
  const PERMISSION_DENIED_ERROR = 'SQL Server query failed: Token error: \'The SELECT permission was denied on the object "tables", database "cwxt2025", schema "dbo".\' on server iZw1wl8nyooomlZ (code: 229, state: 1, class: 16)';

  const CONNECTION_LEVEL_ERROR = "SQL Server connection failed: An error occured during the attempt of performing I/O: connection reset by peer";

  async function connectStoreWithLiveConnection(listTablesError: string) {
    const connectDb = vi.fn();
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const listTables = vi.fn().mockRejectedValue(new Error(listTablesError));
    mockBackend(connectDb, { checkConnectionHealth, listTables });

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = sqlServerConnection();
    const { connectionNode, tablesGroup } = connectionTree(connection);
    store.connections = [connection];
    store.treeNodes = [connectionNode];
    store.connectedIds = new Set([connection.id]);
    store.activeConnectionId = connection.id;
    return { store, connection, tablesGroup, connectDb };
  }

  it("keeps a live connection connected when a search load fails with a query-level permission error", async () => {
    const { store, connection, tablesGroup, connectDb } = await connectStoreWithLiveConnection(PERMISSION_DENIED_ERROR);

    await expect(store.loadObjectGroupChildren(tablesGroup, { force: true, sidebarSearch: true })).rejects.toThrow(PERMISSION_DENIED_ERROR);

    // A permission error is a query-level problem: the search records its one-line
    // skip hint but must not disconnect the user's live connection.
    expect(connectDb).not.toHaveBeenCalled();
    expect(store.connectionErrors[connection.id]).toBe(`Search skipped this connection: ${PERMISSION_DENIED_ERROR}`);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.activeConnectionId).toBe(connection.id);
  }, 15_000);

  it("still marks a live connection lost when a search load fails with a connection-level error", async () => {
    const { store, connection, tablesGroup } = await connectStoreWithLiveConnection(CONNECTION_LEVEL_ERROR);

    await expect(store.loadObjectGroupChildren(tablesGroup, { force: true, sidebarSearch: true })).rejects.toThrow(CONNECTION_LEVEL_ERROR);

    // A transport-level failure really did kill the connection: passive
    // disconnect (and the one-line skip hint) still applies.
    expect(store.connectionErrors[connection.id]).toBe(`Search skipped this connection: ${CONNECTION_LEVEL_ERROR}`);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.activeConnectionId).toBeNull();
  }, 15_000);
});
