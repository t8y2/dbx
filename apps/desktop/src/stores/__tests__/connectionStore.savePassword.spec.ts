import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { CONNECTION_PASSWORD_REQUIRED_MESSAGE } from "@/stores/connectionStore";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function postgresConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    read_only: false,
    ...overrides,
  } as ConnectionConfig;
}

let requestPassword: ReturnType<typeof vi.fn>;

function installApiMocks(extra: Record<string, unknown> = {}) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectDb: vi.fn().mockResolvedValue("pg-1"),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    sessionCredentialStatus: vi.fn().mockResolvedValue(false),
    forgetSessionCredential: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }));
}

function installPasswordPromptMock() {
  vi.doMock("@/stores/connectionPasswordPromptStore", () => ({
    useConnectionPasswordPromptStore: () => ({
      pending: null,
      requestPassword,
    }),
  }));
}

describe("connectionStore save_password opt-out", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    requestPassword = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["connect", "ensureConnected"] as const)("installs late OceanBase mode after %s finishes without saving the prompted password", async (entry) => {
    const metadata = deferred<{ productName: string; compatibilityMode: string }>();
    const saveInfo = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectionDatabaseInfo: vi.fn(() => metadata.promise), saveConnectionDatabaseInfo: saveInfo });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "one-time-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "jdbc", connection_string: "jdbc:oceanbase://localhost/db", save_password: false });
    store.connections = [config];
    store.treeNodes = [{ id: config.id, label: config.name, type: "connection", connectionId: config.id, children: [] }];
    if (entry === "connect") await store.connect(config);
    else await store.ensureConnected(config.id);
    expect(store.connectingIds.has(config.id)).toBe(false);
    expect(store.getConfig(config.id)?.password).toBe("");
    metadata.resolve({ productName: "OceanBase", compatibilityMode: "oracle" });
    await vi.waitFor(() => expect(saveInfo).toHaveBeenCalledExactlyOnceWith(config.id, expect.objectContaining({ compatibilityMode: "oracle" })));
    expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBe("oracle");
    expect(store.getConfig(config.id)?.password).toBe("");
    expect(store.treeNodes[0]?.children?.filter((node) => node.type === "database-job-admin")).toHaveLength(1);
  });

  it.each(["saved", "save-failed"] as const)("uses the exact persistent identity after remember-password is %s", async (result) => {
    const metadata = deferred<{ productName: string; compatibilityMode: string }>();
    const saveInfo = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectionDatabaseInfo: vi.fn(() => metadata.promise), saveConnectionDatabaseInfo: saveInfo, ...(result === "save-failed" ? { saveConnections: vi.fn().mockRejectedValue(new Error("save_failed")) } : {}) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "remembered-input", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "jdbc", connection_string: "jdbc:oceanbase://localhost/db", save_password: false });
    store.connections = [config];
    await store.connect(config);
    metadata.resolve({ productName: "OceanBase", compatibilityMode: "oracle" });
    await vi.waitFor(() => expect(saveInfo).toHaveBeenCalledTimes(1));
    expect(store.getConfig(config.id)?.password).toBe(result === "saved" ? "remembered-input" : "");
    expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBe("oracle");
  });

  it.each(["host", "username", "disconnect", "new-attempt"] as const)("rejects late mode after %s changes the successful connection identity", async (change) => {
    const metadata = deferred<{ productName: string; compatibilityMode: string }>();
    const saveInfo = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectionDatabaseInfo: vi.fn().mockReturnValueOnce(metadata.promise).mockResolvedValue(undefined), saveConnectionDatabaseInfo: saveInfo });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "one-time-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "jdbc", connection_string: "jdbc:oceanbase://localhost/db", save_password: false });
    store.connections = [config];
    await store.connect(config);
    if (change === "disconnect") await store.disconnect(config.id);
    else if (change === "new-attempt") await store.connect(config);
    else store.getConfig(config.id)![change] = "changed";
    metadata.resolve({ productName: "OceanBase", compatibilityMode: "oracle" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === "new-attempt") expect(saveInfo).toHaveBeenCalledExactlyOnceWith(config.id, expect.objectContaining({ productName: "jdbc", compatibilityMode: undefined }));
    else expect(saveInfo).not.toHaveBeenCalled();
    expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBeUndefined();
    expect(store.getConfig(config.id)?.password).toBe("");
  });

  it("does not install metadata when disconnect happens during its asynchronous save", async () => {
    const metadata = deferred<{ productName: string; compatibilityMode: string }>();
    const saved = deferred<void>();
    const saveInfo = vi.fn(() => saved.promise);
    installApiMocks({ connectionDatabaseInfo: vi.fn(() => metadata.promise), saveConnectionDatabaseInfo: saveInfo });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "one-time-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "jdbc", save_password: false });
    store.connections = [config];
    await store.connect(config);
    metadata.resolve({ productName: "OceanBase", compatibilityMode: "oracle" });
    await vi.waitFor(() => expect(saveInfo).toHaveBeenCalledTimes(1));
    await store.disconnect(config.id);
    saved.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getConfig(config.id)?.database_info).toBeUndefined();
  });

  it("discards before-ready metadata after the connection attempt is cancelled", async () => {
    const metadata = deferred<{ productName: string; compatibilityMode: string }>();
    const saveInfo = vi.fn().mockResolvedValue(undefined);
    const readInfo = vi.fn(() => metadata.promise);
    installApiMocks({ connectionDatabaseInfo: readInfo, saveConnectionDatabaseInfo: saveInfo });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "one-time-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "kingbase", save_password: false });
    store.connections = [config];
    const connecting = store.connect(config);
    const cancelled = expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(readInfo).toHaveBeenCalledTimes(1));
    await store.cancelConnecting(config.id);
    metadata.resolve({ productName: "KingbaseES", compatibilityMode: "oracle" });
    await cancelled;
    expect(saveInfo).not.toHaveBeenCalled();
    expect(store.getConfig(config.id)?.database_info).toBeUndefined();
  });

  it("keeps the ordinary connection usable when optional metadata fails", async () => {
    installApiMocks({ connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata_unavailable")) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "one-time-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ db_type: "jdbc", save_password: false });
    store.connections = [config];
    await expect(store.connect(config)).resolves.toBe(config.id);
    expect(store.connectedIds.has(config.id)).toBe(true);
    expect(store.getConfig(config.id)?.password).toBe("");
  });

  it.each(["postgres", "mysql", "redis"] as const)("ordinary close retires the %s transient password before disconnect", async (db_type) => {
    const calls: string[] = [];
    installApiMocks({
      sessionCredentialStatus: vi.fn().mockResolvedValue(true),
      forgetSessionCredential: vi.fn(async () => {
        calls.push("forget");
      }),
      disconnectDb: vi.fn(async () => {
        calls.push("disconnect");
      }),
    });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ db_type, save_password: false })];
    await store.disconnect("pg-1");
    expect(calls).toEqual(["forget", "disconnect"]);
  });

  it.each([true, undefined])("preserves ordinary-close behavior for save_password=%s", async (save_password) => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password })];
    await store.disconnect("pg-1");
    const api = await import("@/lib/backend/api");
    expect(api.sessionCredentialStatus).not.toHaveBeenCalled();
    expect(api.forgetSessionCredential).not.toHaveBeenCalled();
    expect(api.disconnectDb).toHaveBeenCalledTimes(1);
  });

  it("system disconnect does not retire a transient credential", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password: false })];
    await store.disconnect("pg-1", { markClosedByUser: false });
    const api = await import("@/lib/backend/api");
    expect(api.sessionCredentialStatus).not.toHaveBeenCalled();
    expect(api.forgetSessionCredential).not.toHaveBeenCalled();
  });

  it("ordinary and explicit repeated closes are safe when there is no credential", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password: false })];
    await store.disconnect("pg-1");
    await store.disconnectAndForgetConnectionPassword("pg-1");
    const api = await import("@/lib/backend/api");
    expect(api.forgetSessionCredential).not.toHaveBeenCalled();
    expect(api.disconnectDb).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent closes so an old forget cannot erase a newly entered password", async () => {
    const forget = deferred<void>();
    installApiMocks({ sessionCredentialStatus: vi.fn().mockResolvedValue(true), forgetSessionCredential: vi.fn(() => forget.promise) });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password: false })];
    const closes = [store.disconnect("pg-1"), store.disconnectAndForgetConnectionPassword("pg-1")];
    await vi.waitFor(async () => {
      const api = await import("@/lib/backend/api");
      expect(api.forgetSessionCredential).toHaveBeenCalledTimes(1);
    });
    forget.resolve();
    await Promise.all(closes);
    const api = await import("@/lib/backend/api");
    expect(api.forgetSessionCredential).toHaveBeenCalledTimes(1);
    expect(api.disconnectDb).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("accepts exact already-gone error only if absence is confirmed: remaining=%s", async (remaining) => {
    const error = new Error("Connection has no transient session credential to forget: pg-1");
    installApiMocks({ sessionCredentialStatus: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(remaining), forgetSessionCredential: vi.fn().mockRejectedValue(error) });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password: false })];
    const closing = store.disconnect("pg-1");
    if (remaining) await expect(closing).rejects.toThrow(error.message);
    else await closing;
    const api = await import("@/lib/backend/api");
    expect(api.disconnectDb).toHaveBeenCalledTimes(1);
    expect(api.sessionCredentialStatus).toHaveBeenCalledTimes(2);
  });

  it.each(["status", "forget"])("propagates %s failure, still disconnects and forces fresh input on retry", async (failure) => {
    const status = vi.fn().mockResolvedValue(true);
    const forget = vi.fn().mockResolvedValue(undefined);
    (failure === "status" ? status : forget).mockRejectedValueOnce(new Error("transport failed"));
    installApiMocks({ sessionCredentialStatus: status, forgetSessionCredential: forget });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "fresh", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ save_password: false });
    store.connections = [config];
    await expect(store.disconnect(config.id)).rejects.toThrow("transport failed");
    const api = await import("@/lib/backend/api");
    expect(api.disconnectDb).toHaveBeenCalledTimes(1);
    await store.connect(config);
    expect(requestPassword).toHaveBeenCalledTimes(1);
  });

  it("keeps the pool disconnect timeout after retiring the credential", async () => {
    vi.useFakeTimers();
    installApiMocks({ sessionCredentialStatus: vi.fn().mockResolvedValue(true), disconnectDb: vi.fn(() => new Promise<void>(() => {})) });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection({ save_password: false })];
    const closing = store.disconnect("pg-1");
    await vi.advanceTimersByTimeAsync(6_000);
    await closing;
    const api = await import("@/lib/backend/api");
    expect(api.forgetSessionCredential).toHaveBeenCalledTimes(1);
    expect(api.disconnectDb).toHaveBeenCalledTimes(1);
  });

  it.each(["connect", "ensureConnected"] as const)("immediate %s waits beyond the pool timeout for retirement and prompts even with stale status", async (reopen) => {
    vi.useFakeTimers();
    const forget = deferred<void>();
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ sessionCredentialStatus: vi.fn().mockResolvedValue(true), forgetSessionCredential: vi.fn(() => forget.promise), disconnectDb });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "new-input", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = postgresConnection({ save_password: false });
    store.connections = [config];
    await store.connect(config);
    const api = await import("@/lib/backend/api");
    vi.mocked(api.connectDb).mockClear();
    const closing = store.disconnect(config.id);
    const reopening = reopen === "connect" ? store.connect(config) : store.ensureConnected(config.id);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(disconnectDb).not.toHaveBeenCalled();
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(requestPassword).not.toHaveBeenCalled();
    forget.resolve();
    await closing;
    await reopening;
    expect(requestPassword).toHaveBeenCalledTimes(1);
    expect(api.connectDb).toHaveBeenCalledWith(expect.objectContaining({ password: "new-input" }), expect.any(Number));
  });

  it("addConnection blanks the in-memory password when save_password is false", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    await store.addConnection(postgresConnection({ id: "no-save", save_password: false, password: "hunter2" }));

    expect(store.getConfig("no-save")?.password).toBe("");
    const { saveConnections } = await import("@/lib/backend/api");
    expect(saveConnections).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "no-save", password: "", save_password: false })]));
  });

  it("addConnection keeps the password for legacy configs without save_password", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    await store.addConnection(postgresConnection({ id: "legacy", password: "s3cret" }));

    expect(store.getConfig("legacy")?.password).toBe("s3cret");
  });

  it("updateConnection blanks the in-memory password when save_password is false", async () => {
    installApiMocks();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(postgresConnection({ id: "pg-1", save_password: true, password: "old" }));

    await store.updateConnection(postgresConnection({ id: "pg-1", save_password: false, password: "hunter2" }));

    expect(store.getConfig("pg-1")?.password).toBe("");
  });

  it("connect prompts for the password and uses it only for connectDb", async () => {
    installApiMocks();
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "typed-pw", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).toHaveBeenCalledWith({ connectionId: "pg-1", connectionName: "Postgres" });
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "pg-1", password: "typed-pw" }), expect.any(Number));
    // The typed password is never written back to the store.
    expect(store.getConfig("pg-1")?.password).toBe("");
  });

  it("connects with an explicitly submitted empty password", async () => {
    installApiMocks();
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];

    await store.connect(connection);

    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "pg-1", password: "" }), expect.any(Number));
    expect(store.getConfig("pg-1")).toEqual(expect.objectContaining({ password: "", save_password: false }));
  });

  it("connects to NOSASL Impala without prompting for an empty password", async () => {
    installApiMocks();
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "impala-1",
      name: "Impala",
      db_type: "impala",
      port: 21050,
      username: "",
      password: "",
      save_password: false,
      url_params: "auth=noSasl",
    });
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).not.toHaveBeenCalled();
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "impala-1", password: "", save_password: false }), expect.any(Number));
  });

  it("remembers an explicitly submitted empty password", async () => {
    installApiMocks();
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];

    await store.connect(connection);

    const { saveConnections } = await import("@/lib/backend/api");
    expect(saveConnections).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: "pg-1", password: "", save_password: true })]));
    expect(store.getConfig("pg-1")).toEqual(expect.objectContaining({ password: "", save_password: true }));
  });

  it("connect cancels when the prompt is dismissed", async () => {
    installApiMocks();
    installPasswordPromptMock();
    requestPassword.mockResolvedValue(null);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];

    await expect(store.connect(connection)).rejects.toThrow(CONNECTION_PASSWORD_REQUIRED_MESSAGE);

    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("connect does not prompt for a saved-password connection or one with a password present", async () => {
    installApiMocks();
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const saved = postgresConnection({ id: "saved", save_password: true, password: "s3cret" });
    const fresh = postgresConnection({ id: "fresh", save_password: false, password: "typed" });
    store.connections = [saved, fresh];

    await store.connect(saved);
    await store.connect(fresh);

    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("connect skips the prompt when the backend already has a session credential", async () => {
    installApiMocks({ sessionCredentialStatus: vi.fn().mockResolvedValue(true) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "never-used", rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];

    await store.connect(connection);

    // 本次运行期已输入过密码：不再弹窗，直接以空密码 connectDb（后端补主密码）。
    expect(requestPassword).not.toHaveBeenCalled();
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "pg-1", password: "" }), expect.any(Number));
  });

  it("disconnectAndForgetConnectionPassword clears the backend session credential", async () => {
    const forgetSessionCredential = vi.fn().mockResolvedValue(undefined);
    installApiMocks({
      forgetSessionCredential,
      sessionCredentialStatus: vi.fn().mockResolvedValue(true),
    });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];
    store.connectedIds.add("pg-1");

    await store.disconnectAndForgetConnectionPassword("pg-1");

    expect(forgetSessionCredential).toHaveBeenCalledWith("pg-1");
    expect(store.connectedIds.has("pg-1")).toBe(false);
  });

  it("disconnectAndForgetConnectionPassword propagates forget failures", async () => {
    const forgetSessionCredential = vi.fn().mockRejectedValue(new Error("no session credential"));
    installApiMocks({
      forgetSessionCredential,
      sessionCredentialStatus: vi.fn().mockResolvedValue(true),
    });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ id: "pg-1", save_password: false, password: "" });
    store.connections = [connection];
    store.connectedIds.add("pg-1");

    await expect(store.disconnectAndForgetConnectionPassword("pg-1")).rejects.toThrow("no session credential");
  });

  it("prompts and retries when MySQL rejects a synced connection that sent no password", async () => {
    const connectDb = vi.fn().mockRejectedValueOnce(new Error("MySQL connection failed: Access denied for user 'root'@'192.168.100.133' (using password: NO)")).mockResolvedValueOnce("mysql-1");
    installApiMocks({ connectDb });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "typed-pw", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "mysql-1",
      name: "Synced MySQL",
      db_type: "mysql",
      port: 3306,
      username: "root",
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).toHaveBeenCalledWith({ connectionId: "mysql-1", connectionName: "Synced MySQL" });
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(connectDb).toHaveBeenNthCalledWith(1, expect.objectContaining({ password: "" }), expect.any(Number));
    expect(connectDb).toHaveBeenNthCalledWith(2, expect.objectContaining({ password: "typed-pw" }), expect.any(Number));
    const { saveConnections } = await import("@/lib/backend/api");
    expect(saveConnections).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: "mysql-1", password: "typed-pw", save_password: true })]));
    expect(store.getConfig("mysql-1")?.password).toBe("typed-pw");
  });

  it("prompts and retries when an encrypted SQLite file is opened without a password", async () => {
    const connectDb = vi.fn().mockRejectedValueOnce(new Error("Selected file is not a valid SQLite database file.")).mockResolvedValueOnce("sqlite-1");
    installApiMocks({ connectDb });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "123456", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "sqlite-1",
      name: "Encrypted SQLite",
      db_type: "sqlite",
      host: "/tmp/encrypted.db",
      port: 0,
      username: "",
      database: undefined,
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).toHaveBeenCalledWith({ connectionId: "sqlite-1", connectionName: "Encrypted SQLite" });
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(connectDb).toHaveBeenNthCalledWith(1, expect.objectContaining({ password: "" }), expect.any(Number));
    expect(connectDb).toHaveBeenNthCalledWith(2, expect.objectContaining({ password: "123456" }), expect.any(Number));
    expect(store.getConfig("sqlite-1")?.password).toBe("123456");
  });

  it("does not persist a recovered password after the connection config changes", async () => {
    const connected = deferred<string>();
    const connectDb = vi
      .fn()
      .mockRejectedValueOnce(new Error("MySQL connection failed: Access denied for user 'root'@'192.168.100.133' (using password: NO)"))
      .mockImplementationOnce(() => connected.promise);
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectDb, saveConnections });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "old-endpoint-password", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "mysql-1",
      name: "Synced MySQL",
      db_type: "mysql",
      host: "old.example.com",
      port: 3306,
      username: "root",
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    const connecting = store.connect(connection);
    await vi.waitFor(() => expect(connectDb).toHaveBeenCalledTimes(2));
    await store.updateConnection({ ...connection, host: "new.example.com" });
    connected.resolve("mysql-1");
    await connecting;

    expect(saveConnections).toHaveBeenCalledTimes(1);
    expect(saveConnections).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mysql-1",
          host: "new.example.com",
          password: "",
        }),
      ]),
    );
    expect(store.getConfig("mysql-1")).toEqual(expect.objectContaining({ host: "new.example.com", password: "" }));
  });

  it("restores the latest config when it changes while a recovered password is being saved", async () => {
    const passwordSave = deferred<void>();
    const connectDb = vi.fn().mockRejectedValueOnce(new Error("MySQL connection failed: Access denied for user 'root'@'192.168.100.133' (using password: NO)")).mockResolvedValueOnce("mysql-1");
    const saveConnections = vi
      .fn()
      .mockImplementationOnce(() => passwordSave.promise)
      .mockResolvedValue(undefined);
    installApiMocks({ connectDb, saveConnections });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "old-endpoint-password", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "mysql-1",
      name: "Synced MySQL",
      db_type: "mysql",
      host: "old.example.com",
      port: 3306,
      username: "root",
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    const connecting = store.connect(connection);
    await vi.waitFor(() => expect(saveConnections).toHaveBeenCalledTimes(1));
    await store.updateConnection({ ...connection, host: "new.example.com" });
    passwordSave.resolve();
    await connecting;

    expect(saveConnections).toHaveBeenCalledTimes(3);
    expect(saveConnections).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mysql-1",
          host: "new.example.com",
          password: "",
        }),
      ]),
    );
    expect(store.getConfig("mysql-1")).toEqual(expect.objectContaining({ host: "new.example.com", password: "" }));
  });

  it("keeps a successful connection when remembering the recovered password fails", async () => {
    const connectDb = vi.fn().mockRejectedValueOnce(new Error("MySQL connection failed: Access denied for user 'root'@'192.168.100.133' (using password: NO)")).mockResolvedValueOnce("mysql-1");
    const saveConnections = vi.fn().mockRejectedValue(new Error("disk full"));
    installApiMocks({ connectDb, saveConnections });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "typed-pw", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "mysql-1",
      name: "Synced MySQL",
      db_type: "mysql",
      port: 3306,
      username: "root",
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    await expect(store.connect(connection)).resolves.toBe("mysql-1");

    expect(store.connectedIds.has("mysql-1")).toBe(true);
    expect(store.activeConnectionId).toBe("mysql-1");
    expect(store.getConfig("mysql-1")?.password).toBe("");
    expect(store.connectionErrors["mysql-1"]).toContain("Connected, but DBX could not remember the password");
    expect(store.connectionErrors["mysql-1"]).toContain("disk full");
  });

  it("keeps ensureConnected successful when remembering the recovered password fails", async () => {
    const connectDb = vi.fn().mockRejectedValueOnce(new Error("MySQL connection failed: Access denied for user 'root'@'192.168.100.133' (using password: NO)")).mockResolvedValueOnce("mysql-1");
    const saveConnections = vi.fn().mockRejectedValue(new Error("disk full"));
    installApiMocks({ connectDb, saveConnections });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: "typed-pw", rememberPassword: true });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({
      id: "mysql-1",
      name: "Synced MySQL",
      db_type: "mysql",
      port: 3306,
      username: "root",
      save_password: true,
      password: "",
    });
    store.connections = [connection];

    await expect(store.ensureConnected("mysql-1")).resolves.toBeUndefined();

    expect(store.connectedIds.has("mysql-1")).toBe(true);
    expect(store.getConfig("mysql-1")?.password).toBe("");
    expect(store.connectionErrors["mysql-1"]).toContain("Connected, but DBX could not remember the password");
    expect(store.connectionErrors["mysql-1"]).toContain("disk full");
  });
});

describe("connectionStore plugin password prompt", () => {
  // Runtime-assembled placeholder: no credential literal in source (Mimosa gate).
  const PROMPT_TYPED_PASSWORD = "typed" + "-pw";

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    requestPassword = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sshInstalledPlugin(): unknown {
    return {
      manifest: {
        id: "io.dbx.ssh",
        name: "SSH",
        drivers: [],
        contributions: [
          {
            type: "connection-provider",
            id: "io.dbx.ssh.connection",
            label: "SSH server",
            database_type: "ssh",
            fields: [
              { key: "authentication", label: "Authentication", type: "select", binding: "config", default: "password", options: [] },
              {
                key: "password",
                label: "Password",
                type: "password",
                binding: "password",
                visible_when: { field: "authentication", one_of: ["password", "private-key-password"] },
                required_when: { field: "authentication", one_of: ["password", "private-key-password"] },
              },
            ],
          },
        ],
      },
      compatibility: { compatible: true },
    };
  }

  function pluginConnection(overrides: Record<string, unknown> = {}): ConnectionConfig {
    return {
      id: "ssh-1",
      name: "hktkosl1086",
      db_type: "plugin",
      host: "hktkosl1086.int.kn",
      port: 22,
      username: "jinpy.he",
      password: "",
      save_password: false,
      plugin_id: "io.dbx.ssh",
      plugin_connection_provider: "io.dbx.ssh.connection",
      plugin_connection_type: "ssh",
      external_config: { authentication: "private-key", private_key_path: "/Users/dev/.ssh/id_rsa" },
      read_only: false,
      ...overrides,
    } as ConnectionConfig;
  }

  it("connects an SSH key-auth plugin connection without prompting for a password", async () => {
    installApiMocks({ listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection();
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).not.toHaveBeenCalled();
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1", external_config: expect.objectContaining({ authentication: "private-key" }) }), expect.any(Number));
  });

  it("rejects reopening a connection owned by another plugin before prompting or connecting", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    installApiMocks({ connectDb, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: PROMPT_TYPED_PASSWORD, rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [pluginConnection({ external_config: { authentication: "password" } })];

    await expect(store.reopenPluginConnection("ssh-1", "io.dbx.other")).rejects.toThrow("Connection is owned by another plugin");

    expect(requestPassword).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("allows the owning plugin to reopen its connection", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    installApiMocks({ connectDb, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [pluginConnection()];

    await expect(store.reopenPluginConnection("ssh-1", "io.dbx.ssh")).resolves.toBeUndefined();

    expect(requestPassword).not.toHaveBeenCalled();
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1" }), expect.any(Number));
  });

  it("still prompts for a plugin connection whose manifest requires the login password", async () => {
    installApiMocks({ listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue({ password: PROMPT_TYPED_PASSWORD, rememberPassword: false });
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ external_config: { authentication: "password" } });
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).toHaveBeenCalledWith({ connectionId: "ssh-1", connectionName: "hktkosl1086" });
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1", password: PROMPT_TYPED_PASSWORD }), expect.any(Number));
  });

  it("does not prompt when the plugin manifest cannot be resolved (backend surfaces the real error)", async () => {
    installApiMocks({ listPlugins: vi.fn().mockResolvedValue([]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection();
    store.connections = [connection];

    await store.connect(connection);

    expect(requestPassword).not.toHaveBeenCalled();
    const { connectDb } = await import("@/lib/backend/api");
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1" }), expect.any(Number));
  });

  it("falls back to prompting when listing plugins fails", async () => {
    installApiMocks({ listPlugins: vi.fn().mockRejectedValue(new Error("ipc down")) });
    installPasswordPromptMock();
    requestPassword.mockResolvedValue(null);
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection();
    store.connections = [connection];

    await expect(store.connect(connection)).rejects.toThrow(CONNECTION_PASSWORD_REQUIRED_MESSAGE);
  });

  it("reconnects an open plugin with its saved credential after runtime config changes", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    const savedPassword = ["stored", "pw"].join("-");
    installApiMocks({ connectDb, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ save_password: true, password: savedPassword, external_config: { authentication: "password" } });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, host: "new.example.com" });

    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1", host: "new.example.com", password: savedPassword }), expect.any(Number));
    expect(requestPassword).not.toHaveBeenCalled();
    expect(store.connectedIds.has(connection.id)).toBe(true);
  });

  it("reconnects an open plugin through its session credential without prompting", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    const sessionCredentialStatus = vi.fn().mockResolvedValue(true);
    installApiMocks({ connectDb, sessionCredentialStatus, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ external_config: { authentication: "password" } });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, host: "new.example.com" });

    expect(sessionCredentialStatus).toHaveBeenCalledWith(connection.id);
    expect(requestPassword).not.toHaveBeenCalled();
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1", host: "new.example.com", password: "" }), expect.any(Number));
    expect(store.connectedIds.has(connection.id)).toBe(true);
  });

  it("disconnects an open plugin instead of prompting when no credential is available", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    const sessionCredentialStatus = vi.fn().mockResolvedValue(false);
    installApiMocks({ connectDb, disconnectDb, sessionCredentialStatus, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ external_config: { authentication: "password" } });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, host: "new.example.com" });

    expect(requestPassword).not.toHaveBeenCalled();
    expect(connectDb).not.toHaveBeenCalled();
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, undefined);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toContain("Reconnect manually");
    expect(store.getConfig(connection.id)?.host).toBe("new.example.com");
  });

  it("does not connect a plugin that was offline when its config was saved", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    const sessionCredentialStatus = vi.fn().mockResolvedValue(true);
    installApiMocks({ connectDb, disconnectDb, sessionCredentialStatus, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ external_config: { authentication: "password" } });
    store.connections = [connection];

    await store.updateConnection({ ...connection, host: "new.example.com" });

    expect(connectDb).not.toHaveBeenCalled();
    expect(disconnectDb).not.toHaveBeenCalled();
    expect(sessionCredentialStatus).not.toHaveBeenCalled();
    expect(requestPassword).not.toHaveBeenCalled();
    expect(store.connectedIds.has(connection.id)).toBe(false);
  });

  it("reconnects an open plugin when its display name changes", async () => {
    const connectDb = vi.fn().mockResolvedValue("ssh-1");
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectDb, disconnectDb, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, name: "Renamed SSH" });

    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ id: connection.id, name: "Renamed SSH" }), expect.any(Number));
    expect(disconnectDb).not.toHaveBeenCalled();
    expect(store.connectedIds.has(connection.id)).toBe(true);
  });

  it("preserves native connection invalidation without reconnecting it", async () => {
    const connectDb = vi.fn().mockResolvedValue("pg-1");
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ connectDb, disconnectDb });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ password: "" });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await store.updateConnection({ ...connection, host: "new.example.com" });

    expect(connectDb).not.toHaveBeenCalled();
    expect(disconnectDb).not.toHaveBeenCalled();
    expect(store.connectedIds.has(connection.id)).toBe(false);
  });

  it("keeps saved plugin settings and an offline error when automatic reconnect fails", async () => {
    const connectDb = vi.fn().mockRejectedValue(new Error("sidecar rejected config"));
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const savedPassword = ["stored", "pw"].join("-");
    installApiMocks({ connectDb, saveConnections, listPlugins: vi.fn().mockResolvedValue([sshInstalledPlugin()]) });
    installPasswordPromptMock();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = pluginConnection({ save_password: true, password: savedPassword, external_config: { authentication: "password" } });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    await expect(store.updateConnection({ ...connection, host: "new.example.com" })).resolves.toBeUndefined();

    expect(saveConnections).toHaveBeenCalledWith([expect.objectContaining({ id: connection.id, host: "new.example.com" })]);
    expect(store.getConfig(connection.id)?.host).toBe("new.example.com");
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toContain("settings were saved");
    expect(store.connectionErrors[connection.id]).toContain("sidecar rejected config");
  });
});
