import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function mysqlConnection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
  } as ConnectionConfig;
}

const connectDb = vi.fn();

describe("connectionStore auto-connect after create", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    connectDb.mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      listDatabases: vi.fn().mockResolvedValue([]),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      checkConnectionHealth: vi.fn().mockResolvedValue(true),
    }));
    setActivePinia(createPinia());
  });

  async function stores() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    return { connectionStore: useConnectionStore(), settingsStore: useSettingsStore() };
  }

  it("connects a duplicated connection in all mode", async () => {
    const { connectionStore, settingsStore } = await stores();
    settingsStore.editorSettings.autoConnectAfterCreateMode = "all";
    await connectionStore.addConnection(mysqlConnection("copy-1"), undefined, { autoConnect: true });
    await vi.waitFor(() => expect(connectDb).toHaveBeenCalledTimes(1));
  });

  it("does not connect when the setting is off", async () => {
    const { connectionStore, settingsStore } = await stores();
    settingsStore.editorSettings.autoConnectAfterCreateMode = "off";
    await connectionStore.addConnection(mysqlConnection("copy-2"), undefined, { autoConnect: true });
    expect(connectDb).not.toHaveBeenCalled();
  });

  it("does not connect creation paths that did not opt in (dialog save, file open, import)", async () => {
    const { connectionStore, settingsStore } = await stores();
    settingsStore.editorSettings.autoConnectAfterCreateMode = "all";
    await connectionStore.addConnection(mysqlConnection("dialog-1"));
    await connectionStore.addConnection(mysqlConnection("import-1"), undefined, { autoConnect: false });
    expect(connectDb).not.toHaveBeenCalled();
  });
});
