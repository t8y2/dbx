import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  connectionStore: {
    activeConnectionId: "",
    getConfig: vi.fn((connectionId: string) => ({ id: connectionId, db_type: "postgres" })),
    ensureConnected: vi.fn(),
    connectionIdentifierQuote: vi.fn(() => undefined),
    refreshObjectListTreeNode: vi.fn(),
  },
  settingsStore: {
    editorSettings: {
      autoCalculateTotalRows: false,
      continueOnErrorOnBatch: false,
      openTabsRestoreMode: "all",
      pageSize: 100,
      reuseDataTab: true,
      tableOpenPageSize: 100,
    },
  },
  buildTableSelectSql: vi.fn(),
  loadOpenTabsState: vi.fn(),
  loadTableMetadata: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => mocks.connectionStore,
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => mocks.settingsStore,
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadOpenTabsState: mocks.loadOpenTabsState,
    saveOpenTabsState: mocks.saveOpenTabsState,
  };
});

vi.mock("@/lib/metadata/tableMetadataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata/tableMetadataCache")>();
  return {
    ...actual,
    loadTableMetadata: mocks.loadTableMetadata,
  };
});

vi.mock("@/lib/table/tableSelectSql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table/tableSelectSql")>();
  return {
    ...actual,
    buildTableSelectSql: mocks.buildTableSelectSql,
  };
});

const dialogs = {
  showFieldLineageDialog: { value: false },
  showDatabaseSearchDialog: { value: false },
  showDiagramDialog: { value: false },
};

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

async function setupNavigation() {
  setActivePinia(createPinia());
  const { useQueryStore } = await import("@/stores/queryStore");
  const queryStore = useQueryStore();
  vi.spyOn(queryStore, "executeTabSql").mockImplementation(async (tabId: string, sql: string) => {
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const result: QueryResult = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    tab.result = result;
    tab.isExecuting = false;
    tab.executionId = undefined;
    queryStore.updateSql(tabId, sql);
  });
  const { useNavigationTargets } = await import("@/composables/useNavigationTargets");
  return { navigation: useNavigationTargets(dialogs), queryStore };
}

describe("useNavigationTargets with the real query store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    mocks.connectionStore.activeConnectionId = "";
    mocks.ensureConnected?.mockResolvedValue?.(undefined);
    mocks.connectionStore.ensureConnected.mockResolvedValue(undefined);
    mocks.loadOpenTabsState.mockResolvedValue(null);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    mocks.buildTableSelectSql.mockImplementation(async ({ tableName, whereInput }: { tableName: string; whereInput?: string }) => `SELECT * FROM ${tableName}${whereInput ? ` WHERE ${whereInput}` : ""}`);
    mocks.loadTableMetadata.mockImplementation(async (request: { database: string; schema?: string; tableName: string; tableType?: string; catalog?: string }) => ({
      metadata: {
        database: request.database,
        schema: request.schema,
        catalog: request.catalog,
        tableName: request.tableName,
        tableType: request.tableType ?? "TABLE",
        columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));
  });

  it("opens same-table search results with different predicates in separate tabs", async () => {
    const { navigation, queryStore } = await setupNavigation();
    const target = { connectionId: "connection-1", database: "app", schema: "public", tableName: "users" };

    await navigation.openDatabaseSearchTarget({ ...target, whereInput: '"id" = 1' });
    await navigation.openDatabaseSearchTarget({ ...target, whereInput: '"id" = 2' });

    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs.map((tab) => tab.sql)).toEqual(['SELECT * FROM users WHERE "id" = 1', 'SELECT * FROM users WHERE "id" = 2']);
  });

  it("creates a new target tab even when the same table was restored", async () => {
    mocks.loadOpenTabsState.mockResolvedValue({
      tabs: [
        {
          id: "restored-users",
          title: "public.users",
          connectionId: "connection-1",
          database: "app",
          schema: "public",
          mode: "data",
          sql: "SELECT * FROM users WHERE restored = true",
          tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
        },
      ],
      activeTabId: "restored-users",
    });
    const { navigation, queryStore } = await setupNavigation();
    await queryStore.initOpenTabs();

    expect(queryStore.createTab("connection-1", "app", "public.users", "data", "public")).toBe("restored-users");
    await navigation.openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });

    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs[0]?.id).toBe("restored-users");
    expect(queryStore.tabs[0]?.sql).toBe("SELECT * FROM users WHERE restored = true");
    expect(queryStore.tabs[1]?.id).not.toBe("restored-users");
  });

  it("keeps concurrent same-table opens independent", async () => {
    const connectionGates: Array<() => void> = [];
    mocks.connectionStore.ensureConnected.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          connectionGates.push(resolve);
        }),
    );
    const { navigation, queryStore } = await setupNavigation();
    const target = { connectionId: "connection-1", database: "app", schema: "public", tableName: "users" };

    const first = navigation.openTableTarget({ ...target, whereInput: '"id" = 1' });
    const second = navigation.openTableTarget({ ...target, whereInput: '"id" = 2' });
    await vi.waitFor(() => expect(queryStore.tabs).toHaveLength(2));

    connectionGates.splice(0).forEach((release) => release());
    await Promise.all([first, second]);

    expect(new Set(queryStore.tabs.map((tab) => tab.id))).toHaveLength(2);
    expect(queryStore.tabs.map((tab) => tab.sql)).toEqual(['SELECT * FROM users WHERE "id" = 1', 'SELECT * FROM users WHERE "id" = 2']);
  });

  it("preserves default identity reuse and cross-scope isolation", async () => {
    const { queryStore } = await setupNavigation();
    const base = queryStore.createTab("connection-1", "app", "public.users", "data", "public");

    expect(queryStore.createTab("connection-1", "app", "public.users", "data", "public")).toBe(base);
    expect(queryStore.createTab("connection-2", "app", "public.users", "data", "public")).not.toBe(base);
    expect(queryStore.createTab("connection-1", "analytics", "public.users", "data", "public")).not.toBe(base);
    expect(queryStore.createTab("connection-1", "app", "archive.users", "data", "archive")).not.toBe(base);
    expect(queryStore.createTab("connection-1", "app", "public.orders", "data", "public")).not.toBe(base);
    expect(queryStore.createTab("connection-1", "app", "public.users", "data", "public", undefined, undefined, { forceNew: true })).not.toBe(base);
  });

  it("clears a renamed column sort when structure-save metadata reaches an open data tab", async () => {
    const { navigation, queryStore } = await setupNavigation();
    const dataTabId = queryStore.createTab("connection-1", "app", "public.users", "data", "public");
    queryStore.setTableMeta(dataTabId, {
      database: "app",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "old_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const dataTab = queryStore.tabs.find((tab) => tab.id === dataTabId)!;
    dataTab.resultSortColumn = "old_name";
    dataTab.resultSortColumnIndex = 1;
    dataTab.resultSortDirection = "asc";
    dataTab.resultSortMode = "database";
    dataTab.orderByInput = '"old_name" ASC';
    queryStore.createTab("connection-1", "app", "Edit users", "structure", "public", "users", undefined, { forceNew: true });
    mocks.loadTableMetadata.mockResolvedValueOnce({
      metadata: {
        database: "app",
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });

    await navigation.onStructureEditorSaved(vi.fn().mockResolvedValue(undefined), vi.fn(), {
      connectionId: "connection-1",
      database: "app",
      schema: "public",
      tableName: "users",
    });

    expect(dataTab.tableMeta?.columns.map((column) => column.name)).toEqual(["id", "new_name"]);
    expect(dataTab.tableMeta?.schema).toBe("public");
    expect(dataTab.resultSortColumn).toBeUndefined();
    expect(dataTab.resultSortDirection).toBeUndefined();
    expect(dataTab.orderByInput).toBeUndefined();
  });
});
