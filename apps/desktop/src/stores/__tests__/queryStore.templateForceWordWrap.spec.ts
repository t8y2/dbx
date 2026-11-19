import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore createTab forceWordWrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("defaults new tabs to no forced word wrap", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = queryStore.createTab("pg-1", "app", "Query");
    const tab = queryStore.tabs.find((t) => t.id === tabId);

    expect(tab?.forceWordWrap).toBeFalsy();
  });

  it("marks a tab as force-wrapped when requested via options", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = queryStore.createTab("pg-1", "app", "SELECT users", "query", undefined, undefined, undefined, { forceNew: true, forceWordWrap: true });
    const tab = queryStore.tabs.find((t) => t.id === tabId);

    expect(tab?.forceWordWrap).toBe(true);
  });
});
