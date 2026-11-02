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

const opengaussConnection: ConnectionConfig = {
  id: "opengauss-mysql",
  name: "openGauss",
  db_type: "opengauss",
  host: "127.0.0.1",
  port: 5432,
  username: "gaussdb",
  password: "",
  database: "postgres",
};

describe("connectionStore openGauss identifier quote", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("loads the compatibility-mode quote reported for native openGauss connections", async () => {
    const connectionIdentifierQuote = vi.fn().mockResolvedValue("`");

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(opengaussConnection.id),
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      connectionIdentifierQuote,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(opengaussConnection);
    await store.connect(opengaussConnection);

    expect(connectionIdentifierQuote).toHaveBeenCalledOnce();
    expect(connectionIdentifierQuote).toHaveBeenCalledWith(opengaussConnection.id);
    expect(store.connectionIdentifierQuote(opengaussConnection.id)).toBe("`");
  }, 30_000);
});
