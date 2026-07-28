import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, test, vi } from "vitest";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary } from "../../apps/desktop/src/types/database.ts";
import { useSavedSqlStore } from "../../apps/desktop/src/stores/savedSqlStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";

const apiMock = vi.hoisted(() => ({
  loadSavedSqlLibrary: vi.fn<() => Promise<SavedSqlLibrary>>(),
  loadSavedSqlFile: vi.fn<(id: string) => Promise<SavedSqlFile | null>>(),
  saveSavedSqlFolder: vi.fn<(folder: SavedSqlFolder) => Promise<SavedSqlFolder>>(),
  saveSavedSqlFile: vi.fn<(file: SavedSqlFile) => Promise<SavedSqlFile>>(),
  syncSavedSqlDirectory: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [] });
  apiMock.loadSavedSqlFile.mockResolvedValue(null);
  apiMock.saveSavedSqlFolder.mockImplementation(async (folder) => folder);
  apiMock.saveSavedSqlFile.mockImplementation(async (file) => file);
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

test("creates a nested SQL folder under the requested parent", async () => {
  const root: SavedSqlFolder = {
    id: "root",
    connectionId: "conn-1",
    name: "Root",
    orderIndex: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const sibling: SavedSqlFolder = {
    id: "child-1",
    connectionId: "conn-1",
    parentFolderId: "root",
    name: "Existing child",
    orderIndex: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [root, sibling], files: [] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const child = await store.createFolder("conn-1", "Nested child", "root");

  assert.equal(child.parentFolderId, "root");
  assert.equal(child.connectionId, "conn-1");
  assert.equal(child.orderIndex, 1);
  assert.equal(apiMock.saveSavedSqlFolder.mock.calls.at(-1)?.[0].parentFolderId, "root");
  assert.deepEqual(
    store.listChildFolders("conn-1", "root").map((folder) => folder.id),
    ["child-1", child.id],
  );
});

test("does not move a SQL folder into its own descendant", async () => {
  const root: SavedSqlFolder = {
    id: "root",
    connectionId: "conn-1",
    name: "Root",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const child: SavedSqlFolder = {
    id: "child",
    connectionId: "conn-1",
    parentFolderId: "root",
    name: "Child",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [root, child], files: [] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  await store.moveFolderToFolder("root", "child");

  assert.equal(store.allFolders.find((folder) => folder.id === "root")?.parentFolderId, undefined);
  assert.equal(apiMock.saveSavedSqlFolder.mock.calls.length, 0);
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

test("saving an existing SQL file without folderId keeps its folder", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    folderId: "folder-1",
    name: "query.sql",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  const saved = await store.saveFile({
    id: "sql-1",
    connectionId: "conn-2",
    name: "query.sql",
    database: "other_db",
    sql: "SELECT 1;",
  });

  assert.equal(saved.folderId, "folder-1");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls[0]?.[0].folderId, "folder-1");
  assert.equal(store.getFile("sql-1")?.folderId, "folder-1");
});

test("saving an existing SQL file with root folder explicitly moves it to root", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    folderId: "folder-1",
    name: "query.sql",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  const saved = await store.saveFile({
    id: "sql-1",
    connectionId: "conn-1",
    folderId: undefined,
    name: "query.sql",
    database: "db",
    sql: "SELECT 1;",
  });

  assert.equal(saved.folderId, undefined);
  assert.equal(apiMock.saveSavedSqlFile.mock.calls[0]?.[0].folderId, undefined);
  assert.equal(store.getFile("sql-1")?.folderId, undefined);
});

test("moving multiple saved SQL files to a folder keeps existing target files", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-1",
      connectionId: "conn-1",
      name: "one.sql",
      database: "db",
      sql: "SELECT 1;",
      orderIndex: 0,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
    {
      id: "sql-2",
      connectionId: "conn-1",
      name: "two.sql",
      database: "db",
      sql: "SELECT 2;",
      orderIndex: 1,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
    {
      id: "sql-3",
      connectionId: "conn-1",
      folderId: "folder-1",
      name: "three.sql",
      database: "db",
      sql: "SELECT 3;",
      orderIndex: 0,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await store.moveFilesToFolder(["sql-1", "sql-2"], "folder-1");

  assert.deepEqual(
    store.filesInFolder("folder-1").map((file) => [file.id, file.folderId, file.orderIndex]),
    [
      ["sql-3", "folder-1", 0],
      ["sql-1", "folder-1", 1],
      ["sql-2", "folder-1", 2],
    ],
  );
  assert.deepEqual(
    store.filesWithoutFolder().map((file) => file.id),
    [],
  );
});

test("moving selected files already in the target folder keeps them in place", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-1",
      connectionId: "conn-1",
      name: "one.sql",
      database: "db",
      sql: "SELECT 1;",
      orderIndex: 0,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
    {
      id: "sql-2",
      connectionId: "conn-1",
      folderId: "folder-1",
      name: "two.sql",
      database: "db",
      sql: "SELECT 2;",
      orderIndex: 0,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await store.moveFilesToFolder(["sql-1", "sql-2"], "folder-1");

  assert.deepEqual(
    store.filesInFolder("folder-1").map((file) => file.id),
    ["sql-2", "sql-1"],
  );
});

test("renaming a saved SQL file syncs linked tab titles", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "draft.sql",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const savedSqlStore = useSavedSqlStore();
  await savedSqlStore.initFromStorage();

  const queryStore = useQueryStore();
  const tabId = queryStore.openSavedSql(file);
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  assert.equal(tab?.title, "draft.sql");

  await savedSqlStore.renameFile("sql-1", "revenue.sql");

  assert.equal(savedSqlStore.getFile("sql-1")?.name, "revenue.sql");
  assert.equal(queryStore.tabs.find((item) => item.id === tabId)?.title, "revenue.sql");
});

test("renaming a saved SQL tab syncs the library file name", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "draft.sql",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const savedSqlStore = useSavedSqlStore();
  await savedSqlStore.initFromStorage();

  const queryStore = useQueryStore();
  const tabId = queryStore.openSavedSql(file);

  assert.equal(queryStore.renameTab(tabId, " Revenue checks "), true);
  await Promise.resolve();

  assert.equal(queryStore.tabs.find((item) => item.id === tabId)?.title, "Revenue checks.sql");
  assert.equal(savedSqlStore.getFile("sql-1")?.name, "Revenue checks.sql");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.at(-1)?.[0].name, "Revenue checks.sql");
});

test("renaming a saved SQL tab keeps uppercase .SQL extension without double-appending", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "report.SQL",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const savedSqlStore = useSavedSqlStore();
  await savedSqlStore.initFromStorage();

  const queryStore = useQueryStore();
  const tabId = queryStore.openSavedSql(file);

  assert.equal(queryStore.renameTab(tabId, "report.SQL"), true);
  await Promise.resolve();

  assert.equal(queryStore.tabs.find((item) => item.id === tabId)?.title, "report.SQL");
  assert.equal(savedSqlStore.getFile("sql-1")?.name, "report.SQL");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 0);
});

test("renaming a saved SQL tab reverts title when persistence fails", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "draft.sql",
    database: "db",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const savedSqlStore = useSavedSqlStore();
  await savedSqlStore.initFromStorage();

  const queryStore = useQueryStore();
  const tabId = queryStore.openSavedSql(file);

  apiMock.saveSavedSqlFile.mockRejectedValueOnce(new Error("disk full"));
  assert.equal(queryStore.renameTab(tabId, "broken"), true);
  await vi.waitFor(() => queryStore.tabs.find((item) => item.id === tabId)?.title === "draft.sql");

  assert.equal(savedSqlStore.getFile("sql-1")?.name, "draft.sql");
});
