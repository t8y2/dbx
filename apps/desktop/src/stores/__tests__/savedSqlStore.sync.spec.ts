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

  it("reloads the library after a restore even when it was already initialized", async () => {
    const store = useSavedSqlStore();
    await store.initFromStorage();
    const previousTreeVersion = store.treeVersion;
    const restored = library(false);
    restored.files = [{ ...restored.files[0], id: "restored", name: "restored.sql" }];
    vi.mocked(api.loadSavedSqlLibrary).mockResolvedValue(restored);

    await store.reloadFromStorage();

    expect(store.files.map((file) => file.name)).toEqual(["restored.sql"]);
    expect(store.treeVersion).toBeGreaterThan(previousTreeVersion);
    expect(api.loadSavedSqlLibrary).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing library if reloading fails", async () => {
    const store = useSavedSqlStore();
    await store.initFromStorage();
    vi.mocked(api.loadSavedSqlLibrary).mockRejectedValueOnce(new Error("read failed"));

    await expect(store.reloadFromStorage()).rejects.toThrow("read failed");
    expect(store.files.map((file) => file.name)).toEqual(["daily.sql", "weekly.sql"]);
  });

  it("waits for an in-flight initial read before reading the restored library", async () => {
    let finishInitial!: (value: ReturnType<typeof library>) => void;
    const initialRead = new Promise<ReturnType<typeof library>>((resolve) => {
      finishInitial = resolve;
    });
    const restored = library(false);
    restored.files = [{ ...restored.files[0], id: "restored", name: "restored.sql" }];
    vi.mocked(api.loadSavedSqlLibrary).mockReturnValueOnce(initialRead).mockResolvedValueOnce(restored);
    const store = useSavedSqlStore();
    const initial = store.initFromStorage();
    await Promise.resolve();
    const reload = store.reloadFromStorage();
    finishInitial(library(false));

    await Promise.all([initial, reload]);

    expect(store.files.map((file) => file.name)).toEqual(["restored.sql"]);
  });
});
