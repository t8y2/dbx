import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, test, vi } from "vitest";
import type { SavedSqlFolder, SavedSqlLibrary } from "../../apps/desktop/src/types/database.ts";
import { useSavedSqlStore } from "../../apps/desktop/src/stores/savedSqlStore.ts";

const apiMock = vi.hoisted(() => ({
  loadSavedSqlLibrary: vi.fn<() => Promise<SavedSqlLibrary>>(),
  saveSavedSqlFolder: vi.fn<(folder: SavedSqlFolder) => Promise<SavedSqlFolder>>(),
  syncSavedSqlDirectory: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/api", () => apiMock);

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [] });
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
