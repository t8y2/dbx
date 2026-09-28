import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import type { SavedSqlFile, SavedSqlLibrary } from "@/types/database";

const mocks = vi.hoisted(() => ({
  library: { folders: [], files: [] } as SavedSqlLibrary,
  syncDir: null as string | null,
  tauri: false,
  getConfig: vi.fn((id: string) => (id === "missing" ? undefined : { id, name: id, db_type: "mysql" })),
  syncTargets: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.tauri }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ desktopSettings: { saved_sql_sync_dir: mocks.syncDir } }),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig }),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ syncSavedSqlExecutionTargets: mocks.syncTargets }),
}));
vi.mock("@/lib/backend/api", () => ({
  loadSavedSqlLibrary: vi.fn(),
  loadSavedSqlFilesForSync: vi.fn(),
  loadSavedSqlFile: vi.fn(),
  saveSavedSqlFile: vi.fn(),
  syncSavedSqlDirectory: vi.fn(),
}));

const timestamp = "2026-09-01T00:00:00.000Z";

function savedFile(overrides: Partial<SavedSqlFile> & Pick<SavedSqlFile, "id" | "name">): SavedSqlFile {
  return {
    connectionId: "source",
    database: "sales",
    catalog: "hive",
    schema: "reporting",
    sql: "",
    sqlLoaded: false,
    orderIndex: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

async function loadStore(library: SavedSqlLibrary) {
  mocks.library = library;
  vi.mocked(api.loadSavedSqlLibrary).mockImplementation(async () => structuredClone(mocks.library));
  const store = useSavedSqlStore();
  await store.initFromStorage();
  return store;
}

describe("savedSqlStore batch execution target changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.syncDir = null;
    mocks.tauri = false;
    mocks.getConfig.mockImplementation((id: string) => (id === "missing" ? undefined : { id, name: id, db_type: "mysql" }));
    vi.mocked(api.saveSavedSqlFile).mockImplementation(async (file) => ({ ...file }));
    vi.mocked(api.syncSavedSqlDirectory).mockResolvedValue(undefined);
  });

  it("keeps the existing single-file target update behavior", async () => {
    const store = await loadStore({
      folders: [{ id: "folder-1", connectionId: "source", name: "Reports", orderIndex: 0, createdAt: timestamp, updatedAt: timestamp }],
      files: [savedFile({ id: "single", folderId: "folder-1", name: "single.sql", orderIndex: 3 })],
    });
    vi.mocked(api.loadSavedSqlFile).mockResolvedValue({ ...savedFile({ id: "single", folderId: "folder-1", name: "single.sql", orderIndex: 3 }), sql: "SELECT single;", sqlLoaded: true });

    await store.updateFileExecutionTarget("single", { connectionId: "target", database: "analytics", schema: "public" });

    expect(store.getFile("single")).toMatchObject({ connectionId: "target", database: "analytics", schema: "public", folderId: "folder-1", orderIndex: 3, sql: "SELECT single;", sqlLoaded: true });
    expect(api.loadSavedSqlFile).toHaveBeenCalledWith("single");
    expect(mocks.syncTargets).not.toHaveBeenCalled();
  });

  it("reassigns unloaded files in place without reading their SQL bodies", async () => {
    const store = await loadStore({
      folders: [{ id: "folder-1", connectionId: "source", name: "Reports", orderIndex: 0, createdAt: timestamp, updatedAt: timestamp }],
      files: [
        savedFile({ id: "daily", folderId: "folder-1", name: "daily.sql", orderIndex: 0 }),
        savedFile({ id: "weekly", folderId: "folder-1", name: "weekly.sql", orderIndex: 1 }),
        savedFile({ id: "existing", connectionId: "target", database: "analytics", catalog: undefined, schema: undefined, name: "other.sql", orderIndex: 4 }),
      ],
    });

    const result = await store.updateFilesExecutionTarget(["daily", "weekly"], { connectionId: "target", database: "analytics" });

    expect(result.failures).toEqual([]);
    expect(result.updated.map((file) => file.id)).toEqual(["daily", "weekly"]);
    expect(api.loadSavedSqlFile).not.toHaveBeenCalled();
    expect(api.saveSavedSqlFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.saveSavedSqlFile).mock.calls.map(([file]) => file)).toEqual([
      expect.objectContaining({ id: "daily", connectionId: "target", database: "analytics", catalog: undefined, schema: undefined, folderId: "folder-1", orderIndex: 0, sql: "", sqlLoaded: false }),
      expect.objectContaining({ id: "weekly", connectionId: "target", database: "analytics", catalog: undefined, schema: undefined, folderId: "folder-1", orderIndex: 1, sql: "", sqlLoaded: false }),
    ]);
    expect(store.getFile("daily")).toMatchObject({ id: "daily", name: "daily.sql", connectionId: "target", database: "analytics", folderId: "folder-1", orderIndex: 0, sqlLoaded: false });
    expect(mocks.syncTargets).toHaveBeenCalledOnce();
    expect(mocks.syncTargets.mock.calls[0]?.[0].map((file: SavedSqlFile) => file.id)).toEqual(["daily", "weekly"]);
  });

  it("rolls back only failed files and exposes partial persistence", async () => {
    const store = await loadStore({
      folders: [{ id: "folder-1", connectionId: "source", name: "Reports", orderIndex: 0, createdAt: timestamp, updatedAt: timestamp }],
      files: [savedFile({ id: "ok", folderId: "folder-1", name: "ok.sql" }), savedFile({ id: "failed", folderId: "folder-1", name: "failed.sql", orderIndex: 1 })],
    });
    vi.mocked(api.saveSavedSqlFile).mockImplementation(async (file) => {
      if (file.id === "failed") throw new Error("disk full");
      return { ...file };
    });

    const result = await store.updateFilesExecutionTarget(["ok", "failed"], { connectionId: "target", database: "analytics" });

    expect(result.succeeded.map((file) => file.id)).toEqual(["ok"]);
    expect(result.failures).toEqual([expect.objectContaining({ fileId: "failed", fileName: "failed.sql", error: expect.objectContaining({ message: "disk full" }) })]);
    expect(store.getFile("ok")).toMatchObject({ connectionId: "target", database: "analytics", folderId: "folder-1" });
    expect(store.getFile("failed")).toMatchObject({ connectionId: "source", database: "sales", catalog: "hive", schema: "reporting", folderId: "folder-1", orderIndex: 1 });
    expect(mocks.syncTargets).toHaveBeenCalledWith([expect.objectContaining({ id: "ok" })]);
  });

  it("reports destination name collisions without persisting or losing the source", async () => {
    const source = savedFile({ id: "source-file", folderId: "folder-1", name: "report.sql", orderIndex: 2 });
    const store = await loadStore({
      folders: [{ id: "folder-1", connectionId: "source", name: "Reports", orderIndex: 0, createdAt: timestamp, updatedAt: timestamp }],
      files: [source, savedFile({ id: "target-file", connectionId: "target", database: "analytics", catalog: undefined, schema: undefined, folderId: "folder-1", name: "report.sql", orderIndex: 0 })],
    });

    const result = await store.updateFilesExecutionTarget([source.id], { connectionId: "target", database: "analytics" });

    expect(result.succeeded).toEqual([]);
    expect(result.failures[0]).toMatchObject({ fileId: source.id, fileName: source.name, error: expect.objectContaining({ code: "SAVED_SQL_NAME_CONFLICT" }) });
    expect(api.saveSavedSqlFile).not.toHaveBeenCalled();
    expect(store.getFile(source.id)).toEqual(source);
    expect(mocks.syncTargets).not.toHaveBeenCalled();
  });

  it("treats empty selections and missing target connections as no-ops", async () => {
    const store = await loadStore({ folders: [], files: [savedFile({ id: "file", name: "file.sql" })] });

    await expect(store.updateFilesExecutionTarget([], { connectionId: "target", database: "analytics" })).resolves.toEqual({ succeeded: [], updated: [], failures: [] });
    await expect(store.updateFilesExecutionTarget(["file"], { connectionId: "missing", database: "analytics" })).resolves.toEqual({ succeeded: [], updated: [], failures: [] });
    expect(api.saveSavedSqlFile).not.toHaveBeenCalled();
    expect(mocks.syncTargets).not.toHaveBeenCalled();
  });

  it("synchronizes the configured local directory once after a batch", async () => {
    mocks.tauri = true;
    mocks.syncDir = "/workspace/sql-sync";
    const store = await loadStore({
      folders: [],
      files: [savedFile({ id: "one", name: "one.sql", sql: "SELECT 1;", sqlLoaded: true }), savedFile({ id: "two", name: "two.sql", sql: "SELECT 2;", sqlLoaded: true, orderIndex: 1 })],
    });

    await store.updateFilesExecutionTarget(["one", "two"], { connectionId: "target", database: "analytics" });

    expect(api.syncSavedSqlDirectory).toHaveBeenCalledOnce();
    expect(api.syncSavedSqlDirectory).toHaveBeenCalledWith({
      targetDir: "/workspace/sql-sync",
      entries: [
        { folderName: undefined, fileName: "one.sql", sql: "SELECT 1;" },
        { folderName: undefined, fileName: "two.sql", sql: "SELECT 2;" },
      ],
    });
    expect(api.loadSavedSqlFilesForSync).not.toHaveBeenCalled();
  });
});
