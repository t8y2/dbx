import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";

const { connectionIsOpen, connectionIdentifierQuote, connectDb, checkConnectionHealth, loadConnections, saveConnections, saveEditorSettings } = vi.hoisted(() => ({
  connectionIsOpen: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
  connectDb: vi.fn(),
  checkConnectionHealth: vi.fn(),
  loadConnections: vi.fn(),
  saveConnections: vi.fn(),
  saveEditorSettings: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => ({
  connectionIsOpen,
  connectionIdentifierQuote,
  connectDb,
  checkConnectionHealth,
  loadConnections,
  saveConnections,
  saveEditorSettings,
  loadEditorSettings: vi.fn(async () => null),
  loadPinnedTreeNodeIds: vi.fn(async () => []),
  loadTunnelProfiles: vi.fn(async () => []),
  loadTableVGroups: vi.fn(async () => ({})),
  loadSidebarLayout: vi.fn(async () => null),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => {}),
  connectionDatabaseInfo: vi.fn(async () => undefined),
  listDatabases: vi.fn(async () => []),
  disconnectDb: vi.fn(async () => {}),
  saveTabs: vi.fn(async () => {}),
  saveOpenTabsState: vi.fn(async () => {}),
}));
let pinia: Pinia;
beforeEach(() => {
  vi.clearAllMocks();
  connectionIsOpen.mockReset();
  connectionIdentifierQuote.mockReset();
  checkConnectionHealth.mockResolvedValue(undefined);
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => disposePinia(pinia));
function config(id: string): ConnectionConfig {
  return { id, name: id, db_type: "mysql", host: "localhost", port: 3306, username: "fixture", password: "" };
}
async function storeFixture() {
  const store = useConnectionStore();
  store.connections = [config("A"), config("B"), config("offline")];
  return store;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("backend-confirmed connected state synchronization", () => {
  it("adds only backend-open connections and removes confirmed closed entries without connecting", async () => {
    const store = await storeFixture();
    store.connectedIds.add("offline");
    connectionIsOpen.mockImplementation(async (id) => id === "A" || id === "B");
    await store.refreshConnectedConnections();
    expect([...store.connectedIds]).toEqual(["A", "B"]);
    expect(connectDb).not.toHaveBeenCalled();
    expect(checkConnectionHealth).not.toHaveBeenCalled();
  });

  it("retains existing state when the read-only status request fails", async () => {
    const store = await storeFixture();
    store.connectedIds.add("B");
    connectionIsOpen.mockRejectedValue(new Error("IPC unavailable"));
    await store.refreshConnectedConnections();
    expect([...store.connectedIds]).toEqual(["B"]);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer refresh with a delayed response", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    let finish!: (open: boolean) => void;
    connectionIsOpen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const older = store.refreshConnectedConnections();
    connectionIsOpen.mockResolvedValue(false);
    const newer = store.refreshConnectedConnections();
    finish(true);
    await Promise.all([older, newer]);
    expect([...store.connectedIds]).toEqual([]);
  });

  it.each([
    { dbType: "opengauss", quote: "`" },
    { dbType: "spanner", quote: '"' },
  ] as const)("loads the $dbType driver quote before marking an adopted connection ready", async ({ dbType, quote }) => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: dbType }];
    connectionIsOpen.mockResolvedValue(true);
    const metadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValue(metadata.promise);

    const pending = store.refreshConnectedConnections();
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledOnce());
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    metadata.resolve(quote);
    await pending;
    await store.ensureConnected("A");

    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectionIdentifierQuote).toHaveBeenCalledExactlyOnceWith("A", undefined, { existingOnly: true });
    expect(quoteTableDataIdentifier(dbType, "order", store.connectionIdentifierQuote("A"))).toBe(`${quote}order${quote}`);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("retries failed dialect metadata reads on a later refresh without reconnecting", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockRejectedValueOnce(new Error("IPC unavailable")).mockResolvedValue("`");

    await store.refreshConnectedConnections();
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();

    await store.refreshConnectedConnections();
    expect(store.connectedIds.has("A")).toBe(true);
    expect(quoteTableDataIdentifier("opengauss", "order", store.connectionIdentifierQuote("A"))).toBe("`order`");
    expect(connectionIdentifierQuote).toHaveBeenCalledTimes(2);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("keeps a non-default live pool selectable and initializes the configured dialect only on use", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss", database: "default_db" }];
    // The backend still owns A:other_db; it must not borrow that database's quote.
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockRejectedValueOnce(new Error("Connection pool is not open: A")).mockResolvedValue("`");
    connectDb.mockResolvedValue("A");

    await store.refreshConnectedConnections();
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
    expect(connectDb).not.toHaveBeenCalled();

    await store.ensureConnected("A", { verifyHealth: false });
    expect(connectDb).toHaveBeenCalledOnce();
    expect(connectDb.mock.calls[0][0]).toMatchObject({ id: "A", database: "default_db" });
    expect(connectionIdentifierQuote.mock.calls).toEqual([["A", undefined, { existingOnly: true }], ["A"]]);
    expect(store.connectedIds.has("A")).toBe(true);
    expect(quoteTableDataIdentifier("opengauss", "order", store.connectionIdentifierQuote("A"))).toBe("`order`");
  });

  it.each(["offline", "closed snapshot", "config edit", "removed config", "explicit close"] as const)("removes an observed connection after %s", async (change) => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockRejectedValue(new Error("Connection pool is not open: A"));
    await store.refreshConnectedConnections();
    expect(store.establishedConnectionIds.has("A")).toBe(true);

    if (change === "offline") store.markConnectionOffline("A");
    else if (change === "closed snapshot") {
      connectionIsOpen.mockResolvedValue(false);
      await store.refreshConnectedConnections();
    } else if (change === "config edit") store.connections = [{ ...store.connections[0], host: "different-host" }];
    else if (change === "removed config") store.connections = [];
    else await store.disconnect("A", { skipTabHandling: true });

    expect(store.establishedConnectionIds.has("A")).toBe(false);
    expect(store.connectedIds.has("A")).toBe(false);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not revive an observed connection when dialect metadata arrives after an offline notification", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    const metadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValue(metadata.promise);
    const pending = store.refreshConnectedConnections();
    await vi.waitFor(() => expect(store.establishedConnectionIds.has("A")).toBe(true));

    store.markConnectionOffline("A");
    metadata.resolve("`");
    await pending;
    expect(store.establishedConnectionIds.has("A")).toBe(false);
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
  });

  it.each(["lost", "resync", "idle closed"] as const)("handles %s while an observed connection is still waiting for its dialect", async (event) => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValueOnce(true).mockResolvedValue(false);
    const metadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValue(metadata.promise);
    const pending = store.refreshConnectedConnections();
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledOnce());
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(store.connectedIds.has("A")).toBe(false);

    if (event === "idle closed") await store.handleConnectionIdleClosed({ connectionId: "A", closedAtMs: Date.now() });
    else await store.handleConnectionLivenessMessage(event === "lost" ? { kind: "lost", connectionId: "A" } : { kind: "resync" });
    expect(store.establishedConnectionIds.has("A")).toBe(false);
    metadata.resolve("`");
    await pending;
    expect(store.establishedConnectionIds.has("A")).toBe(false);
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not close an observed live pool when a delayed idle-close event arrives", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockRejectedValue(new Error("Connection pool is not open: A"));
    await store.refreshConnectedConnections();
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(store.connectedIds.has("A")).toBe(false);

    await store.handleConnectionIdleClosed({ connectionId: "A", closedAtMs: Date.now() - 1000 });
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(connectDb).not.toHaveBeenCalled();
    const api = await import("@/lib/backend/api");
    expect(api.disconnectDb).not.toHaveBeenCalled();
  });

  it("keeps a lost plugin offline and admits it again after the backend confirms a real reconnection", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "plugin", plugin_id: "ssh", plugin_connection_provider: "ssh" }];
    store.markConnectionConnected("A");
    const oldStatus = deferred<boolean>();
    connectionIsOpen.mockReturnValueOnce(oldStatus.promise).mockResolvedValue(false);
    const oldRefresh = store.refreshConnectedConnections();
    store.markConnectionOffline("A");
    const disconnectedRefresh = store.refreshConnectedConnections();
    oldStatus.resolve(true);
    await Promise.all([oldRefresh, disconnectedRefresh]);
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.establishedConnectionIds.has("A")).toBe(false);

    connectionIsOpen.mockResolvedValue(true);
    await store.refreshConnectedConnections();
    expect(store.connectedIds.has("A")).toBe(true);
    expect(store.establishedConnectionIds.has("A")).toBe(true);
    expect(connectionIdentifierQuote).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
  });

  it.each(["config edit", "newer refresh"] as const)("discards delayed dialect metadata after a %s", async (change) => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    const metadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValue(metadata.promise);
    const older = store.refreshConnectedConnections();
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledOnce());

    let newer: Promise<void> | undefined;
    if (change === "config edit") {
      store.connections = [{ ...config("A"), db_type: "opengauss", host: "different-host" }];
    } else {
      connectionIsOpen.mockResolvedValue(false);
      newer = store.refreshConnectedConnections();
    }
    metadata.resolve("`");
    await Promise.all([older, newer]);

    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.establishedConnectionIds.has("A")).toBe(false);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not let an old loss confirmation override a newer open snapshot", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    store.markConnectionConnected("A");
    const oldProbe = deferred<boolean>();
    connectionIsOpen.mockReturnValueOnce(oldProbe.promise).mockResolvedValue(true);

    const oldLoss = store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "A" });
    await store.refreshConnectedConnections();
    oldProbe.resolve(false);
    await oldLoss;

    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not let an old closed snapshot override a newer open liveness confirmation", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    store.markConnectionConnected("A");
    const oldProbe = deferred<boolean>();
    connectionIsOpen.mockReturnValueOnce(oldProbe.promise).mockResolvedValue(true);

    const oldSnapshot = store.refreshConnectedConnections();
    await store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "A" });
    oldProbe.resolve(false);
    await oldSnapshot;

    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not let an old open snapshot undo a newer confirmed loss", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    store.markConnectionConnected("A");
    const oldProbe = deferred<boolean>();
    connectionIsOpen.mockReturnValueOnce(oldProbe.promise).mockResolvedValue(false);

    const oldSnapshot = store.refreshConnectedConnections();
    await store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "A" });
    oldProbe.resolve(true);
    await oldSnapshot;

    expect(store.connectedIds.has("A")).toBe(false);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not adopt a status for a connection edited while the query was in flight", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    let finish!: (open: boolean) => void;
    connectionIsOpen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.refreshConnectedConnections();
    store.connections = [{ ...config("A"), host: "different-host" }];
    finish(true);
    await pending;
    expect([...store.connectedIds]).toEqual([]);
  });

  it("skips connections with an active local connection attempt", async () => {
    const store = await storeFixture();
    store.connections = [config("A")];
    store.connectingIds.add("A");
    connectionIsOpen.mockResolvedValue(false);
    store.connectedIds.add("A");
    await store.refreshConnectedConnections();
    expect([...store.connectedIds]).toEqual(["A"]);
  });

  it("retires the old dialect and metadata when another window changes the default database and reconnects", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss", database: "mysql_mode_db" }, config("B")];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockResolvedValue("`");
    await store.refreshConnectedConnections();
    const generation = store.metadataGenerationFor("A");
    const otherGeneration = store.metadataGenerationFor("B");
    store.treeNodes = [{ id: "A", label: "A", type: "connection", connectionId: "A", isExpanded: true, children: [{ id: "A:mysql_mode_db", label: "mysql_mode_db", type: "database", connectionId: "A", database: "mysql_mode_db", compatibilityMode: "B" }] }];
    expect(store.databaseCompatibilityMode("A", "mysql_mode_db")).toBe("B");

    loadConnections.mockResolvedValue([{ ...store.getConfig("A"), database: "postgres_mode_db" }, config("B")]);
    const metadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValue(metadata.promise);
    const reloaded = store.refreshConnectedConnections({ reload: true });
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledTimes(2));
    expect(store.getConfig("A")?.database).toBe("postgres_mode_db");
    expect(store.connectedIds.has("A")).toBe(false);
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
    expect(store.databaseCompatibilityMode("A", "mysql_mode_db")).toBeUndefined();
    expect(store.metadataGenerationFor("A")).toBeGreaterThan(generation);
    expect(store.metadataGenerationFor("B")).toBe(otherGeneration);

    metadata.resolve('"');
    await reloaded;
    await store.ensureConnected("A", { verifyHealth: false });
    expect(store.connectionIdentifierQuote("A")).toBe('"');
    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectDb).not.toHaveBeenCalled();
    expect(saveConnections).not.toHaveBeenCalled();
    const api = await import("@/lib/backend/api");
    expect(api.disconnectDb).not.toHaveBeenCalled();
  });

  it("keeps a ready dialect and cached metadata across display-only reloads", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockResolvedValue("`");
    await store.refreshConnectedConnections();
    const generation = store.metadataGenerationFor("A");
    loadConnections.mockResolvedValue([{ ...store.getConfig("A"), note: "Updated description", show_user_admin: false }]);

    await store.refreshConnectedConnections({ reload: true });

    expect(store.getConfig("A")?.note).toBe("Updated description");
    expect(store.connectedIds.has("A")).toBe(true);
    expect(store.connectionIdentifierQuote("A")).toBe("`");
    expect(store.metadataGenerationFor("A")).toBe(generation);
    expect(connectionIdentifierQuote).toHaveBeenCalledOnce();
  });

  it("preserves a newer local edit while an external configuration reload is pending", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss", database: "original" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockResolvedValue("`");
    await store.refreshConnectedConnections();
    const generation = store.metadataGenerationFor("A");
    const saved = deferred<ConnectionConfig[]>();
    loadConnections.mockReturnValue(saved.promise);
    const reloaded = store.refreshConnectedConnections({ reload: true });
    await vi.waitFor(() => expect(loadConnections).toHaveBeenCalledOnce());
    store.connections = [{ ...store.connections[0], database: "newer_local" }];
    saved.resolve([{ ...config("A"), db_type: "opengauss", database: "older_external" }]);
    await reloaded;

    expect(store.getConfig("A")?.database).toBe("newer_local");
    expect(store.connectionIdentifierQuote("A")).toBe("`");
    expect(store.connectedIds.has("A")).toBe(true);
    expect(store.metadataGenerationFor("A")).toBe(generation);
    expect(connectionIdentifierQuote).toHaveBeenCalledOnce();
  });

  it("discards dialect metadata from a configuration superseded by a newer reload", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss", database: "original" }];
    connectionIsOpen.mockResolvedValue(true);
    connectionIdentifierQuote.mockResolvedValue("`");
    await store.refreshConnectedConnections();
    loadConnections.mockResolvedValueOnce([{ ...store.getConfig("A"), database: "intermediate" }]).mockResolvedValue([{ ...store.getConfig("A"), database: "newest" }]);
    const oldMetadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValueOnce(oldMetadata.promise).mockResolvedValue('"');
    const oldReload = store.refreshConnectedConnections({ reload: true });
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledTimes(2));
    const newReload = store.refreshConnectedConnections({ reload: true });
    oldMetadata.resolve("`");
    await Promise.all([oldReload, newReload]);

    expect(store.getConfig("A")?.database).toBe("newest");
    expect(store.connectionIdentifierQuote("A")).toBe('"');
    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not restore an old local dialect request after an external configuration change", async () => {
    const store = await storeFixture();
    store.connections = [{ ...config("A"), db_type: "opengauss", database: "original" }];
    connectDb.mockResolvedValue("A");
    const oldMetadata = deferred<string>();
    connectionIdentifierQuote.mockReturnValueOnce(oldMetadata.promise).mockResolvedValue('"');
    const localConnect = store.ensureConnected("A");
    await vi.waitFor(() => expect(connectionIdentifierQuote).toHaveBeenCalledOnce());

    loadConnections.mockResolvedValue([{ ...store.getConfig("A"), database: "new_default" }]);
    connectionIsOpen.mockResolvedValue(true);
    await store.refreshConnectedConnections({ reload: true });
    oldMetadata.resolve("`");
    await localConnect;
    expect(store.connectionIdentifierQuote("A")).toBeUndefined();
    expect(store.connectedIds.has("A")).toBe(false);

    await store.refreshConnectedConnections();
    expect(store.connectionIdentifierQuote("A")).toBe('"');
    expect(store.connectedIds.has("A")).toBe(true);
    expect(connectDb).toHaveBeenCalledOnce();
  });

  it("preserves persisted timeouts without writes when windows have different cached global settings", async () => {
    const saved = { ...config("A"), connect_timeout_inherit: true, connect_timeout_secs: 20, query_timeout_inherit: true, query_timeout_secs: 120 };
    loadConnections.mockImplementation(async () => [structuredClone(saved)]);
    connectionIsOpen.mockResolvedValue(true);
    saveConnections.mockResolvedValue(undefined);
    saveEditorSettings.mockResolvedValue(undefined);
    const firstSettings = useSettingsStore();
    firstSettings.isEditorSettingsLoaded = true;
    firstSettings.editorSettings.globalConnectTimeoutSecs = 10;
    firstSettings.editorSettings.globalQueryTimeoutSecs = 60;
    const firstStore = useConnectionStore();
    const secondPinia = createPinia();
    try {
      setActivePinia(secondPinia);
      const secondSettings = useSettingsStore();
      secondSettings.isEditorSettingsLoaded = true;
      secondSettings.editorSettings.globalConnectTimeoutSecs = 30;
      secondSettings.editorSettings.globalQueryTimeoutSecs = 300;
      const secondStore = useConnectionStore();
      await firstStore.refreshConnectedConnections({ reload: true });
      await secondStore.refreshConnectedConnections({ reload: true });
      for (const store of [firstStore, secondStore]) {
        expect(store.getConfig("A")).toMatchObject({ connect_timeout_secs: 20, query_timeout_secs: 120 });
        expect([...store.connectedIds]).toEqual(["A"]);
      }
      expect(saveConnections).not.toHaveBeenCalled();
      expect(saveEditorSettings).not.toHaveBeenCalled();
      expect(loadConnections).toHaveBeenCalledWith(undefined);
    } finally {
      disposePinia(secondPinia);
    }
  });
});
