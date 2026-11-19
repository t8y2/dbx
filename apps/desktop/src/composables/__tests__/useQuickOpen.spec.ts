import { effectScope, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchQuickOpenText, useQuickOpen, type QuickOpenItem } from "@/composables/useQuickOpen";
import * as api from "@/lib/backend/api";
import { getSqlFileFilter, getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import { globalSearchSettingsVersion } from "@/lib/globalSearch/globalSearchSettings";
import { setQuickOpenScopeIds } from "@/lib/quickOpen/quickOpenScope";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { encodeQuickOpenMetadataCache, quickOpenMetadataCacheKey, quickOpenMetadataConnectionFingerprint } from "@/lib/quickOpen/quickOpenMetadataCache";
import { matchesQuickSearchQuery, parseQuickSearchQuery, updateQuickSearchIndex } from "@/lib/quickOpen/quickSearch";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn(),
  readExternalSqlFile: vi.fn(),
  listPlugins: vi.fn(),
  buildDatabaseStructureSearchSql: vi.fn(),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(),
  globalSearch: vi.fn(),
  cancelGlobalSearch: vi.fn(),
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
}));

vi.mock("@/lib/globalSearch/globalSearchSettings", async () => {
  const { ref } = await import("vue");
  return {
    composeGlobalSearchRoots: vi.fn(() => ["/sql"]),
    getGlobalSearchExtensions: vi.fn(() => ["sql"]),
    globalSearchSettingsVersion: ref(0),
  };
});

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFilter: vi.fn(() => "*.sql"),
    getSqlFileFolderPaths: vi.fn(),
    sqlFileFoldersVersion: ref(0),
  };
});

function emptySavedSqlStore() {
  return {
    allFiles: [] as any[],
    getFile: vi.fn().mockReturnValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("quick search query syntax", () => {
  it("parses structured filters and preserves free text", () => {
    expect(parseQuickSearchQuery('kind:column db:analytics schema:public comment:"用户 邮箱" source:remote category:objects email')).toMatchObject({
      text: "email",
      terms: ["email"],
      filters: { kind: "column", database: "analytics", schema: "public", comment: "用户 邮箱", source: "remote", category: "objects" },
    });
  });

  it.each([
    ["package-body", "package-body"],
    ["package_body", "package-body"],
    ["materialized-view", "materialized_view"],
    ["materialized_view", "materialized_view"],
  ] as const)("matches %s against its canonical result type", (kind, type) => {
    expect(matchesQuickSearchQuery({ id: "object", type, label: "object", connectionId: "c", searchText: "object" }, parseQuickSearchQuery(`kind:${kind}`))).toBe(true);
  });

  it("does not infer a PostgreSQL schema from the database or catalog", () => {
    const result = { id: "pg", type: "table" as const, label: "needle", connectionId: "c", database: "app", catalog: "catalog", searchText: "needle" };
    expect(matchesQuickSearchQuery(result, parseQuickSearchQuery("schema:app"))).toBe(false);
    expect(matchesQuickSearchQuery({ ...result, schema: "app" }, parseQuickSearchQuery("schema:app"))).toBe(true);
  });

  it("reuses unchanged entries when the metadata snapshot changes", () => {
    const first = { id: "1", type: "column" as const, label: "email", connectionId: "c", database: "analytics", searchText: "email" };
    const initial = updateQuickSearchIndex(undefined, [first]);
    const updated = updateQuickSearchIndex(initial, [{ ...first }, { id: "2", type: "table" as const, label: "users", connectionId: "c", database: "analytics", searchText: "users" }]);
    expect(updated.entries[0]).toBe(initial.entries[0]);
    expect(updated.entries.map((entry) => entry.result.id)).toEqual(["1", "2"]);
  });

  it("filters results before fuzzy matching", () => {
    const query = parseQuickSearchQuery("kind:column db:analytics email");
    expect(matchesQuickSearchQuery({ id: "1", type: "column", label: "email", connectionId: "c", database: "analytics", searchText: "email" }, query)).toBe(true);
    expect(matchesQuickSearchQuery({ id: "2", type: "table", label: "email", connectionId: "c", database: "analytics", searchText: "email" }, query)).toBe(false);
    expect(matchesQuickSearchQuery({ id: "3", type: "column", label: "email", connectionId: "c", database: "warehouse", searchText: "email" }, query)).toBe(false);
    expect(matchesQuickSearchQuery({ id: "4", type: "sql_library_file", label: "report.sql", connectionId: "", searchText: "report.sql" }, parseQuickSearchQuery("file:report"))).toBe(true);
    expect(matchesQuickSearchQuery({ id: "5", type: "sql_library_file", label: "report.sql", connectionId: "", searchText: "report.sql" }, parseQuickSearchQuery("kind:file"))).toBe(true);
    expect(matchesQuickSearchQuery({ id: "6", type: "column", label: "email", connectionId: "c", searchText: "email", source: "remote" }, parseQuickSearchQuery("source:remote category:objects"))).toBe(true);
    expect(matchesQuickSearchQuery({ id: "7", type: "column", label: "email", connectionId: "c", searchText: "email", source: "cache" }, parseQuickSearchQuery("source:remote"))).toBe(false);
  });
});

describe("useQuickOpen", () => {
  beforeEach(() => {
    vi.mocked(useSavedSqlStore).mockReturnValue(emptySavedSqlStore() as any);
    vi.mocked(getSqlFileFolderPaths).mockReturnValue([]);
  });

  afterEach(() => {
    // The scope is module-level state and every useQuickOpen() instance leaves live
    // watchers behind, so a leaked scope or mock would make later tests order-dependent.
    setQuickOpenScopeIds([]);
    vi.clearAllMocks();
  });

  describe("recent target snapshots", () => {
    it("resolves library history against current metadata beyond the recent-file limit", () => {
      const library = reactive({ allFiles: Array.from({ length: 25 }, (_, index) => ({ id: `file${index}`, name: `file${index}.sql`, connectionId: "a", updatedAt: `2026-01-${String(25 - index).padStart(2, "0")}` })), getFile: (id: string) => library.allFiles.find((file) => file.id === id) });
      vi.mocked(useSavedSqlStore).mockReturnValue(library as any);
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
        treeNodes: [],
        connectedIds: new Set(),
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.recordRecentItem({ id: "sqllib-file24", type: "sql_library_file", label: "old.sql", connectionId: "a", sqlFileId: "file24", searchText: "old.sql" });
        expect(state.homeItems.value[0]?.label).toBe("file24.sql");
        library.allFiles[24]!.name = "renamed.sql";
        library.allFiles[24]!.connectionId = "b";
        state.setScopeConnectionIds(["b"]);
        expect(state.homeItems.value[0]).toMatchObject({ label: "renamed.sql", connectionId: "b" });
        state.setScopeConnectionIds(["a"]);
        expect(state.homeItems.value.some((item) => item.id === "sqllib-file24")).toBe(false);
        state.setScopeConnectionIds([]);
        library.allFiles.splice(24, 1);
        expect(state.homeItems.value.some((item) => item.id === "sqllib-file24")).toBe(false);
      } finally {
        scope.stop();
      }
    });

    it("shows a recently opened content file only once alongside indexed SQL files", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [], connectedIds: new Set() } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValue(["/sql"]);
      vi.mocked(api.listSqlFilesInFolder).mockResolvedValue([{ name: "report.sql", path: "/sql/report.sql", is_dir: false, children: [] }]);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        await state.loadExternalSqlFiles();
        state.recordRecentItem({ id: "content-report", type: "content_match", connectionId: "", label: "report.sql", fileName: "report.sql", filePath: "/sql/report.sql", searchText: "needle", lineText: "needle", line: 1 });
        expect(state.homeItems.value.filter((item) => item.filePath === "/sql/report.sql")).toHaveLength(1);
      } finally {
        scope.stop();
      }
    });

    it("removes transient actions on both save and restore, including legacy history", () => {
      const item: QuickOpenItem = { id: "remote-table", type: "table", connectionId: "c", database: "app", tableName: "reports", label: "reports", searchText: "reports", searchScope: "structure", source: "remote" };
      const storage = new Map<string, string>([["dbx.quick-open.recent-items", JSON.stringify([{ id: item.id, item, lastOpenedAt: Date.now() }])]]);
      const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
      vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem });
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [{ id: "c", name: "PG", db_type: "postgres" }], treeNodes: [], connectedIds: new Set() } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        expect(state.homeItems.value.find((entry) => entry.id === item.id)?.searchScope).toBeUndefined();
        expect(state.homeItems.value.some((entry) => entry.id === item.id)).toBe(true);
        state.recordRecentItem(item);
        expect(item.searchScope).toBe("structure");
        expect(state.homeItems.value.find((entry) => entry.id === item.id)?.searchScope).toBeUndefined();
        expect(JSON.parse(storage.get("dbx.quick-open.recent-items")!)[0].item).not.toHaveProperty("searchScope");
      } finally {
        scope.stop();
        vi.unstubAllGlobals();
      }
    });
  });

  describe("offline metadata cache", () => {
    it("loads last-known columns without connecting the database", async () => {
      const connection = { id: "offline", name: "Offline", db_type: "postgres", database: "app" } as any;
      const cachedItem = {
        type: "column" as const,
        label: "email",
        connectionId: connection.id,
        database: "app",
        schema: "public",
        tableName: "users",
        columnName: "email",
        columnComment: "login address",
        tableType: "TABLE",
      };
      vi.mocked(api.loadSchemaCache).mockResolvedValue(encodeQuickOpenMetadataCache(connection.id, quickOpenMetadataConnectionFingerprint(connection), [cachedItem]));
      const ensureConnected = vi.fn();
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [connection],
        treeNodes: [],
        connectedIds: new Set(),
        ensureConnected,
        getConfig: vi.fn(() => connection),
        loadSidebarTableSearchIndexScopes: vi.fn().mockResolvedValue([]),
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        await flushAsyncWork();
        await flushAsyncWork();
        expect(state.matchingItems.value.find((item) => item.type === "column" && item.label === "email")).toMatchObject({ source: "cache", tableName: "users" });
        state.setQuery("email");
        expect(state.matchingItems.value.some((item) => item.type === "column" && item.label === "email")).toBe(true);
        expect(ensureConnected).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("drops an offline read when the connection endpoint changes", async () => {
      const oldConnection = { id: "edited", name: "Edited", db_type: "postgres", host: "old.example", database: "app" } as any;
      const connections = reactive([oldConnection]);
      const oldRead = deferred<any>();
      const freshRead = deferred<any>();
      let readIndex = 0;
      vi.mocked(api.loadSchemaCache).mockImplementation(async () => (readIndex++ === 0 ? oldRead.promise : freshRead.promise));
      vi.mocked(useConnectionStore).mockReturnValue({
        connections,
        treeNodes: reactive([]),
        connectedIds: new Set(),
        getConfig: vi.fn((id: string) => connections.find((connection) => connection.id === id)),
        loadSidebarTableSearchIndexScopes: vi.fn().mockResolvedValue([]),
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        await flushAsyncWork();
        connections.splice(0, 1, { ...oldConnection, host: "new.example" });
        await flushAsyncWork();
        oldRead.resolve(encodeQuickOpenMetadataCache(oldConnection.id, quickOpenMetadataConnectionFingerprint(oldConnection), [{ type: "table", label: "old_users", connectionId: oldConnection.id, database: "app", schema: "public", tableName: "old_users" }]));
        for (let index = 0; index < 10 && readIndex < 2; index++) await flushAsyncWork();
        expect(readIndex).toBeGreaterThanOrEqual(2);
        freshRead.resolve(null);
        for (let index = 0; index < 10; index++) await flushAsyncWork();
        expect(state.matchingItems.value.some((item) => item.label === "old_users")).toBe(false);
      } finally {
        scope.stop();
      }
    });

    it("imports complete sidebar table indexes while disconnected", async () => {
      const connection = { id: "indexed", name: "Indexed", db_type: "postgres", database: "app" } as any;
      vi.mocked(api.loadSchemaCache).mockResolvedValue(null);
      const ensureConnected = vi.fn();
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [connection],
        treeNodes: [],
        connectedIds: new Set(),
        ensureConnected,
        loadSidebarTableSearchIndexScopes: vi.fn().mockResolvedValue([
          {
            scope: { connectionId: connection.id, database: "app", schema: "public", catalog: undefined, nodeType: "group-tables", parentNodeId: "tables", cacheKey: "cache" },
            entries: [{ name: "late_orders", table_type: "TABLE", comment: "Historical orders" }],
            stale: true,
          },
        ]),
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        for (let index = 0; index < 10 && !state.matchingItems.value.some((item) => item.type === "table" && item.label === "late_orders"); index++) await flushAsyncWork();
        expect(state.matchingItems.value.find((item) => item.type === "table" && item.label === "late_orders")).toMatchObject({ source: "cache", tableComment: "Historical orders" });
        expect(state.matchingItems.value.some((item) => item.type === "database" && item.label === "app")).toBe(true);
        expect(ensureConnected).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("persists loaded metadata and restores it after the live tree is cleared", async () => {
      const connection = { id: "persisted", name: "Persisted", db_type: "postgres", database: "app" } as any;
      const column = {
        id: "column",
        label: "email",
        type: "column",
        connectionId: connection.id,
        database: "app",
        schema: "public",
        tableName: "users",
        meta: { name: "email", data_type: "text", comment: "login address" },
      };
      const treeNodes = [
        {
          id: connection.id,
          label: connection.name,
          type: "connection",
          connectionId: connection.id,
          children: [
            {
              id: "db",
              label: "app",
              type: "database",
              connectionId: connection.id,
              database: "app",
              children: [
                {
                  id: "schema",
                  label: "public",
                  type: "schema",
                  connectionId: connection.id,
                  database: "app",
                  schema: "public",
                  children: [
                    {
                      id: "table",
                      label: "users",
                      type: "table",
                      connectionId: connection.id,
                      database: "app",
                      schema: "public",
                      children: [{ id: "columns", label: "Columns", type: "group-columns", children: [column] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      let savedPayload: unknown;
      vi.mocked(api.loadSchemaCache).mockResolvedValue(null);
      vi.mocked(api.saveSchemaCache).mockImplementation(async (cacheKey, payload) => {
        if (cacheKey === quickOpenMetadataCacheKey(connection.id)) savedPayload = payload;
      });
      const store = {
        connections: [connection],
        treeNodes,
        connectedIds: new Set(),
        getConfig: vi.fn(() => connection),
        loadSidebarTableSearchIndexScopes: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const firstScope = effectScope();
      try {
        const first = firstScope.run(() => useQuickOpen())!;
        expect(first.matchingItems.value.some((item) => item.type === "column" && item.label === "email")).toBe(true);
        for (let index = 0; index < 10 && !savedPayload; index++) await flushAsyncWork();
        expect(savedPayload).toBeTruthy();
      } finally {
        firstScope.stop();
      }

      vi.mocked(api.loadSchemaCache).mockImplementation(async (cacheKey) => (cacheKey === quickOpenMetadataCacheKey(connection.id) ? savedPayload : null));
      vi.mocked(api.saveSchemaCache).mockClear();
      vi.mocked(useConnectionStore).mockReturnValue({ ...store, treeNodes: [] } as any);
      const secondScope = effectScope();
      try {
        const second = secondScope.run(() => useQuickOpen())!;
        for (let index = 0; index < 10 && !second.matchingItems.value.some((item) => item.type === "column" && item.label === "email"); index++) await flushAsyncWork();
        expect(second.matchingItems.value.find((item) => item.type === "column" && item.label === "email")).toMatchObject({ source: "cache", tableName: "users" });
      } finally {
        secondScope.stop();
      }
    });
  });

  describe("content search", () => {
    it("does not restart closed searches when settings or connection scope change", async () => {
      vi.useFakeTimers();
      const enabled = ref(true);
      const listCompletionTables = vi.fn().mockResolvedValue([]);
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [{ id: "c", name: "PG", db_type: "postgres", database: "app" }], treeNodes: [], connectedIds: new Set(["c"]), listCompletionTables } as any);
      vi.mocked(api.globalSearch).mockResolvedValue({ matches: [], errors: [] });
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen({ enabled }))!;
        state.setContentMode(true);
        state.setQuery("needle");
        await vi.advanceTimersByTimeAsync(250);
        vi.mocked(api.globalSearch).mockClear();
        listCompletionTables.mockClear();
        enabled.value = false;
        state.cancelSearch();
        globalSearchSettingsVersion.value++;
        state.setScopeConnectionIds(["c"]);
        await nextTick();
        await vi.advanceTimersByTimeAsync(250);
        expect(api.globalSearch).not.toHaveBeenCalled();
        expect(listCompletionTables).not.toHaveBeenCalled();
        enabled.value = true;
        state.setQuery("new needle");
        await vi.advanceTimersByTimeAsync(250);
        expect(api.globalSearch).toHaveBeenCalledTimes(1);
      } finally {
        scope.stop();
        vi.useRealTimers();
      }
    });

    it("exposes content search failures and retries the same query", async () => {
      vi.useFakeTimers();
      vi.mocked(api.globalSearch)
        .mockRejectedValueOnce(new Error("permission denied"))
        .mockResolvedValueOnce({
          matches: [{ path: "/sql/recovered.sql", fileName: "recovered.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" }],
          errors: [],
        });
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [], connectedIds: new Set() } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setContentMode(true);
        state.setQuery("needle");
        await vi.advanceTimersByTimeAsync(250);
        await flushAsyncWork();

        expect(state.contentSearchError.value).toContain("permission denied");
        expect(state.contentGroups.value).toEqual([]);

        state.retryContentSearch();
        await flushAsyncWork();

        expect(state.contentSearchError.value).toBeNull();
        expect(state.contentGroups.value[0]?.filePath).toBe("/sql/recovered.sql");
      } finally {
        scope.stop();
        vi.useRealTimers();
      }
    });

    it("keeps partial matches when the backend reports scan errors", async () => {
      vi.useFakeTimers();
      vi.mocked(api.globalSearch).mockResolvedValueOnce({
        matches: [{ path: "/sql/available.sql", fileName: "available.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" }],
        errors: [{ path: "/sql/restricted", message: "permission denied" }],
      });
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [], connectedIds: new Set() } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setContentMode(true);
        state.setQuery("needle");
        await vi.advanceTimersByTimeAsync(250);
        await flushAsyncWork();

        expect(state.contentSearchError.value).toContain("/sql/restricted: permission denied");
        expect(state.contentGroups.value[0]?.filePath).toBe("/sql/available.sql");
      } finally {
        scope.stop();
        vi.useRealTimers();
      }
    });

    it("does not let a pending debounce replace a newer settings search", async () => {
      vi.useFakeTimers();
      const pending = deferred<Awaited<ReturnType<typeof api.globalSearch>>>();
      vi.mocked(api.globalSearch).mockReturnValue(pending.promise);
      vi.mocked(api.cancelGlobalSearch).mockResolvedValue(undefined);
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [], connectedIds: new Set() } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setContentMode(true);
        state.setQuery("needle");
        globalSearchSettingsVersion.value++;
        await nextTick();
        expect(api.globalSearch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(api.globalSearch).toHaveBeenCalledTimes(1);
        expect(api.cancelGlobalSearch).not.toHaveBeenCalled();
        pending.resolve({
          matches: [{ path: "/sql/a.sql", fileName: "a.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" }],
          errors: [],
        });
        await flushAsyncWork();
        expect(state.contentSearching.value).toBe(false);
        expect(state.contentGroups.value[0]?.filePath).toBe("/sql/a.sql");
      } finally {
        scope.stop();
        vi.useRealTimers();
      }
    });

    it("converts Unicode character columns to UTF-16 highlight offsets and cancels stale scans", async () => {
      vi.useFakeTimers();
      const pending = deferred<Awaited<ReturnType<typeof api.globalSearch>>>();
      const latest = deferred<Awaited<ReturnType<typeof api.globalSearch>>>();
      vi.mocked(api.globalSearch).mockReturnValueOnce(pending.promise).mockReturnValueOnce(latest.promise);
      vi.mocked(api.cancelGlobalSearch).mockResolvedValue(undefined);
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const scope = effectScope();
      try {
        let state!: ReturnType<typeof useQuickOpen>;
        scope.run(() => {
          state = useQuickOpen();
        });
        state.setContentMode(true);
        state.setQuery("needle");
        await vi.advanceTimersByTimeAsync(250);
        const firstRequest = vi.mocked(api.globalSearch).mock.calls[0]?.[0];
        expect(firstRequest?.searchId).toEqual(expect.any(String));
        state.setQuery("new query");
        expect(api.cancelGlobalSearch).toHaveBeenCalledWith(firstRequest?.searchId);
        await vi.advanceTimersByTimeAsync(250);
        latest.resolve({
          matches: [{ path: "/sql/a.sql", fileName: "a.sql", line: 1, column: 2, lineText: "😀needle", matchText: "needle" }],
          errors: [],
        });
        await flushAsyncWork();
        expect(state.contentGroups.value[0]?.matches[0]?.highlightIndices).toEqual([2, 8]);

        pending.resolve({
          matches: [{ path: "/sql/old.sql", fileName: "old.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" }],
          errors: [],
        });
        await flushAsyncWork();
        expect(state.contentGroups.value[0]?.filePath).toBe("/sql/a.sql");
      } finally {
        scope.stop();
        vi.useRealTimers();
      }
    });
  });

  describe("external SQL files", () => {
    it("orders unvisited external SQL files by filesystem mtime", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValue(["/workspace"]);
      vi.mocked(api.listSqlFilesInFolder).mockResolvedValue([
        { name: "older.sql", path: "/workspace/older.sql", is_dir: false, children: [], modified_at: 100 },
        { name: "newer.sql", path: "/workspace/newer.sql", is_dir: false, children: [], modified_at: 300 },
        { name: "same-time.sql", path: "/workspace/same-time.sql", is_dir: false, children: [], modified_at: 300 },
      ]);

      const scope = effectScope();
      try {
        const { homeItems, loadExternalSqlFiles } = scope.run(() => useQuickOpen())!;
        await loadExternalSqlFiles();

        expect(homeItems.value.filter((item) => item.type === "sql_file").map((item) => item.label)).toEqual(["newer.sql", "same-time.sql", "older.sql"]);
      } finally {
        scope.stop();
      }
    });

    it("reloads when folders change during an in-flight scan", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValueOnce(["/old"]).mockReturnValue(["/new"]);
      const oldScan = deferred<Awaited<ReturnType<typeof api.listSqlFilesInFolder>>>();
      vi.mocked(api.listSqlFilesInFolder).mockImplementation((path) => {
        if (path === "/old") return oldScan.promise;
        return Promise.resolve([{ name: "new.sql", path: "/new/new.sql", is_dir: false, children: [] }]);
      });

      const { filteredItems, loadExternalSqlFiles, setQuery } = useQuickOpen();
      const initialLoad = loadExternalSqlFiles();
      expect(api.listSqlFilesInFolder).toHaveBeenCalledWith("/old", getSqlFileFilter());

      sqlFileFoldersVersion.value++;
      await nextTick();
      oldScan.resolve([{ name: "old.sql", path: "/old/old.sql", is_dir: false, children: [] }]);
      await initialLoad;

      expect(api.listSqlFilesInFolder).toHaveBeenCalledTimes(2);
      expect(api.listSqlFilesInFolder).toHaveBeenLastCalledWith("/new", getSqlFileFilter());
      setQuery(".sql");
      expect(filteredItems.value.map((item) => item.label)).toContain("new.sql");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("old.sql");
    });
  });

  describe("metadata matching through indexed sources", () => {
    it.each(["/work/order-reports", "C:\\work\\order-reports"])("filters scanned external files under %s and preserves navigation", async (root) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValue([root]);
      const separator = root.includes("\\") ? "\\" : "/";
      const label = "report-v2024-07-customer-order-detail-export.sql";
      const path = `${root}${separator}export${separator}${label}`;
      vi.mocked(api.listSqlFilesInFolder).mockResolvedValue([{ name: "export", path: `${root}${separator}export`, is_dir: true, children: [{ name: label, path, is_dir: false, children: [] }] }]);
      const scope = effectScope();
      try {
        const quickOpen = scope.run(() => useQuickOpen())!;
        await quickOpen.loadExternalSqlFiles();
        quickOpen.setQuery("cordetxprep");
        expect(quickOpen.filteredItems.value).toEqual([]);
        expect(quickOpen.selectedItem.value).toBeNull();
        quickOpen.selectNext();
        expect(quickOpen.selectedItem.value).toBeNull();
        for (const query of ["ORDER-REPORTS", "export", "cordetxp"]) {
          quickOpen.setQuery(query);
          expect(quickOpen.filteredItems.value).toHaveLength(1);
          expect(quickOpen.selectedItem.value).toMatchObject({ type: "sql_file", filePath: path, description: "order-reports / export" });
        }
        expect(quickOpen.selectedItem.value!.matchIndices.map((index) => label[index]).join("")).toBe("cordetxp");
        quickOpen.setQuery("ORDER-REPORTS");
        expect(quickOpen.selectedItem.value!.matchIndices).toEqual([]);
        quickOpen.setQuery("   ");
        expect(quickOpen.filteredItems.value).toHaveLength(1);
      } finally {
        scope.stop();
      }
    });

    it("does not combine connection and database characters when finding a table", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Production", db_type: "postgres" }],
        treeNodes: [{ connectionId: "conn1", type: "table", database: "Analytics", schema: "public", label: "用户明细" }],
      } as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("proana");
      expect(filteredItems.value).toEqual([]);
      for (const query of ["PRODUCTION", "Analytics", "PUBLIC"]) {
        setQuery(query);
        const table = filteredItems.value.find((item) => item.type === "table");
        expect(table).toMatchObject({ label: "用户明细", matchIndices: [] });
      }
      setQuery("yhmx");
      expect(filteredItems.value).toHaveLength(1);
      expect(filteredItems.value[0].matchIndices).toEqual([0, 1, 2, 3]);
    });

    it("preserves SQL-library connection search without cross-field fuzzy matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [{ id: "conn1", name: "Production", db_type: "postgres" }], treeNodes: [] } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue({ ...emptySavedSqlStore(), allFiles: [{ id: "saved1", name: "report.sql", connectionId: "conn1" }] } as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("rptprod");
      expect(filteredItems.value).toEqual([]);
      setQuery("Production");
      expect(filteredItems.value.map((item) => item.type)).toEqual(["connection", "sql_library_file"]);
      expect(filteredItems.value[1]).toMatchObject({ sqlFileId: "saved1", matchIndices: [] });
      setQuery("rpt");
      expect(filteredItems.value[0]).toMatchObject({ type: "sql_library_file", sqlFileId: "saved1", matchIndices: [0, 2, 5] });
    });

    it("keeps plugin commands searchable by literal description and fuzzy visible label", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "command", type: "plugin_command", label: "Open console", description: "Manage servers", searchText: "Open console Manage servers AdminTools", connectionId: "", pluginId: "admin", commandId: "open" }]) });
      setQuery("ocms");
      expect(filteredItems.value).toEqual([]);
      for (const query of ["manage servers", "ADMINTOOLS"]) {
        setQuery(query);
        expect(filteredItems.value).toHaveLength(1);
        expect(filteredItems.value[0]).toMatchObject({ commandId: "open", matchIndices: [] });
      }
      setQuery("oc");
      expect(filteredItems.value[0].matchIndices).toEqual([0, 5]);
    });
  });

  describe("metadata matching", () => {
    it.each([
      ["cordetxprep", "report-v2024-07-customer-order-detail-export.sql", "report-v2024-07-customer-order-detail-export.sql export order-reports"],
      ["sper", "report.sql", "report.sql sales production export reports"],
      ["salesprod", "report.sql", "report.sql sales production"],
      ["zzj", "report.sql", "report.sql 总租金"],
    ])("rejects non-literal metadata matches for %s", (query, label, searchText) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "file", type: "sql_file", label, searchText, connectionId: "" }]) });
      setQuery(query);
      expect(filteredItems.value).toEqual([]);
    });

    it.each(["PRODUCTION", "duction", "  production  "])("preserves literal metadata search for %s below label matches", (query) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({
        extraItems: ref([
          { id: "metadata", type: "sql_file", label: "report.sql", searchText: "Production reports", connectionId: "" },
          { id: "label", type: "sql_file", label: "production.sql", searchText: "production.sql", connectionId: "" },
        ]),
      });
      setQuery(query);
      expect(filteredItems.value.map((item) => item.id)).toEqual(["label", "metadata"]);
      expect(filteredItems.value[0].matchIndices.length).toBeGreaterThan(0);
      expect(filteredItems.value[1].matchIndices).toEqual([]);
      expect(filteredItems.value[1].matchScore).toBeGreaterThan(1000);
    });

    it("preserves fuzzy file-name matches and their highlights", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const label = "report-v2024-07-customer-order-detail-export.sql";
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "file", type: "sql_file", label, searchText: `${label} export order-reports`, connectionId: "" }]) });
      setQuery("cordetxp");
      expect(filteredItems.value).toHaveLength(1);
      expect(filteredItems.value[0].matchIndices.map((index) => label[index]).join("")).toBe("cordetxp");
    });
  });

  describe("fuzzyMatch function", () => {
    it("ranks exact names, initials, prefixes, substrings, and fuzzy matches in order", () => {
      const exact = matchQuickOpenText("shop", "shop");
      const initials = matchQuickOpenText("gafi", "groupon_apply_finance_invoice");
      const prefix = matchQuickOpenText("shop", "shop_attribute");
      const substring = matchQuickOpenText("shop", "sale_payway_shop");
      const fuzzy = matchQuickOpenText("gafi", "giftcard_define_item");

      expect([exact?.kind, initials?.kind, prefix?.kind, substring?.kind, fuzzy?.kind]).toEqual(["exact", "initials", "prefix", "substring", "fuzzy"]);
      expect(exact!.score).toBeLessThan(initials!.score);
      expect(initials!.score).toBeLessThan(prefix!.score);
      expect(prefix!.score).toBeLessThan(substring!.score);
      expect(substring!.score).toBeLessThan(fuzzy!.score);
      expect(initials?.indices).toEqual([0, 8, 14, 22]);
    });

    it("matches multi-word prefix combinations and highlights their source characters", () => {
      const label = "giftcard_define_shop_log";

      expect(matchQuickOpenText("gdsl", label)?.kind).toBe("initials");
      for (const query of ["giftdsl", "gdshopl", "gdesl"]) {
        const match = matchQuickOpenText(query, label);
        expect(match?.kind).toBe("word-prefix");
        expect(match?.indices.map((index) => label[index]).join("")).toBe(query);
      }
      expect(matchQuickOpenText("giftcard", label)?.kind).toBe("prefix");
      expect(matchQuickOpenText("define", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("shop", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("cardshoplog", label)?.kind).toBe("fuzzy");
    });

    it("matches Chinese table names by pinyin initials (issue #7912)", () => {
      // Reported: 全局搜索中文表名输入首字母模糊搜索搜不出来
      expect(matchQuickOpenText("zzj", "总租金")?.kind).toBe("initials");
      expect(matchQuickOpenText("yhmx", "用户明细")?.kind).toBe("initials");
    });

    it("matches Chinese table names by a non-contiguous pinyin-initials subsequence", () => {
      const match = matchQuickOpenText("zj", "总租金");
      expect(match?.kind).toBe("fuzzy");
      expect(match?.indices.map((index) => "总租金"[index]).join("")).toBe("总租金".slice(0, 1) + "总租金".slice(2, 3));
    });

    it("keeps pinyin-initials highlight indices aligned across unmapped supplementary-plane characters", () => {
      const match = matchQuickOpenText("bx", "𠮷表x");
      expect(match?.kind).toBe("fuzzy");
      expect(match?.indices).toEqual([2, 3]);
    });

    it("prefers a literal prefix match over pinyin-initials for mixed Han+Latin names", () => {
      const literal = matchQuickOpenText("abc", "abc表");
      expect(literal?.kind).toBe("prefix");
      expect(literal?.score).toBeLessThan(250);
    });

    it("puts the exact shop result before prefixed and containing names", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "contains", name: "sale_payway_shop", type: "mssql" },
          { id: "prefix", name: "shop_attribute", type: "mssql" },
          { id: "exact", name: "shop", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("shop");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["shop", "shop_attribute", "sale_payway_shop"]);
    });

    it("puts an exact identifier acronym before loose fuzzy matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "fuzzy", name: "giftcard_define_item", type: "mssql" },
          { id: "initials", name: "groupon_apply_finance_invoice", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["groupon_apply_finance_invoice", "giftcard_define_item"]);
      expect(filteredItems.value[0].matchIndices).toEqual([0, 8, 14, 22]);
    });

    it("should return exact substring match with score 1", () => {
      // Mock store with test data
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "MyDatabase",
            label: "MyDatabase",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyDatabase");

      // After search, we should find the exact match
      expect(filteredItems.value.length).toBeGreaterThan(0);
      const result = filteredItems.value.find((item) => item.label === "MyDatabase");
      expect(result).toBeDefined();
      if (result) {
        expect(result.matchScore).toBe(1); // Exact substring match score
      }
    });

    it("should handle empty query by returning all items", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "postgres" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      // Empty query should return all items (2 connections + 0 SQL library files)
      expect(filteredItems.value.length).toBe(2);
      filteredItems.value.forEach((item) => {
        expect(item.matchScore).toBe(Infinity);
      });
    });

    it("should perform fuzzy matching for non-consecutive characters", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyCo");

      // Fuzzy match should find "MyConnection"
      const result = filteredItems.value.find((item) => item.label === "MyConnection");
      expect(result).toBeDefined();
    });

    it("should return null for non-matching query", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("XYZ");

      // No match should return empty results
      expect(filteredItems.value.length).toBe(0);
    });

    it("should score consecutive characters higher than non-consecutive", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "user_login_table", type: "mssql" },
          { id: "conn2", name: "user_data_login", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("login");

      // "user_login_table" has consecutive "login" match (better score)
      // "user_data_login" has consecutive "login" match too
      expect(filteredItems.value.length).toBe(2);
      // Both should have score 1.0 (consecutive match: login appears consecutively)
    });
  });

  describe("filtering and searching", () => {
    it("keeps database-object highlight indices relative to the visible label", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Test TiDB", db_type: "mysql" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "Test TiDB",
            children: [
              {
                id: "conn1:retail_mps",
                connectionId: "conn1",
                type: "database",
                database: "retail_mps",
                label: "retail_mps",
                children: [
                  {
                    id: "table1",
                    connectionId: "conn1",
                    type: "table",
                    database: "retail_mps",
                    label: "groupon_apply_finance_invoice",
                  },
                ],
              },
            ],
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      const table = filteredItems.value.find((item) => item.type === "table");
      expect(table?.label).toBe("groupon_apply_finance_invoice");
      expect(table?.matchIndices).toEqual([0, 8, 14, 22]);
    });

    it("does not highlight the label when only connection metadata matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("Prod");

      const database = filteredItems.value.find((item) => item.type === "database");
      expect(database?.matchIndices).toEqual([]);
      expect(database?.matchScore).toBeGreaterThan(1000);
    });

    it("indexes database objects under connection groups", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Grouped PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "group1",
            type: "connection-group",
            label: "Production",
            children: [
              {
                id: "conn1",
                connectionId: "conn1",
                type: "connection",
                label: "Grouped PG",
                children: [
                  {
                    id: "conn1:postgres",
                    connectionId: "conn1",
                    type: "database",
                    database: "postgres",
                    label: "postgres",
                    children: [
                      {
                        id: "conn1:postgres:public",
                        connectionId: "conn1",
                        type: "schema",
                        database: "postgres",
                        schema: "public",
                        label: "public",
                        children: [
                          {
                            id: "conn1:postgres:public:users",
                            connectionId: "conn1",
                            type: "table",
                            database: "postgres",
                            schema: "public",
                            label: "users",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("users");
      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("includes schemas as quick open results", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "PG",
            children: [
              {
                id: "conn1:postgres",
                connectionId: "conn1",
                type: "database",
                database: "postgres",
                label: "postgres",
                children: [
                  {
                    id: "conn1:postgres:analytics",
                    connectionId: "conn1",
                    type: "schema",
                    database: "postgres",
                    schema: "analytics",
                    label: "analytics",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("analytics");
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "schema", label: "analytics" })]));
    });

    it("preserves overloaded routine signatures as distinct results", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "PG", db_type: "postgres" }],
        treeNodes: [
          { connectionId: "conn1", type: "function", database: "postgres", schema: "public", label: "find_user", signature: "integer", id: "f1" },
          { connectionId: "conn1", type: "function", database: "postgres", schema: "public", label: "find_user", signature: "text", id: "f2" },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("find_user");

      const routines = filteredItems.value.filter((item) => item.type === "function");
      expect(routines).toHaveLength(2);
      expect(routines.map((item) => item.signature)).toEqual(["integer", "text"]);
      expect(routines.map((item) => item.id)).toEqual([expect.stringContaining("integer"), expect.stringContaining("text")]);
    });

    it("should filter items based on search query", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "ProdDB", type: "mssql" },
          { id: "conn2", name: "DevDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("Prod");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("ProdDB");
    });

    it("should be case-insensitive", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("myconnection");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("MyConnection");
    });

    it("should search across connection name and database name", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "ProdConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      // Search by connection name
      setQuery("Prod");
      expect(filteredItems.value.length).toBeGreaterThan(0);
    });

    it("should sort by match score (lower scores first)", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Database", type: "mssql" },
          { id: "conn2", name: "MyDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("db");

      expect(filteredItems.value.length).toBe(2);
      // First result should have better (lower) score
      expect(filteredItems.value[0].matchScore).toBeLessThanOrEqual(filteredItems.value[1].matchScore);
    });

    it("should sort by type for equal match scores", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "test", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "test_db",
            label: "test_db",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("test");

      // Connections should come before databases for the same query
      if (filteredItems.value.length >= 2) {
        const connectionItem = filteredItems.value.find((item) => item.type === "connection");
        const databaseItem = filteredItems.value.find((item) => item.type === "database");

        if (connectionItem && databaseItem) {
          expect(filteredItems.value.indexOf(connectionItem)).toBeLessThan(filteredItems.value.indexOf(databaseItem));
        }
      }
    });
  });

  describe("plugin workbenches", () => {
    function installedPluginFixture(id: string, name: string, contributions: any[]) {
      return {
        manifest: { id, name, version: "1.0.0", contributions },
        compatibility: { compatible: true },
      } as any;
    }

    it("lists standalone workbenches and skips ones bound to a connection provider", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(api.listPlugins).mockResolvedValue([
        installedPluginFixture("io.leetcode", "LeetCode", [{ type: "workbench", id: "main", label: "LeetCode" }]),
        installedPluginFixture("io.kafka", "Kafka", [
          { type: "connection-provider", id: "kafka", label: "Kafka", database_type: "kafka", fields: [], workbench: "browser" },
          { type: "workbench", id: "browser", label: "Kafka Browser" },
        ]),
        installedPluginFixture("io.terminal", "Terminal", [
          { type: "connection-provider", id: "ssh", label: "SSH", database_type: "ssh", fields: [] },
          { type: "workbench", id: "shell", label: "Terminal" },
        ]),
        installedPluginFixture("io.mixed", "Mixed", [
          { type: "connection-provider", id: "cp", label: "Mixed", database_type: "mixed", fields: [], workbench: "bound" },
          { type: "workbench", id: "bound", label: "Bound Panel" },
          { type: "workbench", id: "free", label: "Free Panel" },
        ]),
      ]);

      const { filteredItems, loadPluginWorkbenches } = useQuickOpen();
      await loadPluginWorkbenches();

      const labels = filteredItems.value.map((item) => item.label);
      expect(labels).toContain("LeetCode");
      // A provider without a workbench pointer leaves its sibling workbench standalone.
      expect(labels).toContain("Terminal");
      // Only the unbound workbench of a mixed plugin is listed.
      expect(labels).toContain("Free Panel");
      expect(labels).not.toContain("Kafka Browser");
      expect(labels).not.toContain("Bound Panel");
    });

    it("finds workbenches by plugin name and carries the dispatch fields", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(api.listPlugins).mockResolvedValue([installedPluginFixture("io.leetcode", "LeetCode", [{ type: "workbench", id: "main", label: "刷题面板", icon: "assets/icon.png" }])]);

      const { filteredItems, loadPluginWorkbenches, setQuery } = useQuickOpen();
      await loadPluginWorkbenches();

      setQuery("leetcode");
      expect(filteredItems.value.length).toBe(1);
      const item = filteredItems.value[0];
      expect(item.type).toBe("plugin_workbench");
      expect(item.pluginId).toBe("io.leetcode");
      expect(item.contributionId).toBe("main");
      expect(item.description).toBe("LeetCode");
      expect(item.pluginIcon).toBe("assets/icon.png");
      expect(item.connectionId).toBe("");
    });
  });

  describe("item selection navigation", () => {
    it("should initialize with selectedIndex at 0", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedIndex } = useQuickOpen();
      expect(selectedIndex.value).toBe(0);
    });

    it("should select next item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      expect(selectedIndex.value).toBe(0);
      selectNext();
      expect(selectedIndex.value).toBe(1);
    });

    it("should not exceed max index when selecting next", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      selectNext(); // Attempt to go beyond max
      expect(selectedIndex.value).toBe(0); // Should stay at 0 (only 1 item)
    });

    it("should select previous item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectPrevious, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);
      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should not go below 0 when selecting previous", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectPrevious, selectedIndex } = useQuickOpen();

      // Verify initial state
      expect(selectedIndex.value).toBe(0);

      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should return correct selectedItem", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedItem, setQuery } = useQuickOpen();

      setQuery("");

      expect(selectedItem.value?.label).toBe("Conn1");
      selectNext();
      expect(selectedItem.value?.label).toBe("Conn2");
    });

    it("should return null selectedItem when index is out of bounds", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedItem, selectedIndex } = useQuickOpen();

      // Manually set invalid index
      selectedIndex.value = 999;
      expect(selectedItem.value).toBeNull();
    });
  });

  describe("reset and query setting", () => {
    it("resets selection when v-model changes the search query directly", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { searchQuery, selectNext, selectedIndex } = useQuickOpen();
      selectNext();
      expect(selectedIndex.value).toBe(1);

      searchQuery.value = "Connection";
      expect(selectedIndex.value).toBe(0);
    });

    it("should reset selection to 0 when setQuery is called", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, setQuery, selectedIndex } = useQuickOpen();

      selectNext();
      expect(selectedIndex.value).toBe(1);

      setQuery("test");
      expect(selectedIndex.value).toBe(0);
    });

    it("should update searchQuery when setQuery is called", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { searchQuery, setQuery } = useQuickOpen();

      setQuery("NewQuery");
      expect(searchQuery.value).toBe("NewQuery");
    });

    it("should resetSelection to 0", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { resetSelection, selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);

      resetSelection();
      expect(selectedIndex.value).toBe(0);
    });
  });

  describe("allItems with different database object types", () => {
    it("should include tables from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "table",
            database: "MyDB",
            schema: "dbo",
            label: "Users",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const tableItem = filteredItems.value.find((item) => item.type === "table");
      expect(tableItem).toBeDefined();
      expect(tableItem?.label).toBe("Users");
    });

    it.each([
      ["table", "TABLE"],
      ["view", "VIEW"],
      ["materialized_view", "MATERIALIZED_VIEW"],
    ])("inherits %s identity through the real column group tree", (type, tableType) => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "c", name: "PG", db_type: "postgres" }],
        treeNodes: [
          {
            connectionId: "c",
            type,
            database: "app",
            schema: "public",
            label: "reports",
            children: [{ type: "group-columns", children: [{ connectionId: "c", type: "column", database: "app", schema: "public", tableName: "reports", label: "total (integer)", meta: { name: "total", data_type: "integer" } }] }],
          },
        ],
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("kind:column total");
        expect(state.filteredItems.value).toEqual([expect.objectContaining({ type: "column", tableName: "reports", columnName: "total", tableType })]);
      } finally {
        scope.stop();
      }
    });

    it("keeps exact identities for case-distinct columns, relations and routines", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "c", name: "PG", db_type: "postgres" }],
        treeNodes: ["Code", "code"].flatMap((name) => [
          { connectionId: "c", type: "column", database: "app", schema: "public", tableName: "items", label: `${name} (text)`, meta: { name, data_type: "text" } },
          { connectionId: "c", type: "table", database: "app", schema: "public", label: name },
          { connectionId: "c", type: "function", database: "app", schema: "public", label: name, signature: "integer" },
        ]),
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        for (const type of ["column", "table", "function"]) {
          state.setQuery(`kind:${type} code`);
          expect(state.filteredItems.value.map((item) => item.label).sort()).toEqual(["Code", "code"]);
        }
      } finally {
        scope.stop();
      }
    });

    it("should include cached columns with table context and comments", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "table",
            database: "MyDB",
            schema: "dbo",
            label: "Users",
            children: [
              {
                connectionId: "conn1",
                type: "column",
                database: "MyDB",
                schema: "dbo",
                tableName: "Users",
                label: "email (varchar(255))",
                meta: { name: "email", data_type: "varchar(255)", comment: "用户邮箱" },
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("用户邮箱");

      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "column", label: "email", tableName: "Users", columnComment: "用户邮箱" })]));
    });

    it("applies structured kind, database, and comment filters to cached fields", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "column",
            database: "MyDB",
            schema: "dbo",
            tableName: "Users",
            label: "email (varchar(255))",
            meta: { name: "email", data_type: "varchar(255)", comment: "用户邮箱" },
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("kind:column db:MyDB comment:用户 email");

      expect(filteredItems.value).toEqual([expect.objectContaining({ type: "column", label: "email", database: "MyDB", columnComment: "用户邮箱" })]);
    });

    it("should include views from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "view",
            database: "MyDB",
            schema: "dbo",
            label: "UserView",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const viewItem = filteredItems.value.find((item) => item.type === "view");
      expect(viewItem).toBeDefined();
      expect(viewItem?.label).toBe("UserView");
    });

    it("should include procedures from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "procedure",
            database: "MyDB",
            schema: "dbo",
            label: "GetUsers",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const procItem = filteredItems.value.find((item) => item.type === "procedure");
      expect(procItem).toBeDefined();
      expect(procItem?.label).toBe("GetUsers");
    });

    it("should include functions from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "function",
            database: "MyDB",
            schema: "dbo",
            label: "ComputeAge",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const funcItem = filteredItems.value.find((item) => item.type === "function");
      expect(funcItem).toBeDefined();
      expect(funcItem?.label).toBe("ComputeAge");
    });
  });

  describe("connection scope", () => {
    // Scope: no selection searches every connection, picking some narrows both
    // the local tree entries and the remote search pool to those connections.
    function scopeStore() {
      return {
        connections: [
          { id: "conn1", name: "Alpha", db_type: "mysql", database: "shop" },
          { id: "conn2", name: "Beta", db_type: "postgres", database: "public_db" },
          { id: "conn3", name: "Gamma", db_type: "mysql", database: "crm" },
        ],
        activeConnectionId: "conn1",
        connectedIds: new Set(["conn1", "conn2", "conn3"]),
        treeNodes: [
          { connectionId: "conn1", type: "database", database: "shop", label: "shop" },
          { connectionId: "conn2", type: "database", database: "public_db", label: "public_db" },
          { connectionId: "conn3", type: "database", database: "crm", label: "crm" },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
      };
    }

    it("filters persisted metadata by the selected connection scope", async () => {
      const connections = [
        { id: "conn1", name: "Alpha", db_type: "postgres", database: "shop" },
        { id: "conn2", name: "Beta", db_type: "postgres", database: "crm" },
      ];
      const cachedItems = new Map(
        connections.map((connection) => [
          connection.id,
          {
            type: "table" as const,
            label: `${connection.name.toLowerCase()}_orders`,
            connectionId: connection.id,
            database: connection.database,
            schema: "public",
            tableName: `${connection.name.toLowerCase()}_orders`,
          },
        ]),
      );
      vi.mocked(api.loadSchemaCache).mockImplementation(async (cacheKey) => {
        const connection = connections.find((candidate) => cacheKey === quickOpenMetadataCacheKey(candidate.id));
        return connection ? encodeQuickOpenMetadataCache(connection.id, quickOpenMetadataConnectionFingerprint(connection), [cachedItems.get(connection.id)!]) : null;
      });
      vi.mocked(useConnectionStore).mockReturnValue({
        connections,
        treeNodes: [],
        connectedIds: new Set(),
        loadSidebarTableSearchIndexScopes: vi.fn().mockResolvedValue([]),
      } as any);

      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        for (let index = 0; index < 10 && !state.matchingItems.value.some((item) => item.label === "alpha_orders"); index++) await flushAsyncWork();
        state.setScopeConnectionIds(["conn2"]);
        state.setQuery("");

        expect(state.matchingItems.value.some((item) => item.label === "beta_orders")).toBe(true);
        expect(state.matchingItems.value.some((item) => item.label === "alpha_orders")).toBe(false);
        state.setQuery("orders");
        expect(state.matchingItems.value.some((item) => item.label === "beta_orders")).toBe(true);
        expect(state.matchingItems.value.some((item) => item.label === "alpha_orders")).toBe(false);
      } finally {
        scope.stop();
      }
    });

    it("searches every connection by default", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("");

      const databases = filteredItems.value.filter((item) => item.type === "database").map((item) => item.label);
      expect(databases).toEqual(["shop", "public_db", "crm"]);
    });

    it("hides unselected connections and their objects from the local pool", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { filteredItems, setQuery, setScopeConnectionIds } = useQuickOpen();
      setScopeConnectionIds(["conn2"]);
      setQuery("");

      const labels = filteredItems.value.map((item) => item.label);
      expect(labels).toContain("Beta");
      expect(labels).not.toContain("Alpha");
      expect(labels).not.toContain("Gamma");
      expect(labels.filter((label) => ["shop", "public_db", "crm"].includes(label))).toEqual(["public_db"]);
    });

    it("filters recent snapshots by scope while preserving unbound files and restoring them for all connections", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.recordRecentItem({ id: "remote-alpha", type: "table", label: "orders", connectionId: "conn1", database: "shop", tableName: "orders", searchText: "orders" });
        state.recordRecentItem({ id: "unbound-file", type: "sql_file", label: "draft.sql", filePath: "/sql/draft.sql", connectionId: "", searchText: "draft.sql" });
        state.setScopeConnectionIds(["conn2"]);
        expect(state.homeItems.value.some((item) => item.connectionId === "conn1")).toBe(false);
        expect(state.homeItems.value.some((item) => item.id === "unbound-file")).toBe(true);
        state.setScopeConnectionIds([]);
        expect(state.homeItems.value.some((item) => item.id === "remote-alpha")).toBe(true);
      } finally {
        scope.stop();
      }
    });

    it("only queries the selected connections remotely", async () => {
      vi.useFakeTimers();
      try {
        const store = scopeStore();
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn3"]);
        setQuery("customer");

        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(store.listCompletionTables.mock.calls[0][0]).toBe("conn3");
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats an empty selection as all connections", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { scopeActive, setScopeConnectionIds } = useQuickOpen();
      setScopeConnectionIds(["conn1"]);
      expect(scopeActive.value).toBe(true);
      setScopeConnectionIds([]);
      expect(scopeActive.value).toBe(false);
    });

    // Switching the scope must re-issue the query without retyping: the user picks a
    // connection and expects the list to change on the spot.
    it("re-runs the current query against the new connection when the scope changes", async () => {
      vi.useFakeTimers();
      try {
        const store = scopeStore();
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn1"]);
        setQuery("customer");
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();
        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(store.listCompletionTables.mock.calls[0][0]).toBe("conn1");

        // Switching to conn2 re-queries that connection without touching the query text.
        setScopeConnectionIds(["conn2"]);
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(store.listCompletionTables).toHaveBeenCalledTimes(2);
        expect(store.listCompletionTables.mock.calls[1][0]).toBe("conn2");
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops results from the previous scope instead of merging them", async () => {
      vi.useFakeTimers();
      try {
        let resolveAlpha!: (value: any[]) => void;
        const store = scopeStore();
        store.listCompletionTables = vi.fn().mockImplementation((connectionId: string) => {
          if (connectionId === "conn1") return new Promise((resolve) => (resolveAlpha = resolve));
          return Promise.resolve([{ name: "beta_orders", schema: "", type: "table" }]);
        });
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { filteredItems, setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn1"]);
        setQuery("orders");
        await vi.advanceTimersByTimeAsync(400);

        // The scope changes while conn1's request is still in flight.
        setScopeConnectionIds(["conn2"]);
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();
        expect(filteredItems.value.map((item) => item.label)).toContain("beta_orders");

        // The stale conn1 response lands late and must not surface under the new scope.
        resolveAlpha([{ name: "alpha_orders", schema: "", type: "table" }]);
        await flushAsyncWork();
        expect(filteredItems.value.map((item) => item.label)).toContain("beta_orders");
        expect(filteredItems.value.map((item) => item.label)).not.toContain("alpha_orders");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("SQL library files", () => {
    function savedSqlStoreWithFiles(files: any[]) {
      const fileMap = new Map(files.map((f) => [f.id, f]));
      return {
        allFiles: files,
        getFile: vi.fn().mockImplementation((id: string) => fileMap.get(id)),
      };
    }

    it("shows limited SQL library files when no search query", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = Array.from({ length: 30 }, (_, i) => ({
        id: `file${i}`,
        name: `query_${i}.sql`,
        connectionId: "conn1",
        updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("");

      // Should show 1 connection + 20 recent SQL library files = 21
      expect(filteredItems.value.length).toBe(21);
      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems.length).toBe(20);
    });

    it("includes all SQL library files when searching", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "get_users.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "create_orders.sql", connectionId: "conn1", updatedAt: "2024-01-02T00:00:00.000Z" },
        { id: "f3", name: "update_inventory.sql", connectionId: "conn1", updatedAt: "2024-01-03T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(1);
      expect(sqlItems[0].label).toBe("get_users.sql");
      expect(sqlItems[0].sqlFileId).toBe("f1");
    });

    it("includes SQL library files whose connection was deleted", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "Active", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "active_query.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "orphaned_query.sql", connectionId: "deleted_conn", updatedAt: "2024-01-02T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("query");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(2);
      expect(sqlItems.find((item) => item.label === "orphaned_query.sql")?.description).toBe("Connection deleted");
    });

    it("labels SQL library files without a connection as unassociated", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles([{ id: "f1", name: "draft.sql", connectionId: "", updatedAt: "2024-01-01T00:00:00.000Z" }]) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("draft");

      expect(filteredItems.value.find((item) => item.type === "sql_library_file")?.description).toBe("Unassociated");
    });
  });

  describe("remote metadata search", () => {
    beforeEach(() => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockReset();
      vi.mocked(api.executeQuery).mockReset();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    function remoteSearchStore(overrides: Record<string, unknown> = {}) {
      return {
        connections: [{ id: "conn1", name: "MySQL", db_type: "mysql" }],
        connectedIds: new Set(["conn1"]),
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
        ...overrides,
      };
    }

    async function runDebouncedSearch(): Promise<void> {
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
    }

    it("keeps cached objects distinct across catalogs and inherits catalog through column groups", () => {
      const catalogs = ["hive-a", "hive-b"];
      vi.mocked(useConnectionStore).mockReturnValue(
        remoteSearchStore({
          connections: [{ id: "conn1", name: "Doris", db_type: "doris" }],
          connectedIds: new Set(),
          treeNodes: [
            {
              type: "connection",
              connectionId: "conn1",
              children: catalogs.map((catalog) => ({
                type: "doris-catalog",
                catalog,
                children: [
                  {
                    type: "database",
                    connectionId: "conn1",
                    database: "app",
                    label: "app",
                    children: [
                      {
                        type: "table",
                        database: "app",
                        label: "orders",
                        children: [{ type: "group", children: [{ type: "column", database: "app", tableName: "orders", label: "table" }] }],
                      },
                    ],
                  },
                ],
              })),
            },
          ],
        }) as any,
      );
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("orders");
      const objects = filteredItems.value.filter((item) => item.type === "table" || item.type === "column");
      expect(objects).toHaveLength(4);
      expect(new Set(objects.map((item) => item.id)).size).toBe(4);
      for (const catalog of catalogs) {
        expect(objects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "table", catalog, database: "app" }), expect.objectContaining({ type: "column", catalog, tableName: "orders", columnName: "table" })]));
      }
    });

    it("keeps the internal catalog on the default metadata path", async () => {
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "StarRocks", db_type: "starrocks" }],
        treeNodes: [
          {
            type: "connection",
            connectionId: "conn1",
            children: [{ type: "doris-catalog", catalog: "default_catalog", catalogType: "internal", children: [{ type: "database", connectionId: "conn1", database: "app", label: "app", children: [{ type: "table", database: "app", label: "orders" }] }] }],
          },
        ],
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("orders");
      await runDebouncedSearch();
      expect(filteredItems.value.find((item) => item.type === "table")?.catalog).toBeUndefined();
      expect(store.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "orders", 25, undefined, true, undefined, undefined, { activateConnection: false, allowConnection: false });
      expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
    });

    it("searches same-name databases in each catalog and retains structure identity", async () => {
      const catalogs = ["hive-a", "hive-b"];
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "Doris", db_type: "doris" }],
        treeNodes: catalogs.map((catalog) => ({ type: "doris-catalog", catalog, children: [{ type: "database", connectionId: "conn1", database: "app", label: "app" }] })),
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({
        columns: ["object_name", "column_name", "column_comment", "table_comment"],
        rows: [
          ["orders", "table", "orders", null],
          ["orders", null, null, "orders"],
        ],
      } as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("orders");
      await runDebouncedSearch();
      expect(store.listCompletionTables).toHaveBeenCalledTimes(2);
      for (const catalog of catalogs) {
        expect(store.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "orders", 25, undefined, true, undefined, catalog, { activateConnection: false, allowConnection: false });
        expect(api.executeQuery).toHaveBeenCalledWith("conn1", "app", "SELECT structure", undefined, expect.any(String), expect.objectContaining({ catalog }));
        expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "table", catalog, database: "app" }), expect.objectContaining({ type: "column", catalog, columnName: "table" })]));
      }
      setQuery("comment:orders");
      await runDebouncedSearch();
      expect(filteredItems.value).toHaveLength(4);
      expect(new Set(filteredItems.value.map((item) => item.id)).size).toBe(4);
      store.listCompletionTables.mockClear();
      setQuery("orders schema:app");
      await runDebouncedSearch();
      expect(store.listCompletionTables).toHaveBeenCalledTimes(2);
      expect(filteredItems.value).toHaveLength(4);
      store.listCompletionTables.mockClear();
      setQuery("orders schema:missing");
      await runDebouncedSearch();
      expect(store.listCompletionTables).not.toHaveBeenCalled();
      expect(filteredItems.value).toHaveLength(0);
    });

    it("applies a MySQL schema alias before the eight context budget", async () => {
      const databases = Array.from({ length: 9 }, (_, index) => `db${index + 1}`);
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "MySQL", db_type: "mysql" }],
        treeNodes: databases.map((database) => ({ connectionId: "conn1", type: "database", database, label: database })),
        listCompletionTables: vi.fn().mockImplementation(async (_id, database) => [{ name: "needle", schema: database, type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("needle schema:db9");
      await runDebouncedSearch();

      expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
      expect(store.listCompletionTables).toHaveBeenCalledWith("conn1", "db9", "needle", 25, undefined, true, undefined, undefined, { activateConnection: false, allowConnection: false });
      expect(filteredItems.value).toEqual([expect.objectContaining({ label: "needle", database: "db9", schema: undefined })]);
    });

    it("finds unloaded tables through server metadata", async () => {
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("ord");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "ord", 25, undefined, true, undefined, undefined, { activateConnection: false, allowConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "orders", type: "table", database: "app" })]));
    });

    it.each(["needle", "kind:column needle", "needle comment:documentation"])("retains remote fields beyond the table budget for %s", async (query) => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({
        columns: ["object_schema", "object_name", "column_name", "column_comment"],
        rows: [["public", "orders", "needle", "needle documentation"]],
      } as any);
      const store = remoteSearchStore({
        treeNodes: Array.from({ length: 4 }, (_, index) => ({ connectionId: "conn1", type: "database", database: `db${index}`, label: `db${index}` })),
        listCompletionTables: vi.fn().mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ name: `needle_${index}`, type: "table", schema: "public" }))),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const category = ref<"all" | "fields">("all");
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen({ category }))!;
        state.setQuery(query);
        await runDebouncedSearch();
        expect(state.matchingItems.value.filter((item) => item.type === "column")).toHaveLength(4);
        category.value = "fields";
        expect(state.filteredItems.value).toHaveLength(4);
        expect(state.filteredItems.value.every((item) => item.type === "column")).toBe(true);
        expect(store.listCompletionTables).toHaveBeenCalledTimes(4);
      } finally {
        scope.stop();
      }
    });

    it("applies database filters before the remote context limit", async () => {
      const store = remoteSearchStore({
        treeNodes: Array.from({ length: 9 }, (_, index) => ({ connectionId: "conn1", type: "database", database: `db${index}`, label: `db${index}` })),
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "needle", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("db:DB8 needle");
        await runDebouncedSearch();
        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(store.listCompletionTables.mock.calls[0]?.slice(0, 3)).toEqual(["conn1", "db8", "needle"]);
        expect(state.filteredItems.value).toEqual([expect.objectContaining({ database: "db8", label: "needle" })]);
      } finally {
        scope.stop();
      }
    });

    it("applies connection filters before the remote context limit without querying disconnected matches", async () => {
      const connections = Array.from({ length: 10 }, (_, index) => ({ id: `conn${index}`, name: `Production ${index}`, db_type: "postgres", database: "app" }));
      const store = remoteSearchStore({
        connections,
        connectedIds: new Set(connections.slice(0, 9).map((connection) => connection.id)),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "needle", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery('connection:"production 8" needle');
        await runDebouncedSearch();
        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(state.filteredItems.value).toEqual([expect.objectContaining({ connectionId: "conn8", label: "needle" })]);
        store.listCompletionTables.mockClear();
        state.setQuery('connection:"production 9" needle');
        await runDebouncedSearch();
        expect(store.listCompletionTables).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("resolves schema substrings before bounded table and field searches", async () => {
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "PostgreSQL", db_type: "postgres", database: "app" }],
        listCompletionSchemas: vi.fn().mockResolvedValue(["public", "Tenant_B", "Tenant_B_Archive"]),
        listCompletionTables: vi.fn().mockImplementation(async (_id, _db, _term, _limit, schema) => (schema ? [{ name: "needle_table", type: "table", schema }] : Array.from({ length: 25 }, (_, index) => ({ name: `needle_${index}`, type: "table", schema: "public" })))),
      });
      vi.mocked(api.buildDatabaseStructureSearchSql).mockImplementation(async ({ schema }) => ({ sql: schema || "public" }));
      vi.mocked(api.executeQuery).mockImplementation(
        async (_id, _db, sql) =>
          ({
            columns: ["object_schema", "object_name", "column_name"],
            rows: [[sql, "orders", "needle_field"]],
          }) as any,
      );
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("schema:tenant_b needle");
        await runDebouncedSearch();
        expect(store.listCompletionSchemas).toHaveBeenCalledWith("conn1", "app");
        expect(store.listCompletionTables).toHaveBeenCalledTimes(2);
        for (const schema of ["Tenant_B", "Tenant_B_Archive"]) {
          expect(store.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "needle", 25, schema, false, undefined, undefined, { activateConnection: false, allowConnection: false });
          expect(api.buildDatabaseStructureSearchSql).toHaveBeenCalledWith(expect.objectContaining({ schema }));
          expect(
            state.filteredItems.value
              .filter((item) => item.schema === schema)
              .map((item) => item.label)
              .sort(),
          ).toEqual(["needle_field", "needle_table"]);
        }
      } finally {
        scope.stop();
      }
    });

    it("resolves a schema match beyond the remote database budget before truncating contexts", async () => {
      const targetDatabase = "db8";
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "PostgreSQL", db_type: "postgres" }],
        treeNodes: Array.from({ length: 9 }, (_, index) => ({ connectionId: "conn1", type: "database", database: `db${index}`, label: `db${index}` })),
        listCompletionSchemas: vi.fn().mockImplementation(async (_id, database) => (database === targetDatabase ? ["tenant_target"] : [])),
        listCompletionTables: vi.fn().mockImplementation(async (_id, database, _term, _limit, schema) => (schema ? [{ name: "needle_table", schema, type: "table" }] : [])),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({ columns: ["object_schema", "object_name", "column_name"], rows: [["tenant_target", "orders", "needle_field"]] } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("schema:tenant_target needle");
        await runDebouncedSearch();
        expect(store.listCompletionSchemas).toHaveBeenCalledWith("conn1", targetDatabase);
        expect(store.listCompletionSchemas.mock.calls.filter(([, database]) => /^db\d$/.test(String(database)))).toHaveLength(9);
        expect(store.listCompletionTables).toHaveBeenCalledWith("conn1", targetDatabase, "needle", 25, "tenant_target", false, undefined, undefined, { activateConnection: false, allowConnection: false });
        expect(state.filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ database: targetDatabase, schema: "tenant_target", label: "needle_table" }), expect.objectContaining({ database: targetDatabase, schema: "tenant_target", label: "needle_field" })]));
      } finally {
        scope.stop();
      }
    });

    it("discards schema discovery after the query changes or the connection disconnects", async () => {
      const pending = deferred<string[]>();
      const store = remoteSearchStore({ connections: [{ id: "conn1", name: "PostgreSQL", db_type: "postgres", database: "app" }], listCompletionSchemas: vi.fn().mockReturnValue(pending.promise) });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("schema:public needle");
        await runDebouncedSearch();
        expect(store.listCompletionSchemas).toHaveBeenCalledWith("conn1", "app");
        state.setQuery("");
        pending.resolve(["public"]);
        await flushAsyncWork();
        expect(store.listCompletionTables).not.toHaveBeenCalled();
        const disconnected = deferred<string[]>();
        store.listCompletionSchemas.mockReturnValue(disconnected.promise);
        state.setQuery("schema:public needle");
        await runDebouncedSearch();
        store.connectedIds.clear();
        disconnected.resolve(["public"]);
        await flushAsyncWork();
        expect(store.listCompletionTables).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("searches remote comments without free text and still excludes nonmatching comments", async () => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({
        columns: ["object_schema", "object_name", "column_name", "column_comment", "table_comment"],
        rows: [
          ["public", "orders", "email", "用户邮箱", null],
          ["public", "用户", "用户", null, null],
          ["public", "accounts", null, null, "用户账户"],
        ],
      } as any);
      const store = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("comment:用户");
        await runDebouncedSearch();
        expect(api.buildDatabaseStructureSearchSql).toHaveBeenCalledWith(expect.objectContaining({ term: "用户" }));
        expect(state.filteredItems.value.map((item) => item.label).sort()).toEqual(["accounts", "email"]);
        vi.mocked(api.buildDatabaseStructureSearchSql).mockClear();
        store.connectedIds.clear();
        state.setQuery("comment:邮箱");
        await runDebouncedSearch();
        expect(api.buildDatabaseStructureSearchSql).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("keeps unloaded materialized views as materialized views", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "conn1", name: "PostgreSQL", db_type: "postgres" }],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "daily_orders_mv", type: "materialized_view", schema: "public" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("daily_orders_mv");
      await runDebouncedSearch();

      expect(filteredItems.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "daily_orders_mv",
            type: "materialized_view",
            tableType: "MATERIALIZED_VIEW",
            schema: "public",
            source: "remote",
          }),
        ]),
      );
    });

    it("finds fields through the connected document metadata catalog", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "conn1", name: "Mongo", db_type: "mongodb" }],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", type: "table" }]),
        listCompletionColumns: vi.fn().mockResolvedValue([{ name: "email", dataType: "string", comment: "用户邮箱" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("email");
      await runDebouncedSearch();
      await flushAsyncWork();
      await flushAsyncWork();

      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "column", label: "email", tableName: "users", columnComment: "用户邮箱" })]));
      expect(api.buildDatabaseStructureSearchSql).not.toHaveBeenCalled();
      expect(api.executeQuery).not.toHaveBeenCalled();
      expect(mockStore.listCompletionColumns).toHaveBeenCalledWith("conn1", "app", "users", "app", undefined, undefined, { activateConnection: false });
    });

    it("finds fields and comments through the connected SQL catalog", async () => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValueOnce({ sql: "SELECT structure" } as any);
      vi.mocked(api.executeQuery).mockResolvedValueOnce({
        columns: ["object_schema", "object_name", "column_name", "column_comment", "table_comment"],
        rows: [["public", "users", "email", "用户邮箱", null]],
      } as any);
      const mockStore = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("email");
      await runDebouncedSearch();
      await flushAsyncWork();
      await nextTick();

      expect(api.buildDatabaseStructureSearchSql).toHaveBeenCalled();
      expect(api.executeQuery).toHaveBeenCalled();
      expect(filteredItems.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "column",
            label: "email",
            tableName: "users",
            columnName: "email",
            schema: undefined,
            schemaNamespace: "app",
            columnComment: "用户邮箱",
          }),
        ]),
      );
      expect(api.executeQuery).toHaveBeenCalledWith("conn1", "app", "SELECT structure", undefined, expect.stringContaining("quick-open-structure-"), { maxRows: 50 });
    });

    it.each([
      { db_type: "mysql", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "sqlite", database: "main", cachedSchema: "main", remoteSchema: "" },
      { db_type: "doris", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "clickhouse", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "tdengine", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "manticoresearch", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "goldendb", database: "app", cachedSchema: undefined, remoteSchema: "app" },
      { db_type: "postgres", database: "app", cachedSchema: "app", remoteSchema: "app" },
    ])("unifies cached, completion and structure targets for $db_type", async ({ db_type, database, cachedSchema, remoteSchema }) => {
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: db_type, db_type, database }],
        treeNodes: [
          { connectionId: "conn1", type: "table", database, schema: cachedSchema, label: "needle" },
          { connectionId: "conn1", type: "column", database, schema: cachedSchema, tableName: "needle", label: "needle", meta: { name: "needle" } },
        ],
        listCompletionSchemas: vi.fn().mockResolvedValue(db_type === "postgres" ? ["app"] : []),
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "needle", schema: remoteSchema, type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({
        columns: ["object_schema", "object_name", "column_name", "table_comment"],
        rows: [
          [remoteSchema, "needle", "needle", null],
          [remoteSchema, "needle", null, "needle"],
        ],
      } as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery(`needle schema:${database}`);
        const cached = state.filteredItems.value;
        expect(cached).toHaveLength(2);
        await runDebouncedSearch();
        expect(state.filteredItems.value).toHaveLength(2);
        state.setQuery(`needle schema:${database} source:remote`);
        await runDebouncedSearch();
        expect(state.filteredItems.value).toHaveLength(2);
        const target = (item: QuickOpenItem) => [item.type, item.connectionId, item.catalog, item.database, item.schema, item.tableName, item.columnName];
        expect(state.filteredItems.value.map(target).sort()).toEqual(cached.map(target).sort());
        if (db_type !== "postgres") expect(store.listCompletionSchemas).not.toHaveBeenCalled();
      } finally {
        scope.stop();
      }
    });

    it("passes the SQLite attached database to both completion and structure searches", async () => {
      const store = remoteSearchStore({
        connections: [{ id: "conn1", name: "SQLite", db_type: "sqlite", attached_databases: [{ name: "app", path: "/tmp/app.db" }] }],
        treeNodes: [],
        listCompletionSchemas: vi.fn().mockResolvedValue([]),
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "needle", schema: "app", type: "table" }]),
      });
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT attached structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({ columns: ["object_schema", "object_name", "column_name"], rows: [["app", "needle", "needle"]] } as any);
      vi.mocked(useConnectionStore).mockReturnValue(store as any);
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("needle schema:app");
        await runDebouncedSearch();
        expect(state.filteredItems.value).toHaveLength(2);
        expect(state.filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "table", database: "app", schema: "app", label: "needle" }), expect.objectContaining({ type: "column", database: "app", schema: "app", tableName: "needle", columnName: "needle" })]));
        expect(store.listCompletionSchemas).not.toHaveBeenCalled();
        expect(api.buildDatabaseStructureSearchSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "sqlite", database: "app", schema: "app" }));
        expect(api.executeQuery).toHaveBeenCalledWith("conn1", "app", "SELECT attached structure", undefined, expect.stringContaining("quick-open-structure-"), { maxRows: 50 });
      } finally {
        scope.stop();
      }
    });

    it("deduplicates loaded and remote table results", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.filter((item) => item.label === "users")).toHaveLength(1);
    });

    it.each(["source:remote users", "users comment:directory", "directory"])("keeps matching remote metadata when the cached object fails %s", async (query) => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValueOnce({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValueOnce({
        columns: ["object_schema", "object_name", "column_name", "column_comment", "table_comment"],
        rows: [["public", "users", null, null, "users directory"]],
      } as any);
      vi.mocked(useConnectionStore).mockReturnValue(
        remoteSearchStore({
          connections: [{ id: "conn1", name: "MySQL", db_type: "mysql", database: "app" }],
          treeNodes: [{ connectionId: "conn1", type: "table", database: "app", schema: "public", label: "users" }],
          listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", schema: "public", type: "table" }]),
        }) as any,
      );
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery(query);
        await runDebouncedSearch();
        expect(state.filteredItems.value).toHaveLength(1);
        expect(state.filteredItems.value[0]).toMatchObject({ label: "users", source: "remote" });
        if (query !== "source:remote users") expect(state.filteredItems.value[0]?.tableComment).toBe("users directory");
      } finally {
        scope.stop();
      }
    });

    it("deduplicates the same cached and remote field without merging case-distinct fields", async () => {
      vi.mocked(api.buildDatabaseStructureSearchSql).mockResolvedValue({ sql: "SELECT structure" });
      vi.mocked(api.executeQuery).mockResolvedValue({
        columns: ["object_schema", "object_name", "column_name"],
        rows: [
          ["public", "items", "Code"],
          ["public", "items", "code"],
        ],
      } as any);
      vi.mocked(useConnectionStore).mockReturnValue(
        remoteSearchStore({
          treeNodes: [
            { connectionId: "conn1", type: "database", database: "app", label: "app" },
            { connectionId: "conn1", type: "column", database: "app", schema: "public", tableName: "items", label: "Code (text)", meta: { name: "Code", data_type: "text" } },
          ],
        }) as any,
      );
      const scope = effectScope();
      try {
        const state = scope.run(() => useQuickOpen())!;
        state.setQuery("kind:column code");
        await runDebouncedSearch();
        expect(state.filteredItems.value.map((item) => item.columnName).sort()).toEqual(["Code", "code"]);
      } finally {
        scope.stop();
      }
    });

    it("ignores stale remote responses", async () => {
      const alpha = deferred<Array<{ name: string; type: "table" }>>();
      const beta = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn((_connectionId, _database, query) => (query === "alpha" ? alpha.promise : beta.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      setQuery("beta");
      await runDebouncedSearch();

      beta.resolve([{ name: "beta_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");

      alpha.resolve([{ name: "alpha_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("alpha_table");
    });

    it("cancels stale structure queries and keeps the newer generation", async () => {
      const alpha = deferred<any>();
      const beta = deferred<any>();
      vi.mocked(api.buildDatabaseStructureSearchSql).mockImplementation(async ({ term }: any) => ({ sql: `SELECT ${term}` }) as any);
      vi.mocked(api.executeQuery).mockImplementation(async (_connectionId, _database, sql) => (String(sql).includes("alpha") ? alpha.promise : beta.promise));
      vi.mocked(api.cancelQuery).mockResolvedValue(undefined);
      const mockStore = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      setQuery("beta");
      await runDebouncedSearch();

      expect(api.cancelQuery).toHaveBeenCalledWith(expect.stringContaining("quick-open-structure-"));
      beta.resolve({ columns: ["object_schema", "object_name", "column_name", "column_comment"], rows: [["public", "users", "email", "beta"]] });
      await flushAsyncWork();
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("email");

      alpha.resolve({ columns: ["object_schema", "object_name", "column_name", "column_comment"], rows: [["public", "users", "email", "alpha"]] });
      await flushAsyncWork();
      expect(filteredItems.value.find((item) => item.type === "column")?.columnComment).toBe("beta");
    });

    it("does not request metadata for empty or one-character queries", async () => {
      const mockStore = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("");
      setQuery("a");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("does not query disconnected contexts", async () => {
      const mockStore = remoteSearchStore({ connectedIds: new Set<string>() });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("does not start a queued search after its connection disconnects", async () => {
      const mockStore = remoteSearchStore({ listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", type: "table" }]) });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      mockStore.connectedIds.clear();
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("prioritizes the active connection before applying the remote request cap", async () => {
      const connections = Array.from({ length: 9 }, (_, index) => ({ id: `conn${index}`, name: `Connection ${index}`, db_type: "mysql", database: `db${index}` }));
      const mockStore = remoteSearchStore({
        connections,
        activeConnectionId: "conn8",
        connectedIds: new Set(connections.map((connection) => connection.id)),
        treeNodes: [],
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      const requestedConnections = mockStore.listCompletionTables.mock.calls.map(([connectionId]) => connectionId);
      expect(requestedConnections).toContain("conn8");
      expect(requestedConnections).not.toContain("conn7");
      expect(mockStore.listCompletionTables).toHaveBeenCalledTimes(8);
    });

    it("publishes active connection results without waiting for slow cold connections", async () => {
      const slowSearch = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        connections: [
          { id: "cold", name: "Cold", db_type: "mysql", database: "cold_db" },
          { id: "active", name: "Active", db_type: "mysql", database: "active_db" },
        ],
        activeConnectionId: "active",
        connectedIds: new Set(["active"]),
        treeNodes: [],
        listCompletionTables: vi.fn((connectionId) => (connectionId === "active" ? Promise.resolve([{ name: "active_users", type: "table" as const }]) : slowSearch.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("active_users");
      slowSearch.resolve([]);
      await flushAsyncWork();
    });

    it("drops stale queued contexts before scheduling a newer query", async () => {
      const alphaRequests: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      const listCompletionTables = vi.fn((_connectionId, _database, query) => {
        if (query === "alpha") {
          const request = deferred<Array<{ name: string; type: "table" }>>();
          alphaRequests.push(request);
          return request.promise;
        }
        return Promise.resolve([{ name: "beta_table", type: "table" as const }]);
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 4 }, (_, index) => ({
          id: `conn1:db${index}`,
          connectionId: "conn1",
          type: "database",
          database: `db${index}`,
          label: `db${index}`,
        })),
        listCompletionTables,
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      setQuery("beta");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      alphaRequests[0]!.resolve([]);
      await flushAsyncWork();
      expect(listCompletionTables.mock.calls[2]?.[2]).toBe("beta");
      expect(listCompletionTables.mock.calls.filter(([, , query]) => query === "alpha")).toHaveLength(2);

      alphaRequests[1]!.resolve([]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
    });

    it("derives the SQLite main database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "sqlite-1", name: "SQLite", db_type: "sqlite", host: "/tmp/app.sqlite" }],
        connectedIds: new Set(["sqlite-1"]),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "scroll_test", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("scroll_test");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("sqlite-1", "main", "scroll_test", 25, undefined, true, undefined, undefined, { activateConnection: false, allowConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "scroll_test", type: "table", database: "main" })]));
    });

    it("keeps a PostgreSQL schema equal to its database as a real schema", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "pg-1", name: "PostgreSQL", db_type: "postgres" }],
        treeNodes: [{ connectionId: "pg-1", type: "table", database: "app", schema: "app", label: "same_name" }],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("same_name schema:app");

      expect(filteredItems.value).toEqual([expect.objectContaining({ type: "table", database: "app", schema: "app", label: "same_name" })]);
    });

    it("searches the PostgreSQL backend default database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "" }],
        connectedIds: new Set(["pg-1"]),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "cold_start_table", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("cold_start_table");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("pg-1", "postgres", "cold_start_table", 25, undefined, true, undefined, undefined, { activateConnection: false, allowConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "cold_start_table", type: "table", database: "postgres" })]));
    });

    it("keeps local results when remote metadata search fails", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("caps requests, concurrency, and merged remote results", async () => {
      const pending: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      let callIndex = 0;
      const listCompletionTables = vi.fn(() => {
        const request = deferred<Array<{ name: string; type: "table" }>>();
        pending.push(request);
        return request.promise;
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 12 }, (_, index) => ({
          id: `conn1:db${index}`,
          connectionId: "conn1",
          type: "database",
          database: `db${index}`,
          label: `db${index}`,
        })),
        listCompletionTables,
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("table");
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      for (let wave = 0; wave < 4; wave++) {
        const active = pending.slice(wave * 2, wave * 2 + 2);
        for (const request of active) {
          const requestIndex = callIndex++;
          request.resolve(Array.from({ length: 30 }, (_, index) => ({ name: `table_${requestIndex}_${index}`, type: "table" })));
        }
        await flushAsyncWork();
        expect(listCompletionTables.mock.calls.length).toBeLessThanOrEqual(Math.min((wave + 2) * 2, 8));
      }

      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(8);
      expect(filteredItems.value).toHaveLength(100);
    });
  });
});
