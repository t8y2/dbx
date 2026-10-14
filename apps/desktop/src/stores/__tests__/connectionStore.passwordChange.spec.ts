import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const api = vi.hoisted(() => ({
  connectDb: vi.fn(),
  disconnectDb: vi.fn(),
  saveConnections: vi.fn(),
  sessionCredentialStatus: vi.fn(),
  forgetSessionCredential: vi.fn(),
  checkConnectionHealth: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
}));
const requestPassword = vi.hoisted(() => vi.fn());
const retainedTabRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", () => ({
  ...api,
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
  listInstalledAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionPasswordPromptStore", () => ({
  useConnectionPasswordPromptStore: () => ({ pending: null, requestPassword }),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    rollbackConnectionTransactions: retainedTabRefresh,
    closeConnectionTabs: retainedTabRefresh,
    releaseConnectionTabs: retainedTabRefresh,
    invalidateConnectionMetadata: vi.fn(),
    tabs: [],
    flushPendingPersist: vi.fn().mockResolvedValue(undefined),
  }),
}));

const config: ConnectionConfig = {
  id: "vastbase-password-fixture",
  name: "Vastbase fixture",
  db_type: "vastbase",
  host: "localhost",
  port: 5432,
  username: "fixture_self",
  password: "fixture-old",
  save_password: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("connectionStore password retirement", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    setActivePinia(createPinia());
    for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue(undefined);
    api.connectDb.mockResolvedValue(config.id);
    api.sessionCredentialStatus.mockResolvedValue(true);
    retainedTabRefresh.mockReset();
    requestPassword.mockReset().mockResolvedValue({ password: "fixture-new", rememberPassword: false });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function storeWithConnection() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-keep-results";
    const store = useConnectionStore();
    store.connections = [{ ...config }, { ...config, id: "other-connection", password: "other-secret" }];
    store.connectedIds.add(config.id);
    return store;
  }

  it("blocks retained-tab reconnects before disconnect and clears only the changed connection", async () => {
    const store = await storeWithConnection();
    let finishDisconnect!: () => void;
    api.disconnectDb.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    const retirement = store.retirePasswordAfterChange(config.id);
    await expect(store.ensureConnected(config.id)).rejects.toThrow();
    await expect(store.connect(config)).rejects.toThrow();
    let retainedTabError: unknown;
    retainedTabRefresh.mockImplementation(() => {
      void store.ensureConnected(config.id).catch((error) => {
        retainedTabError = error;
      });
    });
    await vi.waitFor(() => expect(retainedTabRefresh).toHaveBeenCalled());
    finishDisconnect();
    await retirement;
    expect(retainedTabError).toBeInstanceOf(Error);
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(api.checkConnectionHealth).not.toHaveBeenCalled();
    expect(api.forgetSessionCredential).toHaveBeenCalledWith(config.id);
    expect(api.disconnectDb.mock.invocationCallOrder[0]).toBeLessThan(api.forgetSessionCredential.mock.invocationCallOrder[0]);
    expect(store.getConfig(config.id)).toMatchObject({ password: "", save_password: false });
    expect(store.getConfig("other-connection")?.password).toBe("other-secret");
    expect(api.saveConnections).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: config.id, password: "", save_password: false })]));
    await expect(store.ensureConnected(config.id, { forceReconnect: true })).rejects.toThrow();
  });

  it("requires fresh input for explicit reconnect even if a caller retains the old config", async () => {
    const store = await storeWithConnection();
    await store.retirePasswordAfterChange(config.id);
    await store.connect(config);
    expect(requestPassword).toHaveBeenCalledTimes(1);
    expect(api.connectDb).toHaveBeenCalledWith(expect.objectContaining({ password: "fixture-new", save_password: false }), expect.any(Number));
    expect(store.getConfig(config.id)?.password).toBe("");
    await expect(store.ensureConnected(config.id, { verifyHealth: false })).resolves.toBeUndefined();
  });

  describe.each(["connect", "ensureConnected"] as const)("%s credential persistence", (method) => {
    it.each(["none", "transient", "remembered"] as const)("does not restore a retired password after a delayed save with %s fresh reconnect", async (reconnect) => {
      const store = await storeWithConnection();
      const unsaved = { ...config, password: "", save_password: false };
      store.connections[0] = unsaved;
      store.connectedIds.delete(config.id);
      store.connectedIds.add("other-connection");
      const other = { ...store.getConfig("other-connection")! };
      const oldSave = deferred<void>();
      const oldSaveEntered = deferred<void>();
      let persisted = store.connections.map((connection) => ({ ...connection }));
      api.saveConnections.mockImplementation(async (snapshot: ConnectionConfig[]) => {
        const saved = snapshot.map((connection) => ({ ...connection }));
        if (saved.find((connection) => connection.id === config.id)?.password === config.password) {
          oldSaveEntered.resolve();
          await oldSave.promise;
        }
        persisted = saved;
      });
      api.sessionCredentialStatus.mockResolvedValue(false);
      requestPassword.mockResolvedValueOnce({ password: config.password, rememberPassword: true });

      const connecting = (method === "connect" ? store.connect(unsaved) : store.ensureConnected(config.id)).catch((error: unknown) => error);
      await oldSaveEntered.promise;
      const waiting = method === "ensureConnected" ? store.ensureConnected(config.id, { forceReconnect: true }).catch((error: unknown) => error) : undefined;
      expect(store.connectedIds.has(config.id)).toBe(true);
      await store.retirePasswordAfterChange(config.id);
      expect(store.getConfig(config.id)).toMatchObject({ password: "", save_password: false });
      expect(persisted.find((connection) => connection.id === config.id)).toMatchObject({ password: "", save_password: false });

      if (reconnect !== "none") {
        requestPassword.mockResolvedValueOnce({ password: "fixture-new", rememberPassword: reconnect === "remembered" });
        await store.connect(unsaved);
        expect(api.connectDb).toHaveBeenLastCalledWith(expect.objectContaining({ password: "fixture-new" }), expect.any(Number));
      }
      const current = store.connections.map((connection) => ({ ...connection }));
      const active = store.activeConnectionId;
      const currentError = store.connectionErrors[config.id];
      const disconnectCount = api.disconnectDb.mock.calls.length;
      oldSave.resolve();
      const result = await connecting;
      const waitingResult = await waiting;

      expect.soft(store.connections).toEqual(current);
      expect.soft(persisted).toEqual(current);
      expect(api.saveConnections).toHaveBeenCalledTimes(reconnect === "remembered" ? 4 : 3);
      expect(store.connectedIds.has(config.id)).toBe(reconnect !== "none");
      expect(store.activeConnectionId).toBe(active);
      expect(store.connectionErrors[config.id]).toBe(currentError);
      expect(api.disconnectDb).toHaveBeenCalledTimes(disconnectCount);
      expect(store.getConfig("other-connection")).toEqual(other);
      expect(store.connectedIds.has("other-connection")).toBe(true);
      expect(persisted.find((connection) => connection.id === "other-connection")).toEqual(other);
      expect(result).toBeInstanceOf(Error);
      if (waiting) expect(waitingResult).toBeInstanceOf(Error);
      if (reconnect === "none") await expect(store.ensureConnected(config.id)).rejects.toThrow();
      else await expect(store.ensureConnected(config.id, { verifyHealth: false })).resolves.toBeUndefined();
    });

    it.each([false, true])("does not save a retired password after metadata resumes (fresh reconnect: %s)", async (reconnect) => {
      const store = await storeWithConnection();
      const unsaved = { ...config, db_type: "gaussdb" as const, password: "", save_password: false };
      store.connections[0] = unsaved;
      store.connectedIds.delete(config.id);
      const metadata = deferred<string>();
      const metadataEntered = deferred<void>();
      api.connectionIdentifierQuote.mockImplementationOnce(() => {
        metadataEntered.resolve();
        return metadata.promise;
      });
      api.sessionCredentialStatus.mockResolvedValue(false);
      requestPassword.mockResolvedValueOnce({ password: config.password, rememberPassword: true });

      const connecting = (method === "connect" ? store.connect(unsaved) : store.ensureConnected(config.id)).catch((error: unknown) => error);
      await metadataEntered.promise;
      expect(store.connectedIds.has(config.id)).toBe(true);
      expect(api.saveConnections).not.toHaveBeenCalled();
      await store.retirePasswordAfterChange(config.id);
      if (reconnect) await store.connect(unsaved);
      const current = store.connections.map((connection) => ({ ...connection }));
      const active = store.activeConnectionId;
      const currentError = store.connectionErrors[config.id];
      metadata.resolve('"');
      const result = await connecting;

      expect(store.connections).toEqual(current);
      expect(api.saveConnections).toHaveBeenCalledTimes(1);
      expect(api.saveConnections).toHaveBeenLastCalledWith(current);
      expect(store.connectedIds.has(config.id)).toBe(reconnect);
      expect(store.activeConnectionId).toBe(active);
      expect(store.connectionErrors[config.id]).toBe(currentError);
      expect(api.disconnectDb).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(Error);
    });
  });

  it.each(["connect", "ensureConnected"] as const)("cancels %s already waiting on a previous disconnect", async (method) => {
    const store = await storeWithConnection();
    let finishDisconnect!: () => void;
    api.disconnectDb.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    const disconnect = store.disconnect(config.id);
    const pendingConnect = (method === "connect" ? store.connect(config) : store.ensureConnected(config.id)).catch((error: unknown) => error);
    const retirement = store.retirePasswordAfterChange(config.id);
    finishDisconnect();
    await Promise.all([disconnect, retirement]);
    expect(await pendingConnect).toBeInstanceOf(Error);
    expect(api.connectDb).not.toHaveBeenCalled();
  });

  it("keeps automatic reconnect blocked when fresh input is cancelled or rejected", async () => {
    const store = await storeWithConnection();
    await store.retirePasswordAfterChange(config.id);
    requestPassword.mockResolvedValueOnce(null);
    await expect(store.connect(config)).rejects.toThrow();
    expect(api.connectDb).not.toHaveBeenCalled();
    api.connectDb.mockRejectedValueOnce(new Error("server rejected new password"));
    await expect(store.connect(config)).rejects.toThrow("server rejected new password");
    await expect(store.ensureConnected(config.id)).rejects.toThrow();
    expect(store.getConfig(config.id)?.password).toBe("");
  });

  it.each(["saveConnections", "disconnectDb", "sessionCredentialStatus", "forgetSessionCredential"] as const)("stays blocked if %s fails after the server changed the password", async (method) => {
    const store = await storeWithConnection();
    api[method].mockRejectedValueOnce(new Error("fixture cleanup failure"));
    await expect(store.retirePasswordAfterChange(config.id)).rejects.toThrow();
    await expect(store.ensureConnected(config.id)).rejects.toThrow();
    await expect(store.connect(config)).rejects.toThrow();
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(store.getConfig(config.id)?.password).toBe("");
  });

  it("does not forget a nonexistent transient password for a saved-password connection", async () => {
    const store = await storeWithConnection();
    api.sessionCredentialStatus.mockResolvedValue(false);
    await store.retirePasswordAfterChange(config.id);
    expect(api.forgetSessionCredential).not.toHaveBeenCalled();
    expect(store.connectedIds.has(config.id)).toBe(false);
  });
});
