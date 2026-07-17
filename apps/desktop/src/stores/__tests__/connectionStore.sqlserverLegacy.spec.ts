import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function sqlServerLegacyConnection(): ConnectionConfig {
  return {
    id: "sqlserver-1",
    name: "SQL Server",
    db_type: "sqlserver",
    driver_profile: "sqlserver",
    driver_label: "SQL Server",
    host: "127.0.0.1",
    port: 1433,
    username: "sa",
    password: "secret",
    database: "master",
    url_params: "sqlserverEncryption=disabled",
    ssl: false,
    ssh_enabled: false,
    read_only: false,
    one_time: false,
    transport_layers: [],
    agent_java_options: [],
  };
}

describe("connectionStore SQL Server legacy compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("installs the legacy compatibility component before connecting saved legacy configs", async () => {
    const connectDb = vi.fn().mockResolvedValue("sqlserver-1");
    const installAgent = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      installAgent,
      isAgentInstalled: vi.fn().mockResolvedValue(false),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.connect(sqlServerLegacyConnection());

    expect(installAgent).toHaveBeenCalledWith("sqlserver-legacy");
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(installAgent.mock.invocationCallOrder[0]).toBeLessThan(connectDb.mock.invocationCallOrder[0]);
  });
});
