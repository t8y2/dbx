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
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
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
    vi.restoreAllMocks();
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
    requestPassword.mockResolvedValue("typed-pw");
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
});
