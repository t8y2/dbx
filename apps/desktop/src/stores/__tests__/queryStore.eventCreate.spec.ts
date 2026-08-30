import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
  return data;
}

// queryStore 是巨型模块，每个用例 vi.resetModules() 后动态 import 需要数秒，
// 显式放宽超时（与 queryStore.database-open.spec.ts 的做法一致）。
const QUERY_STORE_TEST_TIMEOUT = 30_000;

describe("queryStore MySQL Event create navigation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "records an explicit CREATE request when opening a brand-new ObjectBrowser for New Event",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events", 1);

      expect(store.tabs).toHaveLength(1);
      expect(store.tabs.find((tab) => tab.id === tabId)?.objectBrowser).toMatchObject({
        eventName: undefined,
        eventReadOnly: false,
        eventOpenRequestId: undefined,
        eventCreateRequestId: 1,
        initialObjectFilter: "events",
      });
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "reuses the existing ObjectBrowser tab and re-triggers CREATE on every New Event click",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstTabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events", 1);
      const tab = store.tabs.find((item) => item.id === firstTabId)!;

      // Second click on the SAME tab: request id must increment so the tab can
      // re-enter CREATE mode instead of swallowing the action.
      const secondTabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events", 2);

      expect(secondTabId).toBe(firstTabId);
      expect(tab.objectBrowser?.eventCreateRequestId).toBe(2);
      expect(tab.objectBrowser?.eventName).toBeUndefined();
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens an existing event in edit mode without any create state",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, "foo_event", false, "events");

      const tab = store.tabs.find((item) => item.id === tabId)!;
      expect(tab.objectBrowser?.eventName).toBe("foo_event");
      expect(tab.objectBrowser?.eventOpenRequestId).toBe(1);
      expect(tab.objectBrowser?.eventCreateRequestId).toBeUndefined();
      expect(tab.objectBrowser?.initialObjectFilter).toBe("events");

      // Re-opening the same existing event on the reused tab increments edit request id
      store.openObjectBrowser("mysql-1", "shop", undefined, undefined, "foo_event", true, "events");
      expect(tab.objectBrowser?.eventOpenRequestId).toBe(2);
      expect(tab.objectBrowser?.eventReadOnly).toBe(true);
      expect(tab.objectBrowser?.eventCreateRequestId).toBeUndefined();
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "keeps create and edit requests mutually exclusive on a reused tab",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events", 1);
      const tab = store.tabs.find((item) => item.id === tabId)!;

      // Edit request after a create request clears the stale create state
      store.openObjectBrowser("mysql-1", "shop", undefined, undefined, "foo_event", false, "events");
      expect(tab.objectBrowser?.eventName).toBe("foo_event");
      expect(tab.objectBrowser?.eventCreateRequestId).toBeUndefined();

      // A later create request clears the stale edit state
      store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events", 3);
      expect(tab.objectBrowser?.eventCreateRequestId).toBe(3);
      expect(tab.objectBrowser?.eventName).toBeUndefined();
      expect(tab.objectBrowser?.eventOpenRequestId).toBeUndefined();
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "plain Event list open carries no create or edit intent",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openObjectBrowser("mysql-1", "shop", undefined, undefined, undefined, false, "events");

      expect(store.tabs.find((tab) => tab.id === tabId)?.objectBrowser).toMatchObject({
        eventName: undefined,
        eventCreateRequestId: undefined,
        eventOpenRequestId: undefined,
        initialObjectFilter: "events",
      });
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
