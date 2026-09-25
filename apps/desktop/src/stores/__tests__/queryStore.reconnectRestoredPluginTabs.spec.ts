import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";

// Boot-time tab restore replays only tab metadata; the sidecar connection
// registry starts empty after a host restart, so restored plugin tabs need
// the connect lifecycle replayed (see reconnectRestoredPluginTabs).
const ensureConnected = vi.fn(async () => undefined);

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => (id === "conn-sql" ? { id, db_type: "mysql" } : { id, db_type: "plugin" }),
    ensureConnected,
  }),
}));

describe("queryStore reconnectRestoredPluginTabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    setActivePinia(createPinia());
    ensureConnected.mockClear();
    ensureConnected.mockImplementation(async () => undefined);
  });

  it("replays ensureConnected once per distinct plugin connection, active tab first", async () => {
    const queryStore = useQueryStore();
    queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-1", context: { connectionId: "conn-1" } });
    queryStore.openPluginFilesystem("io.dbx.files", "files", { connectionId: "conn-1" });
    // A non-plugin tab must not participate in the replay.
    queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-sql", context: { connectionId: "conn-sql" } });
    const activeTabId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-2", context: { connectionId: "conn-2" } });
    queryStore.activeTabId = activeTabId;

    await queryStore.reconnectRestoredPluginTabs();

    // conn-2 owns the active tab (last open won) so it is replayed first;
    // activate:false keeps boot restore from stealing the active connection.
    expect(ensureConnected.mock.calls.map((call) => call[0])).toEqual(["conn-2", "conn-1"]);
    expect(ensureConnected).toHaveBeenCalledWith("conn-1", { activate: false });
  });

  it("a per-connection failure does not abort the remaining replays", async () => {
    const queryStore = useQueryStore();
    queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-1", context: { connectionId: "conn-1" } });
    queryStore.openPluginWorkbench("io.dbx.ldap", "workbench", { connectionId: "conn-2", context: { connectionId: "conn-2" } });
    ensureConnected.mockImplementation(async (id: string) => {
      if (id === "conn-1") throw new Error("password prompt cancelled");
    });

    await expect(queryStore.reconnectRestoredPluginTabs()).resolves.toBeUndefined();
    expect(ensureConnected).toHaveBeenCalledTimes(2);
  });

  it("no plugin tabs means no replay", async () => {
    const queryStore = useQueryStore();

    await queryStore.reconnectRestoredPluginTabs();

    expect(ensureConnected).not.toHaveBeenCalled();
  });
});
