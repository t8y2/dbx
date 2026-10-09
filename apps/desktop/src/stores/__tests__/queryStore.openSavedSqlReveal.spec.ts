import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";
import type { SavedSqlFile } from "@/types/database";

const savedFile: SavedSqlFile = {
  id: "saved-sql-reveal-1",
  connectionId: "conn-1",
  database: "main",
  name: "query.sql",
  sql: "SELECT 1;\nSELECT 2;\nSELECT 3;",
  sqlLoaded: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

describe("queryStore openSavedSql with reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("sets editorRevealRequest when opening a new tab with reveal", () => {
    const store = useQueryStore();
    const tabId = store.openSavedSql(savedFile, {
      reveal: { line: 2, column: 5 },
    });

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab).toBeDefined();
    expect(tab?.editorRevealRequest).toEqual(
      expect.objectContaining({
        line: 2,
        column: 5,
      }),
    );
    expect(tab?.editorRevealRequest?.id).toBeGreaterThan(0);
  });

  it("updates editorRevealRequest when focusing an existing tab with reveal", () => {
    const store = useQueryStore();
    const tabId = store.openSavedSql(savedFile);
    const tab = store.tabs.find((t) => t.id === tabId)!;
    expect(tab.editorRevealRequest).toBeUndefined();

    // Reopen same file with reveal
    store.openSavedSql(savedFile, {
      reveal: { line: 3, column: 1 },
    });

    expect(tab.editorRevealRequest).toEqual(
      expect.objectContaining({
        line: 3,
        column: 1,
      }),
    );
  });
});
