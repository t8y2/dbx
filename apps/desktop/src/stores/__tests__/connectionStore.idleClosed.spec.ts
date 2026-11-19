import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

const toast = vi.hoisted(() => vi.fn());
const disconnectDb = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const closeConnectionTabs = vi.hoisted(() => vi.fn());
const releaseConnectionTabs = vi.hoisted(() => vi.fn());
const rollbackConnectionTransactions = vi.hoisted(() => vi.fn());
const flushPendingPersist = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function connection(): ConnectionConfig {
  return {
    id: "c1",
    name: "IdleDB",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    idle_disconnect_secs: 120,
  } as ConnectionConfig;
}

/**
 * 后端「空闲自动断开」事件（issue #12112）。
 *
 * 后端在连接池因空闲被关闭时发送 `dbx:connection-idle-closed`。这属于系统触发的断开，前端
 * 必须把连接标记为未连接、但保留已打开的查询页签与结果（复用 `disconnect` 的
 * `skipTabHandling` 路径），且不写「用户已关闭」标记（`markClosedByUser: false`），以便用户
 * 下次操作时按既有 `ensureConnected` 机制自动重连。
 */
describe("connectionStore idle auto-disconnect", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
    toast.mockReset();
    disconnectDb.mockReset().mockResolvedValue(undefined);
    closeConnectionTabs.mockReset();
    releaseConnectionTabs.mockReset();
    rollbackConnectionTransactions.mockReset();
    flushPendingPersist.mockReset().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    // 页签策略故意设为 close-tabs：若 skipTabHandling 生效，下面的关闭/清理函数都不应被调用。
    vi.doMock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { disconnectTabHandlingMode: "close-tabs" } }) }));
    vi.doMock("@/stores/queryStore", () => ({
      useQueryStore: () => ({ closeConnectionTabs, releaseConnectionTabs, rollbackConnectionTransactions, flushPendingPersist }),
    }));
    // 直接替换 toast 实现，避免测试环境（node）缺少 window.setTimeout。
    vi.doMock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));
    vi.doMock("@/lib/backend/api", () => ({
      disconnectDb,
      connectionIsOpen: vi.fn().mockResolvedValue(false),
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
  });

  async function loadStore() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = connection();
    store.connections = [config];
    store.markConnectionConnected(config.id);
    return store;
  }

  it("marks the connection offline while keeping its query tabs and results", async () => {
    const store = await loadStore();

    await store.handleConnectionIdleClosed({ connectionId: "c1" });

    expect(store.connectedIds.has("c1")).toBe(false);
    // skipTabHandling：即使页签策略是 close-tabs，也绝不能关闭/释放该连接的页签。
    expect(closeConnectionTabs).not.toHaveBeenCalled();
    expect(releaseConnectionTabs).not.toHaveBeenCalled();
    expect(rollbackConnectionTransactions).not.toHaveBeenCalled();
    expect(disconnectDb).toHaveBeenCalledWith("c1", undefined);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and never re-notifies for an already-offline connection", async () => {
    const store = await loadStore();

    await store.handleConnectionIdleClosed({ connectionId: "c1" });
    await store.handleConnectionIdleClosed({ connectionId: "c1" });

    expect(disconnectDb).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("ignores an event with a missing connectionId without touching the backend", async () => {
    const store = await loadStore();

    await store.handleConnectionIdleClosed({ connectionId: "" });
    await store.handleConnectionIdleClosed(undefined as unknown as { connectionId: string });

    expect(disconnectDb).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(store.connectedIds.has("c1")).toBe(true);
  });

  it("ignores an event for a connection this frontend never showed as connected", async () => {
    const store = await loadStore();

    await store.handleConnectionIdleClosed({ connectionId: "never-connected" });

    expect(disconnectDb).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("ignores an event for a connection whose config was already removed", async () => {
    const store = await loadStore();
    store.connections = [];

    await store.handleConnectionIdleClosed({ connectionId: "c1" });

    expect(disconnectDb).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(store.connectedIds.has("c1")).toBe(true);
  });

  // 迟到事件：清扫发生在本次会话之前，事件到达时用户已经重连。丢掉这次通知即可，
  // 绝不能把刚建立的新会话一起断掉（否则会连带杀掉新池并弹出误导性提示）。
  it("ignores a late event for a connection that was already reconnected", async () => {
    const store = await loadStore();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    store.markConnectionConnected("c1");
    nowSpy.mockRestore();

    await store.handleConnectionIdleClosed({ connectionId: "c1", closedAtMs: 1_000_000 });

    expect(disconnectDb).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(store.connectedIds.has("c1")).toBe(true);
  });

  // 反之，事件晚于当前会话时就该正常处理——避免上面的守卫把合法事件也吞掉。
  it("still disconnects when the event is newer than the current session", async () => {
    const store = await loadStore();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    store.markConnectionConnected("c1");
    nowSpy.mockRestore();

    await store.handleConnectionIdleClosed({ connectionId: "c1", closedAtMs: 1_500_000 });

    expect(disconnectDb).toHaveBeenCalledWith("c1", undefined);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(store.connectedIds.has("c1")).toBe(false);
  });
});
