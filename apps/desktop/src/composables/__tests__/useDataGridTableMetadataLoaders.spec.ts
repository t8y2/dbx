// @vitest-environment happy-dom
import { computed, ref } from "vue";
import { describe, expect, it, vi, beforeEach } from "vitest";
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

describe("useDataGridTableMetadataLoaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE test (id int);" });
    mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "int" }]);
    mocks.listIndexes.mockResolvedValue([]);
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
      connectionStore: {} as any,
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
      connectionStore: {} as any,
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
      connectionStore: {} as any,
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
