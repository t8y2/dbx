import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore createTab reuseQueryTabByScope", () => {
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
  });

  it("focuses the existing plain query tab instead of stacking duplicates", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const firstId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });
    const secondId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });

    expect(secondId).toBe(firstId);
    expect(queryStore.tabs.filter((tab) => tab.mode === "query")).toHaveLength(1);
    expect(queryStore.activeTabId).toBe(firstId);
  });

  it("creates separate tabs for separate connection scopes", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const appTabId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });
    const otherDbTabId = queryStore.createTab("pg-1", "metrics", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });
    const otherSchemaTabId = queryStore.createTab("pg-1", "app", undefined, "query", "internal", undefined, undefined, { reuseQueryTabByScope: true });
    const otherConnectionTabId = queryStore.createTab("pg-2", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });

    expect(new Set([appTabId, otherDbTabId, otherSchemaTabId, otherConnectionTabId]).size).toBe(4);
  });

  it("keeps stacking behavior without the option so New Query stays explicit", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const firstId = queryStore.createTab("pg-1", "app", undefined, "query");
    const secondId = queryStore.createTab("pg-1", "app", undefined, "query");

    expect(secondId).not.toBe(firstId);
    expect(queryStore.tabs).toHaveLength(2);
  });

  it("never takes over saved sql, external file, or object source tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const savedSqlId = queryStore.createTab("pg-1", "app", "report.sql", "query", "public");
    queryStore.tabs.find((tab) => tab.id === savedSqlId)!.savedSqlId = "saved-1";
    const externalId = queryStore.createTab("pg-1", "app", "dump.sql", "query", "public");
    queryStore.tabs.find((tab) => tab.id === externalId)!.externalSqlPath = "/tmp/dump.sql";

    const activationId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });

    expect(activationId).not.toBe(savedSqlId);
    expect(activationId).not.toBe(externalId);
  });

  it("lets forceNew win over scope reuse", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const firstId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true });
    const forcedId = queryStore.createTab("pg-1", "app", undefined, "query", "public", undefined, undefined, { reuseQueryTabByScope: true, forceNew: true });

    expect(forcedId).not.toBe(firstId);
    expect(queryStore.tabs).toHaveLength(2);
  });
});
