import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, test, vi } from "vitest";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "../../apps/desktop/src/types/database.ts";
import { useSavedSqlStore } from "../../apps/desktop/src/stores/savedSqlStore.ts";

const apiMock = vi.hoisted(() => ({
  loadSavedSqlLibrary: vi.fn<() => Promise<SavedSqlLibrary>>(),
  loadSavedSqlFile: vi.fn<(id: string) => Promise<SavedSqlFile | null>>(),
  saveSavedSqlFolder: vi.fn<(folder: SavedSqlFolder) => Promise<SavedSqlFolder>>(),
  syncSavedSqlDirectory: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/api", () => apiMock);

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [] });
  apiMock.loadSavedSqlFile.mockResolvedValue(null);
  apiMock.saveSavedSqlFolder.mockImplementation(async (folder) => folder);
  apiMock.syncSavedSqlDirectory.mockResolvedValue();
  vi.clearAllMocks();
});

test("concurrent saved SQL folder creates reuse the same pending folder", async () => {
  let resolveSave: ((folder: SavedSqlFolder) => void) | undefined;
  apiMock.saveSavedSqlFolder.mockImplementation(
    (folder) =>
      new Promise<SavedSqlFolder>((resolve) => {
        resolveSave = () => resolve(folder);
      }),
  );

  const store = useSavedSqlStore();
  const first = store.createFolder("conn-1", "新建文件夹");
  const second = store.createFolder("conn-1", "新建文件夹");

  assert.equal(apiMock.saveSavedSqlFolder.mock.calls.length, 1);
  resolveSave?.(apiMock.saveSavedSqlFolder.mock.calls[0]![0]);

  const [firstFolder, secondFolder] = await Promise.all([first, second]);

  assert.equal(firstFolder.id, secondFolder.id);
  assert.equal(store.folders.length, 1);
  assert.equal(store.folders[0]?.id, firstFolder.id);
});

test("saved SQL summaries load file content on demand", async () => {
  const summaryFile: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "large.sql",
    database: "",
    sql: "",
    sqlLoaded: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  const loadedFile = { ...summaryFile, sql: "SELECT 1;", sqlLoaded: true };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [summaryFile] });
  apiMock.loadSavedSqlFile.mockResolvedValue(loadedFile);

  const store = useSavedSqlStore();
  await store.initFromStorage();

  assert.equal(store.files[0]?.sql, "");
  assert.equal(store.files[0]?.sqlLoaded, false);

  const hydrated = await store.ensureFileContent("sql-1");

  assert.equal(hydrated?.sql, "SELECT 1;");
  assert.equal(store.files[0]?.sql, "SELECT 1;");
  assert.equal(apiMock.loadSavedSqlFile.mock.calls.length, 1);
});
