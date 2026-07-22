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

function sqlServerNativeConnectionWithDisabledEncryption(): ConnectionConfig {
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

  it("does not preinstall the legacy component for historical disabled-encryption configs", async () => {
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
    await store.connect(sqlServerNativeConnectionWithDisabledEncryption());

    expect(installAgent).not.toHaveBeenCalled();
    expect(connectDb).toHaveBeenCalledTimes(1);
  });

  it("reconnects persisted legacy profiles without reinstalling an installed component", async () => {
    const connectDb = vi.fn().mockResolvedValue("sqlserver-1");
    const installAgent = vi.fn().mockResolvedValue(undefined);
    const config = sqlServerNativeConnectionWithDisabledEncryption();
    config.driver_profile = "sqlserver-legacy";
    config.driver_label = "SQL Server legacy compatibility component";

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      installAgent,
      isAgentInstalled: vi.fn().mockResolvedValue(true),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.connect(config);

    expect(installAgent).not.toHaveBeenCalled();
    expect(connectDb).toHaveBeenCalledOnce();
    expect(connectDb).toHaveBeenCalledWith(expect.objectContaining({ driver_profile: "sqlserver-legacy" }), expect.any(Number));
  });

  it("does not install or retry legacy after a TLS error followed by SQL Server 18456", async () => {
    const connectDb = vi.fn().mockRejectedValue(new Error("TLS negotiation failed\nSQL Server error 18456: Login failed"));
    const installAgent = vi.fn().mockResolvedValue(undefined);
    const config = sqlServerNativeConnectionWithDisabledEncryption();

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      installAgent,
      isAgentInstalled: vi.fn().mockResolvedValue(false),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await expect(store.connect(config)).rejects.toThrow("18456");

    expect(connectDb).toHaveBeenCalledOnce();
    expect(installAgent).not.toHaveBeenCalled();
  });
});
