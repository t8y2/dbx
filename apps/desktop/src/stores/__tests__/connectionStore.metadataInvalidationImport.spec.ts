import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("connectionStore metadata lifetime invalidation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockRejectedValue(new Error("back end pool is gone")),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/stores/queryStore");
  });

  it("swallows a failing deferred queryStore import instead of leaking an unhandled rejection", async () => {
    vi.doMock("@/stores/queryStore", () => {
      throw new Error("deferred queryStore module failed to load");
    });

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();

    // 被动断链会以 fire-and-forget 方式（void import）清 data-tab freshness。该
    // deferred import 失败时——CI 上表现为「环境已销毁后 chunk 才请求失败」——必须
    // 被吞掉，否则未处理的拒绝会让整个 frontend-test 分片失败。
    store.markConnectionLost("mssql-1", new Error("back end pool is gone"));

    await vi.dynamicImportSettled();

    expect(store.connectedIds.has("mssql-1")).toBe(false);
  });
});
