import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { useQueryStore } from "@/stores/queryStore";
import type { SavedSqlFile } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  executeMulti: vi.fn(),
  executeQuery: vi.fn(),
}));

const timestamp = "2026-09-01T00:00:00.000Z";
const savedFile: SavedSqlFile = {
  id: "saved-1",
  connectionId: "source",
  database: "sales",
  catalog: "hive",
  schema: "reporting",
  name: "report.sql",
  sql: "SELECT persisted;",
  sqlLoaded: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

describe("queryStore saved SQL target synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("retargets every matching tab while preserving unsaved editor state", () => {
    const store = useQueryStore();
    const firstId = store.openSavedSql(savedFile);
    const secondId = store.createTab("source", "sales", "second", "query", "reporting", "SELECT second;", "hive", { forceNew: true });
    store.linkSavedSql(secondId, savedFile.id);
    store.updateSql(firstId, "SELECT unsaved first;");
    store.updateSql(secondId, "SELECT unsaved second;");

    const first = store.tabs.find((tab) => tab.id === firstId)!;
    const second = store.tabs.find((tab) => tab.id === secondId)!;
    first.editorSelection = { anchor: 8, head: 8 };
    first.editorViewport = { scrollTop: 120, scrollLeft: 8 };

    expect(store.syncSavedSqlExecutionTargets([{ ...savedFile, connectionId: "target", database: "analytics", catalog: undefined, schema: undefined }])).toBe(2);

    expect(first).toMatchObject({ connectionId: "target", database: "analytics", sql: "SELECT unsaved first;", originalSql: savedFile.sql, editorSelection: { anchor: 8, head: 8 }, editorViewport: { scrollTop: 120, scrollLeft: 8 } });
    expect(second).toMatchObject({ connectionId: "target", database: "analytics", sql: "SELECT unsaved second;", originalSql: "SELECT second;" });
    expect(first.catalog).toBeUndefined();
    expect(first.schema).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === firstId)).toBe(first);
    expect(store.tabs.find((tab) => tab.id === secondId)).toBe(second);
    expect(store.isTabDirty(first)).toBe(true);
    expect(store.isTabDirty(second)).toBe(true);
    expect(api.executeMulti).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("does not change tabs for files omitted from a successful batch", () => {
    const store = useQueryStore();
    const tabId = store.openSavedSql(savedFile);

    expect(store.syncSavedSqlExecutionTargets([])).toBe(0);
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({ connectionId: "source", database: "sales", catalog: "hive", schema: "reporting" });
  });
});
