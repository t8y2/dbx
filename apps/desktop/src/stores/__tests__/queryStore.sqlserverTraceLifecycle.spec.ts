import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disposeSqlServerActivityTrace: vi.fn(() => Promise.resolve()),
  disposeAllSqlServerActivityTraces: vi.fn(() => Promise.resolve()),
  disposeSqlServerActivityTracesForConnection: vi.fn(() => Promise.resolve()),
  cleanupStaleSqlServerTraceSessions: vi.fn(() => Promise.resolve(0)),
  hasSqlServerActivityTraceForConnection: vi.fn(() => false),
}));

vi.mock("@/lib/sqlserver/sqlServerActivityTraceRuntime", () => mocks);

describe("queryStore SQL Server trace lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("disposes the trace runtime only when its tab is explicitly closed", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openSqlServerActivityTrace("sqlserver-1");

    store.switchTab(store.createTab("sqlserver-1", "app", "query_1"));
    expect(mocks.disposeSqlServerActivityTrace).not.toHaveBeenCalled();

    store.closeTab(tabId);
    expect(mocks.disposeSqlServerActivityTrace).toHaveBeenCalledWith(tabId);
  });
});
