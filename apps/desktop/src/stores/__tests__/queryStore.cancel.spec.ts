import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore cancel timeout recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears cancelling state when cancelQuery does not return", async () => {
    const cancelQuery = vi.fn(() => new Promise(() => undefined));

    vi.doMock("@/lib/backend/api", () => ({ cancelQuery }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "query_1");
    store.setExecutingWithId(tabId, "exec-1");

    const cancel = store.cancelTabExecution(tabId);
    expect(store.tabs[0]?.isCancelling).toBe(true);

    await vi.advanceTimersByTimeAsync(10_001);
    const result = await cancel;

    expect(result).toBe(false);
    expect(cancelQuery).toHaveBeenCalledWith("exec-1");
    expect(store.tabs[0]).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      executionId: undefined,
    });
    expect(store.tabs[0]?.result?.rows[0]?.[0]).toContain("Cancel request timed out");
  }, 15_000);

  it("clears cancelling state when cancel is acknowledged but execution does not settle", async () => {
    const cancelQuery = vi.fn(() => Promise.resolve(true));

    vi.doMock("@/lib/backend/api", () => ({ cancelQuery }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("duckdb-1", "main", "query_1");
    store.setExecutingWithId(tabId, "exec-1");

    const cancel = store.cancelTabExecution(tabId);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cancel).toBe(true);
    expect(store.tabs[0]?.isCancelling).toBe(true);

    await vi.advanceTimersByTimeAsync(2_001);

    expect(cancelQuery).toHaveBeenCalledWith("exec-1");
    expect(store.tabs[0]).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      executionId: undefined,
    });
    expect(store.tabs[0]?.result?.rows[0]?.[0]).toContain("Query canceled");
  }, 15_000);
});
