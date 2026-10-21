import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { useQueryStore } from "@/stores/queryStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import type { SavedSqlFile } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadSavedSqlLibrary: vi.fn(),
  loadSavedSqlFilesForSync: vi.fn(),
  loadSavedSqlFile: vi.fn(),
  saveSavedSqlFile: vi.fn(async (file: SavedSqlFile) => file),
  syncSavedSqlDirectory: vi.fn(),
}));

const timestamp = "2026-10-20T00:00:00.000Z";

const savedFile1: SavedSqlFile = {
  id: "file-1",
  connectionId: "conn-1",
  database: "testdb",
  name: "original_query.sql",
  sql: "SELECT 1;",
  sqlLoaded: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const savedFile2: SavedSqlFile = {
  id: "file-2",
  connectionId: "conn-1",
  database: "testdb",
  name: "another_query.sql",
  sql: "SELECT 2;",
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

describe("queryStore renameTab with saved SQL (#12816)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("renames an unsaved query tab without touching savedSqlStore", async () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("conn-1", "testdb", "Query 1", "query", undefined, "SELECT 1;", undefined, { forceNew: true });

    const result = await queryStore.renameTab(tabId, "my_scratchpad");
    expect(result).toBe(true);

    const tab = queryStore.tabs.find((t) => t.id === tabId);
    expect(tab?.title).toBe("my_scratchpad");
    expect(tab?.customTitle).toBe(true);
    expect(api.saveSavedSqlFile).not.toHaveBeenCalled();
  });

  it("renames a saved SQL tab and updates the savedSqlStore file and metadata", async () => {
    const savedSqlStore = useSavedSqlStore();
    savedSqlStore.files = [{ ...savedFile1 }];

    const queryStore = useQueryStore();
    const tabId = queryStore.openSavedSql(savedFile1);

    const tab = queryStore.tabs.find((t) => t.id === tabId)!;
    expect(tab.title).toBe("original_query.sql");

    const result = await queryStore.renameTab(tabId, "renamed_report");
    expect(result).toBe(true);

    expect(tab.title).toBe("renamed_report.sql");
    expect(tab.customTitle).toBe(true);

    const fileInStore = savedSqlStore.getFile(savedFile1.id);
    expect(fileInStore?.name).toBe("renamed_report.sql");

    expect(api.saveSavedSqlFile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: savedFile1.id,
        name: "renamed_report.sql",
      }),
    );
  });

  it("updates all tabs sharing the same savedSqlId when one tab is renamed", async () => {
    const savedSqlStore = useSavedSqlStore();
    savedSqlStore.files = [{ ...savedFile1 }];

    const queryStore = useQueryStore();
    const tab1Id = queryStore.openSavedSql(savedFile1);
    const tab2Id = queryStore.createTab("conn-1", "testdb", savedFile1.name, "query", undefined, savedFile1.sql, undefined, { forceNew: true });
    queryStore.linkSavedSql(tab2Id, savedFile1.id);

    const result = await queryStore.renameTab(tab1Id, "shared_new_name.sql");
    expect(result).toBe(true);

    const tab1 = queryStore.tabs.find((t) => t.id === tab1Id);
    const tab2 = queryStore.tabs.find((t) => t.id === tab2Id);
    expect(tab1?.title).toBe("shared_new_name.sql");
    expect(tab2?.title).toBe("shared_new_name.sql");
  });

  it("reverts the tab title and displays a toast when renaming causes a name conflict", async () => {
    const savedSqlStore = useSavedSqlStore();
    savedSqlStore.files = [{ ...savedFile1 }, { ...savedFile2 }];

    const queryStore = useQueryStore();
    const tabId = queryStore.openSavedSql(savedFile1);

    const tab = queryStore.tabs.find((t) => t.id === tabId)!;
    expect(tab.title).toBe("original_query.sql");

    // Attempt to rename file-1 to file-2's name: another_query.sql
    const result = await queryStore.renameTab(tabId, "another_query");
    expect(result).toBe(false);

    expect(tab.title).toBe("original_query.sql");
    expect(mocks.toast).toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only name without modifying tab title", async () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("conn-1", "testdb", "Original", "query", undefined, "SELECT 1;", undefined, { forceNew: true });

    const result = await queryStore.renameTab(tabId, "   ");
    expect(result).toBe(false);

    const tab = queryStore.tabs.find((t) => t.id === tabId);
    expect(tab?.title).toBe("Original");
  });
});
