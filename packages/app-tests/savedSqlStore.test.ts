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

test("changing a saved SQL execution target persists the latest target", async () => {
  const file: SavedSqlFile = {
    id: "sql-target",
    connectionId: "conn-1",
    name: "query.sql",
    database: "db-1",
    catalog: "hive",
    schema: "public",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await store.updateFileExecutionTarget("sql-target", {
    connectionId: "conn-2",
    database: "db-2",
    catalog: "iceberg",
    schema: "app",
  });

  const saved = apiMock.saveSavedSqlFile.mock.calls.at(-1)?.[0];
  assert.equal(saved?.connectionId, "conn-2");
  assert.equal(saved?.database, "db-2");
  assert.equal(saved?.catalog, "iceberg");
  assert.equal(saved?.schema, "app");
  assert.equal(saved?.sql, file.sql);
  assert.equal(saved?.name, file.name);
  assert.deepEqual(
    {
      connectionId: store.getFile("sql-target")?.connectionId,
      database: store.getFile("sql-target")?.database,
      catalog: store.getFile("sql-target")?.catalog,
      schema: store.getFile("sql-target")?.schema,
    },
    { connectionId: "conn-2", database: "db-2", catalog: "iceberg", schema: "app" },
  );
});

test("rapid saved SQL target changes persist only the latest target", async () => {
  const file: SavedSqlFile = {
    id: "sql-target",
    connectionId: "conn-1",
    name: "query.sql",
    database: "db-1",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });
  apiMock.saveSavedSqlFile.mockImplementation(async (value) => value);

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const first = store.updateFileExecutionTarget("sql-target", { connectionId: "conn-2", database: "db-2" });
  const second = store.updateFileExecutionTarget("sql-target", { connectionId: "conn-3", database: "db-3" });

  await Promise.all([first, second]);

  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 1);
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.at(-1)?.[0].connectionId, "conn-3");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.at(-1)?.[0].database, "db-3");
  assert.equal(store.getFile("sql-target")?.connectionId, "conn-3");
});

test("changing only the saved SQL catalog persists the new catalog", async () => {
  const file: SavedSqlFile = {
    id: "sql-catalog-target",
    connectionId: "conn-1",
    name: "query.sql",
    database: "sales",
    catalog: "hive",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  await store.updateFileExecutionTarget("sql-catalog-target", {
    connectionId: "conn-1",
    database: "sales",
    catalog: "iceberg",
  });

  assert.equal(apiMock.saveSavedSqlFile.mock.calls.at(-1)?.[0].catalog, "iceberg");
  assert.equal(store.getFile("sql-catalog-target")?.catalog, "iceberg");
});

test("saved SQL target changes roll back when persistence fails", async () => {
  const file: SavedSqlFile = {
    id: "sql-target",
    connectionId: "conn-1",
    name: "query.sql",
    database: "db-1",
    schema: "public",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });
  apiMock.saveSavedSqlFile.mockRejectedValueOnce(new Error("disk full"));

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await assert.rejects(store.updateFileExecutionTarget("sql-target", { connectionId: "conn-2", database: "db-2", schema: "app" }), /disk full/);
  assert.deepEqual(
    {
      connectionId: store.getFile("sql-target")?.connectionId,
      database: store.getFile("sql-target")?.database,
      schema: store.getFile("sql-target")?.schema,
    },
    { connectionId: "conn-1", database: "db-1", schema: "public" },
  );
});

test("moving a saved SQL target rejects a duplicate name in the destination database", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-target",
      connectionId: "conn-1",
      catalog: "hive",
      name: "query.sql",
      database: "db-1",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    {
      id: "sql-existing",
      connectionId: "conn-1",
      catalog: "hive",
      name: "QUERY.SQL",
      database: "db-2",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await assert.rejects(store.updateFileExecutionTarget("sql-target", { connectionId: "conn-1", catalog: "hive", database: "db-2" }), /already exists/);

  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(store.getFile("sql-target")?.database, "db-1");
});

test("empty and deleted-connection SQL files remain in the library", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "unassociated",
      connectionId: "",
      name: "unassociated.sql",
      database: "",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
    {
      id: "deleted",
      connectionId: "deleted-connection",
      name: "deleted.sql",
      database: "",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  assert.deepEqual(
    store.allFiles.map((item) => item.id),
    ["deleted", "unassociated"],
  );
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

test("new SQL files use folder-scoped names until they are associated with a database", async () => {
  const existing: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    folderId: "folder-1",
    name: "query.sql",
    database: "",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [existing] });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  const saved = await store.saveFile({
    connectionId: "conn-1",
    folderId: "folder-2",
    name: "QUERY.SQL",
    database: "",
    sql: "SELECT 2;",
  });
  await assert.rejects(
    store.saveFile({
      connectionId: "conn-1",
      folderId: "folder-1",
      name: "Query.sql",
      database: "",
      sql: "SELECT 3;",
    }),
    /already exists/,
  );

  assert.equal(saved.folderId, "folder-2");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 1);
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

test("moving an unassociated SQL file rejects a duplicate name in the destination folder", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-1",
      connectionId: "conn-1",
      folderId: "folder-1",
      name: "report.sql",
      database: "",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    {
      id: "sql-2",
      connectionId: "conn-1",
      folderId: "folder-2",
      name: "REPORT.SQL",
      database: "",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await assert.rejects(store.moveFileToFolder("sql-1", "folder-2"), /already exists/);

  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(store.getFile("sql-1")?.folderId, "folder-1");
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

test("renaming a saved SQL file rejects a case-insensitive duplicate in the database", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-1",
      connectionId: "conn-1",
      catalog: "hive",
      folderId: "folder-1",
      name: "draft.sql",
      database: "analytics",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    {
      id: "sql-2",
      connectionId: "conn-1",
      catalog: "hive",
      folderId: "folder-2",
      name: "Revenue.SQL",
      database: "analytics",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await assert.rejects(store.renameFile("sql-1", "revenue.sql"), /already exists/);

  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 0);
  assert.equal(store.getFile("sql-1")?.name, "draft.sql");
});

test("saved SQL names remain independent across catalogs", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-hive",
      connectionId: "conn-1",
      catalog: "hive",
      name: "draft.sql",
      database: "analytics",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    {
      id: "sql-iceberg",
      connectionId: "conn-1",
      catalog: "iceberg",
      name: "report.sql",
      database: "analytics",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  await store.renameFile("sql-hive", "report.sql");

  assert.equal(store.getFile("sql-hive")?.name, "report.sql");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 1);
});

test("failed saved SQL rename releases the requested name for retry", async () => {
  const file: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "draft.sql",
    database: "analytics",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [file] });
  apiMock.saveSavedSqlFile.mockRejectedValueOnce(new Error("disk full")).mockImplementation(async (value) => value);

  const store = useSavedSqlStore();
  await store.initFromStorage();

  await assert.rejects(store.renameFile("sql-1", "revenue.sql"), /disk full/);
  await store.renameFile("sql-1", "revenue.sql");

  assert.equal(store.getFile("sql-1")?.name, "revenue.sql");
  assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 2);
});

test("copies saved SQL into the target database with a Navicat-style suffix", async () => {
  const folder: SavedSqlFolder = {
    id: "folder-1",
    connectionId: "conn-1",
    name: "Reports",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  const source: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    folderId: "folder-1",
    name: "report.sql",
    database: "app",
    schema: "public",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  const firstCopy: SavedSqlFile = { ...source, id: "sql-2", name: "report_copy1.sql" };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [folder], files: [source, firstCopy] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const copies = await store.copyFilesToDatabase([source.id], {
    connectionId: "conn-1",
    database: "app",
    schema: "public",
  });

  assert.equal(copies.length, 1);
  assert.equal(copies[0]?.name, "report_copy2.sql");
  assert.equal(copies[0]?.connectionId, "conn-1");
  assert.equal(copies[0]?.database, "app");
  assert.equal(copies[0]?.schema, "public");
  assert.equal(copies[0]?.folderId, "folder-1");
  assert.equal(copies[0]?.sql, "SELECT 1;");
});

test("hydrates saved SQL before copying it to another database", async () => {
  const summary: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "report.sql",
    database: "app",
    schema: "public",
    sql: "",
    sqlLoaded: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [summary] });
  apiMock.loadSavedSqlFile.mockResolvedValue({ ...summary, sql: "SELECT * FROM reports;", sqlLoaded: true });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const [copy] = await store.copyFilesToDatabase([summary.id], {
    connectionId: "conn-2",
    database: "analytics",
    schema: "reporting",
  });

  assert.equal(copy?.name, "report_copy1.sql");
  assert.equal(copy?.connectionId, "conn-2");
  assert.equal(copy?.database, "analytics");
  assert.equal(copy?.schema, "reporting");
  assert.equal(copy?.sql, "SELECT * FROM reports;");
  assert.equal(apiMock.loadSavedSqlFile.mock.calls.length, 1);
});

test("concurrent saved SQL pastes reserve different copy names in the same database scope", async () => {
  const source: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "report.sql",
    database: "analytics",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [source] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const [first, second] = await Promise.all([store.copyFilesToDatabase([source.id], { connectionId: "conn-1", catalog: "hive", database: "analytics" }), store.copyFilesToDatabase([source.id], { connectionId: "conn-1", catalog: "hive", database: "analytics" })]);

  assert.deepEqual([first[0]?.name, second[0]?.name].sort(), ["report_copy1.sql", "report_copy2.sql"]);
  assert.equal(first[0]?.catalog, "hive");
  assert.equal(second[0]?.catalog, "hive");
});

test("saved SQL paste skips a copy name reserved by a concurrent rename", async () => {
  const files: SavedSqlFile[] = [
    {
      id: "sql-source",
      connectionId: "conn-1",
      name: "report.sql",
      database: "analytics",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    {
      id: "sql-rename",
      connectionId: "conn-1",
      name: "draft.sql",
      database: "analytics",
      sql: "SELECT 2;",
      sqlLoaded: true,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ];
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files });
  let finishRename: (() => void) | undefined;
  apiMock.saveSavedSqlFile.mockImplementation((file) =>
    file.id === "sql-rename"
      ? new Promise<SavedSqlFile>((resolve) => {
          finishRename = () => resolve(file);
        })
      : Promise.resolve(file),
  );

  const store = useSavedSqlStore();
  await store.initFromStorage();

  const rename = store.renameFile("sql-rename", "report_copy1.sql");
  await vi.waitFor(() => assert.equal(apiMock.saveSavedSqlFile.mock.calls.length, 1));
  const [copy] = await store.copyFilesToDatabase(["sql-source"], {
    connectionId: "conn-1",
    database: "analytics",
  });
  finishRename?.();
  await rename;

  assert.equal(copy?.name, "report_copy2.sql");
  assert.equal(store.getFile("sql-rename")?.name, "report_copy1.sql");
});

test("failed saved SQL paste releases its reserved copy name for retry", async () => {
  const source: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "report.sql",
    database: "analytics",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [source] });
  apiMock.saveSavedSqlFile.mockRejectedValueOnce(new Error("disk full")).mockImplementation(async (file) => file);

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const target = { connectionId: "conn-1", catalog: "hive", database: "analytics" };

  await assert.rejects(store.copyFilesToDatabase([source.id], target), /disk full/);
  const [retry] = await store.copyFilesToDatabase([source.id], target);

  assert.equal(retry?.name, "report_copy1.sql");
});

test("usage updates do not invalidate the saved SQL database tree", async () => {
  const source: SavedSqlFile = {
    id: "sql-1",
    connectionId: "conn-1",
    name: "report.sql",
    database: "analytics",
    sql: "SELECT 1;",
    sqlLoaded: true,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  apiMock.loadSavedSqlLibrary.mockResolvedValue({ folders: [], files: [source] });

  const store = useSavedSqlStore();
  await store.initFromStorage();
  const treeVersion = store.treeVersion;
  const contentVersion = store.version;

  await store.recordFileUsage(source.id);

  assert.equal(store.treeVersion, treeVersion);
  assert.ok(store.version > contentVersion);
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
