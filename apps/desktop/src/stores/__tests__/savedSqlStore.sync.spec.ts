import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { useSavedSqlStore } from "@/stores/savedSqlStore";

const mocks = vi.hoisted(() => ({
  syncDir: { value: "/workspace/dbx-sql-sync" as string | null },
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: { saved_sql_sync_dir: mocks.syncDir.value },
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  loadSavedSqlLibrary: vi.fn(),
  loadSavedSqlFilesForSync: vi.fn(),
  loadSavedSqlFile: vi.fn(),
  saveSavedSqlFile: vi.fn(),
  syncSavedSqlDirectory: vi.fn(),
}));

function library(sqlLoaded: boolean) {
  return {
    folders: [
      {
        id: "folder-1",
        connectionId: "connection-1",
        name: "Reports",
        orderIndex: 0,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ],
    files: [
      {
        id: "file-1",
        connectionId: "connection-1",
        folderId: "folder-1",
        name: "daily.sql",
        database: "",
        sql: sqlLoaded ? "SELECT 1;" : "",
        sqlLoaded,
        orderIndex: 0,
        openCount: 0,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        id: "file-2",
        connectionId: "connection-1",
        folderId: "folder-1",
        name: "weekly.sql",
        database: "",
        sql: sqlLoaded ? "SELECT 7;" : "",
        sqlLoaded,
        orderIndex: 1,
        openCount: 0,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ],
  };
}

describe("savedSqlStore directory sync", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.syncDir.value = "/workspace/dbx-sql-sync";
    vi.mocked(api.loadSavedSqlLibrary).mockResolvedValue(library(false));
    vi.mocked(api.loadSavedSqlFilesForSync).mockResolvedValue(library(true).files);
    vi.mocked(api.saveSavedSqlFile).mockImplementation(async (file) => file);
    vi.mocked(api.syncSavedSqlDirectory).mockResolvedValue(undefined);
  });

  it("hydrates an unloaded library with one batch request and reuses it", async () => {
    const store = useSavedSqlStore();
    await store.initFromStorage();

    await store.syncToLocalDirectory();
    await store.syncToLocalDirectory();

    expect(api.loadSavedSqlFilesForSync).toHaveBeenCalledTimes(1);
    expect(api.loadSavedSqlFile).not.toHaveBeenCalled();
    expect(api.syncSavedSqlDirectory).toHaveBeenCalledTimes(2);
    expect(api.syncSavedSqlDirectory).toHaveBeenLastCalledWith({
      targetDir: "/workspace/dbx-sql-sync",
      entries: [
        { folderName: "Reports", fileName: "daily.sql", sql: "SELECT 1;" },
        { folderName: "Reports", fileName: "weekly.sql", sql: "SELECT 7;" },
      ],
    });
  });

  it("does not add a sync read or request when directory sync is disabled", async () => {
    mocks.syncDir.value = null;
    const store = useSavedSqlStore();
    await store.initFromStorage();

    await store.saveFile({
      id: "file-1",
      connectionId: "connection-1",
      folderId: "folder-1",
      name: "daily.sql",
      database: "",
      sql: "SELECT 2;",
    });

    expect(api.saveSavedSqlFile).toHaveBeenCalledTimes(1);
    expect(api.loadSavedSqlFilesForSync).not.toHaveBeenCalled();
    expect(api.loadSavedSqlFile).not.toHaveBeenCalled();
    expect(api.syncSavedSqlDirectory).not.toHaveBeenCalled();
  });
});
