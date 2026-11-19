// @vitest-environment happy-dom
import { computed, effectScope, reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { useDataGridTableMetadataLoaders } from "@/composables/useDataGridTableMetadataLoaders";
import type { DatabaseType } from "@/types/database";

const mocks = vi.hoisted(() => ({
  loadObjectDdl: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
}));

vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  getTableOwner: vi.fn(),
  listForeignKeys: vi.fn(),
  listTriggers: vi.fn(),
  listConstraints: vi.fn(),
  listPartitions: vi.fn(),
}));

function createTestState() {
  return {
    ddlContent: ref(""),
    ddlLoading: ref(false),
    tableInfoColumns: ref([]),
    tableInfoColumnsLoading: ref(false),
    tableOwner: ref<string | null>(null),
    tableOwnerLoading: ref(false),
    tableOwnerError: ref(""),
    indexes: ref([]),
    indexesLoaded: ref(false),
    indexesLoading: ref(false),
    indexesError: ref(""),
    foreignKeys: ref([]),
    foreignKeysLoaded: ref(false),
    foreignKeysLoading: ref(false),
    foreignKeysError: ref(""),
    triggers: ref([]),
    triggersLoaded: ref(false),
    triggersLoading: ref(false),
    triggersError: ref(""),
    constraints: ref([]),
    constraintsLoaded: ref(false),
    constraintsLoading: ref(false),
    constraintsError: ref(""),
    partitioning: ref(null),
    partitioningLoaded: ref(false),
    partitioningLoading: ref(false),
    partitioningError: ref(""),
    partitioningRequestGeneration: ref(0),
    tableInfoColumnsRequestGeneration: ref(0),
    tableOwnerRequestGeneration: ref(0),
    indexesRequestGeneration: ref(0),
    foreignKeysRequestGeneration: ref(0),
    constraintsRequestGeneration: ref(0),
  };
}

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
function ddlFixture(databaseType: DatabaseType = "oracle") {
  const scope = effectScope();
  scopes.push(scope);
  const props = reactive({ connectionId: "source", database: "query-db", schema: "Owner", tableMeta: { database: "table-db", catalog: "catalog", schema: "Exact Owner", tableName: "First", columns: [], primaryKeys: [] } });
  const state = createTestState();
  const settingsStore = reactive({ editorSettings: { refreshDdlOnOpen: false, generateSqlIncludeDatabaseName: false, generateSqlQuoteIdentifiers: true, separateDdlIndexes: false } });
  const loaders = scope.run(() =>
    useDataGridTableMetadataLoaders({
      props,
      state,
      settingsStore: settingsStore as any,
      connectionStore: { getConfig: () => ({ query_timeout_secs: 20 }) } as any,
      resolvedDatabaseType: computed(() => databaseType),
      canShowTableIndexes: computed(() => true),
      showTableInfo: ref(false),
      toast: vi.fn(),
      formatBackendError: String,
      toastMongoIndexRefreshError: vi.fn(),
    }),
  )!;
  return { scope, props, state, settingsStore, loaders };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useDataGridTableMetadataLoaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE test (id int);" });
    mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "int" }]);
    mocks.listIndexes.mockResolvedValue([]);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("passes independent indexes with the exact %s source-table scope", async (type) => {
    const { loaders, settingsStore } = ddlFixture(type);
    settingsStore.editorSettings.separateDdlIndexes = true;
    await loaders.fetchDdl(false);
    expect(mocks.loadObjectDdl).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "source", database: "table-db", schema: "Exact Owner", catalog: "catalog", tableName: "First", separateIndexes: true }), { force: false });
  });

  it("ignores an old preference response and retains the newer loading state", async () => {
    const { loaders, settingsStore, state } = ddlFixture();
    const old = deferred<{ ddl: string }>();
    const current = deferred<{ ddl: string }>();
    mocks.loadObjectDdl.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = loaders.fetchDdl();
    settingsStore.editorSettings.separateDdlIndexes = true;
    const second = loaders.fetchDdl();
    old.resolve({ ddl: "STALE" });
    await first;
    expect(state.ddlLoading.value).toBe(true);
    expect(state.ddlContent.value).toBe("");
    current.resolve({ ddl: "CREATE INDEX current_index ON First(id);" });
    await second;
    expect(state.ddlContent.value).toContain("current_index");
    expect(state.ddlLoading.value).toBe(false);
  });

  it.each(["identity", "dispose"])("ignores pending DDL after %s changes", async (change) => {
    const { loaders, props, scope, state } = ddlFixture();
    const old = deferred<{ ddl: string }>();
    mocks.loadObjectDdl.mockReturnValueOnce(old.promise);
    const pending = loaders.fetchDdl();
    if (change === "identity") props.tableMeta.tableName = "Second";
    else scope.stop();
    old.resolve({ ddl: "STALE" });
    await pending;
    expect(state.ddlContent.value).toBe("");
  });

  it("clears an index-read error after switching off and reloading", async () => {
    const { loaders, settingsStore, state } = ddlFixture();
    settingsStore.editorSettings.separateDdlIndexes = true;
    mocks.loadObjectDdl.mockRejectedValueOnce(new Error("index metadata unavailable")).mockResolvedValueOnce({ ddl: "CREATE TABLE First(id NUMBER);" });
    await loaders.fetchDdl();
    expect(loaders.ddlError.value).toBe("index metadata unavailable");
    settingsStore.editorSettings.separateDdlIndexes = false;
    await loaders.fetchDdl();
    expect(loaders.ddlError.value).toBe("");
    expect(state.ddlContent.value).toContain("CREATE TABLE First");
  });

  it("does not fall back to database as schema for schema-aware database Kingbase (#11347)", async () => {
    const state = createTestState();
    const resolvedDatabaseType = ref<DatabaseType>("kingbase");
    const showTableInfo = ref(false);

    const loaders = useDataGridTableMetadataLoaders({
      props: {
        connectionId: "conn-1",
        database: "TESTDB",
        schema: undefined,
        tableMeta: {
          tableName: "CTRC_REG_PRO_FLOW",
          columns: [],
          primaryKeys: [],
        },
      },
      state,
      settingsStore: {
        editorSettings: {
          refreshDdlOnOpen: false,
          generateSqlIncludeDatabaseName: false,
          generateSqlQuoteIdentifiers: true,
        },
      } as any,
      connectionStore: { getConfig: () => undefined } as any,
      resolvedDatabaseType: computed(() => resolvedDatabaseType.value),
      canShowTableIndexes: computed(() => true),
      showTableInfo,
      toast: vi.fn(),
      formatBackendError: (e) => String(e),
      toastMongoIndexRefreshError: vi.fn(),
    });

    await loaders.fetchDdl();

    expect(mocks.loadObjectDdl).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        database: "TESTDB",
        schema: "",
        tableName: "CTRC_REG_PRO_FLOW",
      }),
      expect.anything(),
    );
  });

  it("preserves explicit schema for schema-aware database Kingbase", async () => {
    const state = createTestState();
    const resolvedDatabaseType = ref<DatabaseType>("kingbase");
    const showTableInfo = ref(false);

    const loaders = useDataGridTableMetadataLoaders({
      props: {
        connectionId: "conn-1",
        database: "TESTDB",
        schema: "public",
        tableMeta: {
          tableName: "CTRC_REG_PRO_FLOW",
          schema: "public",
          columns: [],
          primaryKeys: [],
        },
      },
      state,
      settingsStore: {
        editorSettings: {
          refreshDdlOnOpen: false,
          generateSqlIncludeDatabaseName: false,
          generateSqlQuoteIdentifiers: true,
        },
      } as any,
      connectionStore: { getConfig: () => undefined } as any,
      resolvedDatabaseType: computed(() => resolvedDatabaseType.value),
      canShowTableIndexes: computed(() => true),
      showTableInfo,
      toast: vi.fn(),
      formatBackendError: (e) => String(e),
      toastMongoIndexRefreshError: vi.fn(),
    });

    await loaders.fetchDdl();

    expect(mocks.loadObjectDdl).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        database: "TESTDB",
        schema: "public",
        tableName: "CTRC_REG_PRO_FLOW",
      }),
      expect.anything(),
    );
  });

  it("falls back to database as schema for non-schema-aware database MySQL", async () => {
    const state = createTestState();
    const resolvedDatabaseType = ref<DatabaseType>("mysql");
    const showTableInfo = ref(false);

    const loaders = useDataGridTableMetadataLoaders({
      props: {
        connectionId: "conn-mysql",
        database: "shop_db",
        schema: undefined,
        tableMeta: {
          tableName: "orders",
          columns: [],
          primaryKeys: [],
        },
      },
      state,
      settingsStore: {
        editorSettings: {
          refreshDdlOnOpen: false,
          generateSqlIncludeDatabaseName: false,
          generateSqlQuoteIdentifiers: true,
        },
      } as any,
      connectionStore: { getConfig: () => undefined } as any,
      resolvedDatabaseType: computed(() => resolvedDatabaseType.value),
      canShowTableIndexes: computed(() => true),
      showTableInfo,
      toast: vi.fn(),
      formatBackendError: (e) => String(e),
      toastMongoIndexRefreshError: vi.fn(),
    });

    await loaders.fetchDdl();

    expect(mocks.loadObjectDdl).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-mysql",
        database: "shop_db",
        schema: "shop_db",
        tableName: "orders",
      }),
      expect.anything(),
    );
  });
});
