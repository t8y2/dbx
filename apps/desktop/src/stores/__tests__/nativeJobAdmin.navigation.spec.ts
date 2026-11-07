import { createPinia, setActivePinia } from "pinia";
import { toRaw, watch } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode, QueryTab } from "@/types/database";
import type { NativeJobDetails, NativeJobRef } from "@/lib/database/nativeJobs";
import { oracleDatabaseLinkGroup, oracleSchemaJobGroups, oracleSharedObjects, oracleNavigationAuxiliaryText } from "@/lib/sidebar/oracleObjectNavigation";
import { treeNodeRowAction } from "@/lib/sidebar/treeNodeClick";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import { serializeOpenTabs } from "@/lib/app/openTabsPersistence";

const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  saveSavedSqlEditorPositions: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["Owner"]),
  listSchemaInfos: vi.fn().mockResolvedValue([]),
  listSqlServerLinkedServers: vi.fn().mockResolvedValue([]),
  listSqlServerLinkedServerSchemas: vi.fn().mockResolvedValue(["A", "B"]),
  listDatabases: vi.fn().mockResolvedValue([{ name: "DB" }]),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  disconnectDb: vi.fn().mockResolvedValue(undefined),
  listInstalledAgents: vi.fn().mockResolvedValue([]),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  saveConnectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([]),
  listObjects: vi.fn().mockResolvedValue([]),
  listExtensions: vi.fn().mockResolvedValue([]),
  listEventTriggers: vi.fn().mockResolvedValue([]),
  executeQuery: vi.fn().mockResolvedValue({ columns: ["DBX_SESSION_USER"], rows: [["Owner"]] }),
  nativeJobOpenContext: vi.fn(),
  nativeJobList: vi.fn(),
  nativeJobRead: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tabs/tabResultCache")>()), deleteTabResultSnapshot: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeQuery.mockReset().mockResolvedValue({ columns: ["DBX_SESSION_USER"], rows: [["Owner"]] });
  mocks.listSchemas.mockReset().mockResolvedValue(["Owner"]);
  mocks.listSchemaInfos.mockReset().mockImplementation(async (...args) => (await mocks.listSchemas(...args)).map((name: string) => ({ name, comment: null })));
  mocks.loadSchemaCache.mockReset().mockResolvedValue(null);
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.listObjects.mockReset().mockResolvedValue([]);
  mocks.listExtensions.mockReset().mockResolvedValue([]);
  mocks.listEventTriggers.mockReset().mockResolvedValue([]);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
  mocks.nativeJobOpenContext.mockImplementation(async (connectionId, database) => ({ scope: { connectionId, database, contextId: "runtime" }, engine: "oracle", sessionUser: "Owner" }));
  mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_JOBS", coverage: "database" }, offset: 0, limit: 500 });
  mocks.nativeJobRead.mockReset();
});

describe("native Job navigation through the real stores", () => {
  function legacyTab(overrides: Partial<QueryTab> = {}): QueryTab {
    return {
      id: "old",
      title: "Old jobs",
      mode: "database-jobs",
      connectionId: "c",
      database: "DB",
      sql: "RETAINED_INPUT",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      uiState: { page: { "database-jobs": { DatabaseJobAdmin: { ownerFilter: "DO_NOT_GUESS", selectedJob: { kind: "legacy", jobId: "900719925474099312345" }, kind: "scheduler" } } } },
      ...overrides,
    };
  }
  function legacyDetails(target: NativeJobRef, schema = "ParseOwner"): NativeJobDetails {
    if (target.kind !== "legacy") throw new Error("expected legacy ID");
    return {
      snapshot: { ref: target, revision: "current-revision", definition: { status: "available", value: { SCHEMA_USER: schema, LOG_USER: "LoginOwner", PRIV_USER: "PrivilegeOwner" } }, arguments: { status: "empty" } },
      nativeIdentity: { status: "available", value: { DBX_JOB_ID: target.jobId } },
      consistency: { status: "available", value: null },
      parameterMetadata: { status: "empty" },
      steps: { status: "empty" },
      schedules: { status: "empty" },
      running: { status: "empty" },
      history: { status: "empty" },
      sources: {},
    };
  }
  async function stores(db_type: ConnectionConfig["db_type"], overrides: Partial<ConnectionConfig> = {}) {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connection = { id: "c", name: "Test", db_type, host: "localhost", port: 1521, username: "Owner", password: "", database: "Service-not-owner", ...overrides };
    const connections = useConnectionStore();
    connections.addEphemeralConnection(connection);
    connections.connectedIds.add("c");
    connections.treeNodes = [{ id: "c", label: "Test", type: "connection", connectionId: "c", children: [] }];
    return { connections, queries: useQueryStore() };
  }
  it("projects the real Oracle tree by selected scope while retaining public and exact leaf targets", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const schema = (name: string): TreeNode => ({
      id: `c:${name}`,
      type: "schema",
      label: name,
      connectionId: "c",
      database: name,
      schema: name,
      children: [{ ...oracleDatabaseLinkGroup({ id: name, connectionId: "c", database: name }, { kind: "schema", schema: name }), children: [{ id: `${name}-L`, type: "oracle-db-link", label: "L", connectionId: "c", database: name, schema: name }] }],
    });
    connections.treeNodes[0].children = [schema("A"), schema("B"), oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle")];
    const original = JSON.stringify(connections.treeNodes);
    const first = connections.projectRelationalNavigationTree(connections.treeNodes)[0];
    const selector = first.children!.find((node) => node.type === "relational-scope")!;
    expect(selector.relationalNavigationSelection).toEqual({ kind: "named", name: "A" });
    expect(first.children!.find((node) => node.type === "oracle-db-links")?.children?.map((node) => node.id)).toEqual(["A-L"]);
    expect(first.children!.some((node) => node.type === "schema" || node.type === "oracle-shared-objects")).toBe(false);
    connections.setRelationalNavigationSelection(selector.relationalNavigationContainer!, { kind: "all" });
    const all = connections.projectRelationalNavigationTree(connections.treeNodes)[0];
    expect(all.children!.find((node) => node.type === "oracle-db-links")?.children?.map((node) => [node.id, node.database, node.relationalNavigationOwner])).toEqual([
      ["A-L", "A", "A"],
      ["B-L", "B", "B"],
    ]);
    expect(JSON.stringify(connections.treeNodes)).toBe(original);
    expect(connections.getConfig("c")?.default_schema).toBe("A");
  });
  it("keeps PostgreSQL database boundaries and aggregates MySQL database scopes", async () => {
    const { connections } = await stores("postgres", { default_schema: "public" });
    const database = (name: string): TreeNode => ({
      id: `c:${name}`,
      type: "database",
      label: name,
      connectionId: "c",
      database: name,
      children: [
        {
          id: `c:${name}:public`,
          type: "schema",
          label: "public",
          connectionId: "c",
          database: name,
          schema: "public",
          children: [{ id: `${name}-tables`, type: "group-tables", label: "tree.tables", connectionId: "c", database: name, schema: "public", children: [{ id: `${name}-orders`, type: "table", label: "orders", connectionId: "c", database: name, schema: "public" }] }],
        },
      ],
    });
    connections.treeNodes[0].children = [database("one"), database("two")];
    const pg = connections.projectRelationalNavigationTree(connections.treeNodes)[0];
    expect(pg.children!.map((node) => node.type)).toEqual(["database", "database"]);
    const selectors = pg.children!.map((node) => node.children!.find((child) => child.type === "relational-scope")!);
    expect(selectors.map((node) => node.relationalNavigationContainer?.database)).toEqual(["one", "two"]);
    expect(selectors[0].id).not.toBe(selectors[1].id);
    connections.connections[0].db_type = "mysql";
    connections.connections[0].database = "one";
    connections.treeNodes[0].children = [database("one"), database("two")].map((node) => ({ ...node, children: node.children![0].children }));
    const mysql = connections.projectRelationalNavigationTree(connections.treeNodes)[0];
    const selector = mysql.children!.find((node) => node.type === "relational-scope")!;
    expect(selector.relationalNavigationContainer?.kind).toBe("database");
    expect(selector.relationalNavigationSelection).toEqual({ kind: "named", name: "one" });
    expect(mysql.children!.find((node) => node.type === "group-tables")?.children?.map((node) => node.database)).toEqual(["one"]);
  });
  it("keeps paged metadata caches separate for identical names in different catalogs", async () => {
    const { connections } = await stores("mysql");
    const group = (catalog: string): TreeNode => ({ id: `${catalog}:__tables`, type: "group-tables", label: "tree.tables", connectionId: "c", catalog, database: "same-db", schema: "same-schema", children: [] });
    const a = group("catalog-A");
    const b = group("catalog-B");
    connections.treeNodes[0].children = [a, b];
    mocks.listTables.mockResolvedValue([]);
    await Promise.all([connections.loadObjectGroupChildren(a), connections.loadObjectGroupChildren(b)]);
    expect(mocks.listTables.mock.calls.map((call) => call[7]).sort()).toEqual(["catalog-A", "catalog-B"]);
  });
  it("places database-level PostgreSQL objects below the schema selector without retargeting them", async () => {
    const { connections } = await stores("postgres", { database: "postgres", default_schema: "public" });
    const extensions: TreeNode = { id: "c:postgres:__extensions", type: "group-extensions", label: "tree.extensions", connectionId: "c", database: "postgres", children: [] };
    const events: TreeNode = { id: "c:postgres:__event_triggers", type: "group-event-triggers", label: "tree.eventTriggers", connectionId: "c", database: "postgres", children: [] };
    connections.treeNodes[0].children = [
      {
        id: "c:postgres",
        type: "database",
        label: "postgres",
        connectionId: "c",
        database: "postgres",
        children: [extensions, events, { id: "public", type: "schema", label: "public", connectionId: "c", database: "postgres", schema: "public", children: [{ id: "tables", type: "group-tables", label: "tree.tables", connectionId: "c", database: "postgres", schema: "public", children: [] }] }],
      },
    ];
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children![0].children!;
    expect(projected[0].type).toBe("relational-scope");
    expect(projected.find((node) => node.id === extensions.id)).toMatchObject({ database: "postgres" });
    expect(projected.find((node) => node.id === events.id)?.schema).toBeUndefined();
    const selector = projected[0];
    connections.setRelationalNavigationSelection(selector.relationalNavigationContainer!, { kind: "all" });
    expect(
      connections
        .projectRelationalNavigationTree(connections.treeNodes)[0]
        .children![0].children!.filter((node) => node.id === extensions.id || node.id === events.id)
        .map((node) => [node.id, node.database, node.schema]),
    ).toEqual([
      [extensions.id, "postgres", undefined],
      [events.id, "postgres", undefined],
    ]);
  });
  it("finishes empty PostgreSQL directory counts in the background without expanding the connection", async () => {
    const { connections } = await stores("postgres", { database: "postgres", default_schema: "public" });
    mocks.listDatabases.mockResolvedValue([{ name: "postgres" }]);
    mocks.listSchemas.mockResolvedValue(["public"]);
    mocks.listSchemaInfos.mockResolvedValue([{ name: "public", comment: null }]);
    mocks.listTables.mockResolvedValue([]);
    mocks.listObjects.mockResolvedValue([]);
    mocks.listExtensions.mockResolvedValue([{ name: "plpgsql", schema: "pg_catalog", version: "1.0" }]);
    mocks.listEventTriggers.mockResolvedValue([]);
    await connections.initializeRelationalNavigation("c");
    await vi.waitFor(() => {
      const database = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "database")!;
      expect(database.children!.find((node) => node.type === "group-tables")?.objectCount).toBe(0);
      expect(database.children!.find((node) => node.type === "group-views")?.objectCount).toBe(0);
      expect(database.children!.find((node) => node.type === "group-extensions")?.objectCount).toBe(1);
      expect(database.children!.find((node) => node.type === "group-event-triggers")?.objectCount).toBe(0);
    });
    expect(connections.treeNodes[0].isExpanded).toBeFalsy();
    const database = connections.treeNodes[0].children!.find((node) => node.type === "database")!;
    expect(database.children!.filter((node) => node.type === "group-extensions" || node.type === "group-event-triggers").every((node) => !node.isExpanded)).toBe(true);
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it("defaults to the actual current Oracle schema rather than the login user or first visible schema", async () => {
    const { connections, queries } = await stores("oracle");
    const original = queries.createTab("c", "Service-not-owner", "Existing", "query", "A");
    mocks.listSchemas.mockResolvedValueOnce(["A", "B", "Owner"]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql) => (sql.includes("CURRENT_SCHEMA") ? { columns: ["CURRENT_SCHEMA"], rows: [["B"]] } : { columns: ["USERNAME"], rows: [] }));
    await connections.loadDatabases("c", { force: true, connectedOnly: true, background: true });
    const picker = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "relational-scope")!;
    expect(picker.relationalNavigationSelection).toEqual({ kind: "named", name: "B" });
    expect(mocks.executeQuery).toHaveBeenCalledWith("c", "Service-not-owner", "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL", undefined, undefined, expect.objectContaining({ maxRows: 1 }));
    expect(queries.tabs.find((tab) => tab.id === original)?.schema).toBe("A");
    connections.setRelationalNavigationSelection(picker.relationalNavigationContainer!, { kind: "all" });
    expect(connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "relational-scope")?.relationalNavigationSelection).toEqual({ kind: "all" });
  });
  it("filters the actual Oracle schema selector with ALL_USERS maintenance metadata and honors the show-system toggle", async () => {
    const { connections } = await stores("oracle", { default_schema: "APP" });
    mocks.listSchemas.mockResolvedValue(["APP", "SYSRAC", "CUSTOM_INSTALLER", "DIP", "BUSINESS$USER"]);
    mocks.executeQuery.mockResolvedValue({ columns: ["USERNAME"], rows: [["SYSRAC"], ["CUSTOM_INSTALLER"]] });
    await connections.loadDatabases("c", { connectedOnly: true });
    expect(connections.treeNodes[0].children?.filter((node) => node.type === "schema").map((node) => node.schema)).toEqual(["APP", "BUSINESS$USER", "DIP"]);
    expect(mocks.executeQuery).toHaveBeenCalledWith("c", "Service-not-owner", "SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y'", undefined, undefined, { maxRows: 10000 });
    await connections.loadDatabases("c", { connectedOnly: true });
    expect(mocks.executeQuery).toHaveBeenCalledOnce();
    connections.getConfig("c")!.show_system_schemas = true;
    await connections.loadDatabases("c", { connectedOnly: true, force: true });
    expect(connections.treeNodes[0].children?.some((node) => node.schema === "SYSRAC")).toBe(true);
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
  });
  it("falls back to known Oracle system names when the maintenance column is unavailable", async () => {
    const { connections } = await stores("oracle", { default_schema: "APP" });
    mocks.listSchemas.mockResolvedValue(["APP", "SYSRAC", "SYS$UMF", "DIP", "GSMUSER", "BUSINESS$USER"]);
    mocks.executeQuery.mockRejectedValue(new Error("ORA-00904: ORACLE_MAINTAINED invalid identifier"));
    await connections.loadDatabases("c", { connectedOnly: true });
    expect(connections.treeNodes[0].children?.filter((node) => node.type === "schema").map((node) => node.schema)).toEqual(["APP", "BUSINESS$USER"]);
    expect(connections.connectedIds.has("c")).toBe(true);
  });
  it("does not reuse late Oracle maintenance metadata after disconnect and reconnect", async () => {
    const { connections } = await stores("oracle", { default_schema: "APP" });
    mocks.listSchemas.mockResolvedValue(["APP", "SYSRAC"]);
    let finish!: (value: unknown) => void;
    mocks.executeQuery
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ columns: ["USERNAME"], rows: [["SYSRAC"]] });
    const loading = connections.loadDatabases("c", { connectedOnly: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await connections.disconnect("c", { markClosedByUser: false, skipTabHandling: true });
    finish({ columns: ["USERNAME"], rows: [["APP"]] });
    await loading;
    connections.markConnectionConnected("c");
    await connections.loadDatabases("c", { connectedOnly: true });
    expect(connections.treeNodes[0].children?.filter((node) => node.type === "schema").map((node) => node.schema)).toEqual(["APP"]);
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("does not start Oracle maintenance reads when an old schema enumeration returns after disconnect (reconnect=%s)", async (reconnect) => {
    const { connections } = await stores("oracle", { default_schema: "APP" });
    let finish!: (value: string[]) => void;
    mocks.listSchemas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = connections.loadDatabases("c", { connectedOnly: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await connections.disconnect("c", { markClosedByUser: false, skipTabHandling: true });
    if (reconnect) connections.markConnectionConnected("c");
    finish(["APP", "SYSRAC"]);
    await loading;
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(connections.treeNodes[0].children).toEqual([]);
  });
  it.each(["scope-switch", "disconnect", "expand"] as const)("keeps PostgreSQL database metadata safe during %s", async (action) => {
    const { connections } = await stores("postgres", { database: "postgres", default_schema: "public" });
    let resolve!: (items: unknown[]) => void;
    mocks.listExtensions.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    connections.treeNodes[0].children = [{ id: "c:postgres", type: "database", label: "postgres", connectionId: "c", database: "postgres", children: [{ id: "c:postgres:__extensions", type: "group-extensions", label: "tree.extensions", connectionId: "c", database: "postgres", children: [] }] }];
    const source = connections.treeNodes[0].children![0].children![0];
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(mocks.listExtensions).toHaveBeenCalledOnce());
    let expanded: Promise<void> | undefined;
    if (action === "scope-switch") connections.setRelationalNavigationSelection({ connectionId: "c", kind: "schema", database: "postgres" }, { kind: "named", name: "other" });
    if (action === "disconnect") connections.connectedIds.delete("c");
    if (action === "expand") expanded = connections.loadTreeNodeChildren(source);
    await Promise.resolve();
    resolve([{ name: "plpgsql", schema: "pg_catalog", version: "1.0" }]);
    await expanded;
    await vi.waitFor(() => expect(source.isLoading).toBeFalsy());
    if (action === "disconnect") {
      expect(source.children).toEqual([]);
      expect(source.objectCount).toBeUndefined();
      expect(connections.connectedIds.has("c")).toBe(false);
    } else {
      expect(source.objectCount).toBe(1);
      expect(source.children![0]).toMatchObject({ database: "postgres", schema: "pg_catalog", label: "plpgsql" });
      expect(source.isExpanded ?? false).toBe(action === "expand");
    }
    expect(mocks.listExtensions).toHaveBeenCalledOnce();
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it.each(["postgres", "sqlserver"] as const)("resolves the default schema within the actual %s database", async (databaseType) => {
    const { connections } = await stores(databaseType, { database: "DB" });
    mocks.listDatabases.mockResolvedValueOnce([{ name: "DB" }]);
    await connections.loadDatabases("c", { force: true, connectedOnly: true, background: true });
    mocks.listSchemas.mockResolvedValueOnce(["A", "B"]);
    mocks.listSchemaInfos.mockResolvedValueOnce([{ name: "A" }, { name: "B" }]);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["schema"], rows: [["B"]] });
    if (databaseType === "sqlserver") await connections.loadSqlServerDatabaseObjects("c", "DB", { force: true, connectedOnly: true, background: true });
    else await connections.loadSchemas("c", "DB", { force: true, connectedOnly: true, background: true });
    const database = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "database")!;
    expect(database.children!.find((node) => node.type === "relational-scope")?.relationalNavigationSelection).toEqual({ kind: "named", name: "B" });
    expect(mocks.executeQuery.mock.calls.map((call) => [call[1], call[2]])).toEqual([["DB", databaseType === "sqlserver" ? "SELECT SCHEMA_NAME()" : "SELECT current_schema()"]]);
  });
  it("falls back to the freshly resolved default when a saved schema is confirmed missing", async () => {
    const { connections } = await stores("oracle");
    connections.setRelationalNavigationSelection({ connectionId: "c", kind: "schema" }, { kind: "named", name: "Gone" });
    mocks.listSchemas.mockResolvedValueOnce(["A", "B"]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql) => (sql.includes("CURRENT_SCHEMA") ? { columns: ["CURRENT_SCHEMA"], rows: [["B"]] } : { columns: ["USERNAME"], rows: [] }));
    await connections.loadDatabases("c", { force: true, connectedOnly: true, background: true });
    expect(connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "relational-scope")?.relationalNavigationSelection).toEqual({ kind: "named", name: "B" });
  });
  it("uses all when the default cannot be read and never substitutes the first schema", async () => {
    const { connections } = await stores("oracle");
    mocks.listSchemas.mockResolvedValueOnce(["A", "B"]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql) => {
      if (sql.includes("CURRENT_SCHEMA")) throw new Error("default unreadable");
      return { columns: ["USERNAME"], rows: [] };
    });
    await connections.loadDatabases("c", { force: true, connectedOnly: true, background: true });
    expect(connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "relational-scope")?.relationalNavigationSelection).toEqual({ kind: "all" });
  });
  it("persists a fallback only after successful fresh discovery and retains it after a transient failure", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const container = { connectionId: "c", kind: "schema" as const };
    connections.setRelationalNavigationSelection(container, { kind: "named", name: "B" });
    expect(connections.relationalNavigationSelection(container, ["A"], false, "A")).toEqual({ kind: "named", name: "B" });
    mocks.listSchemas.mockResolvedValueOnce(["A"]);
    await connections.loadDatabases("c", { force: true, connectedOnly: true });
    expect(connections.relationalNavigationSelection(container, ["A"], false, "A")).toEqual({ kind: "named", name: "A" });
    mocks.listSchemas.mockRejectedValueOnce(new Error("temporary catalog failure"));
    await expect(connections.loadDatabases("c", { force: true, connectedOnly: true })).rejects.toThrow("temporary catalog failure");
    expect(connections.relationalNavigationSelection(container, [], false, "A")).toEqual({ kind: "named", name: "A" });
  });
  it("restricts search sources and cached scopes, and reveals another schema without changing page state", async () => {
    const { connections, queries } = await stores("oracle", { default_schema: "A" });
    const schema = (name: string): TreeNode => ({
      id: `${name}-schema`,
      type: "schema",
      label: name,
      connectionId: "c",
      database: name,
      schema: name,
      children: [{ id: `${name}:__tables`, type: "group-tables", label: "tree.tables", connectionId: "c", database: name, schema: name, children: [{ id: `${name}-table`, type: "table", label: "same", connectionId: "c", database: name, schema: name }] }],
    });
    const a = schema("A");
    const b = schema("B");
    const root = connections.treeNodes[0];
    root.children = [a, b, oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle")];
    expect(connections.projectRelationalNavigationTree(connections.treeNodes, true)[0].children?.map((node) => node.id)).toEqual([a.id, "c:__oracle_navigation:%5B%22c%22%2C%22%22%2C%22shared-public%22%2Cnull%5D"]);
    expect(connections.relationalNavigationAllowsScope({ connectionId: "c", database: "A", schema: "A" })).toBe(true);
    expect(connections.relationalNavigationAllowsScope({ connectionId: "c", database: "B", schema: "B" })).toBe(false);
    const tabId = queries.openDatabaseJobAdmin("c", undefined, { database: "A", schema: "A", kind: "scheduler" });
    const before = JSON.stringify(queries.tabs);
    connections.revealRelationalNavigationPath([root, b, b.children![0], b.children![0].children![0]]);
    expect(connections.relationalNavigationSelection({ connectionId: "c", kind: "schema" }, ["A", "B"], false, "A")).toEqual({ kind: "named", name: "B" });
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0];
    expect(projected.children?.find((node) => node.type === "group-tables")?.isExpanded).toBe(true);
    expect(JSON.stringify(queries.tabs)).toBe(before);
    expect(queries.tabs[0]?.id).toBe(tabId);
    connections.setRelationalNavigationSelection({ connectionId: "c", kind: "schema" }, { kind: "all" });
    connections.revealRelationalNavigationPath([root, a, a.children![0], a.children![0].children![0]]);
    expect(connections.relationalNavigationSelection({ connectionId: "c", kind: "schema" }, ["A", "B"], false, "A")).toEqual({ kind: "all" });
  });
  it("keeps an All count unknown until every selected source has initialized its categories", async () => {
    const { connections } = await stores("mysql", { database: "A" });
    mocks.listDatabases.mockResolvedValueOnce([{ name: "A" }, { name: "B" }]);
    await connections.loadDatabases("c", { force: true, connectedOnly: true, background: true });
    await connections.changeRelationalNavigationSelection({ connectionId: "c", kind: "database" }, { kind: "named", name: "A" });
    const tableGroup = () => connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "group-tables")!;
    await vi.waitFor(() => expect(tableGroup().objectCount).toBe(0));
    let finish!: (value: unknown) => void;
    mocks.loadSchemaCache.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changing = connections.changeRelationalNavigationSelection({ connectionId: "c", kind: "database" }, { kind: "all" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const incompleteCount = tableGroup().objectCount;
    finish(null);
    await changing;
    await vi.waitFor(() => expect(tableGroup().objectCount).toBe(0));
    expect(incompleteCount).toBeUndefined();
  });
  it.each(["group-extensions", "group-event-triggers"] as const)("reports a %s background failure and clears it after a successful retry", async (type) => {
    const { connections } = await stores("postgres", { database: "postgres" });
    const method = type === "group-extensions" ? mocks.listExtensions : mocks.listEventTriggers;
    method.mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValueOnce([]);
    const id = `c:postgres:__${type === "group-extensions" ? "extensions" : "event_triggers"}`;
    connections.treeNodes[0].children = [{ id: "c:postgres", type: "database", label: "postgres", connectionId: "c", database: "postgres", children: [{ id, type, label: "Objects", connectionId: "c", database: "postgres", children: [] }] }];
    const source = connections.treeNodes[0].children![0].children![0];
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(source.oracleNavigationStatus?.kind).toBe("error"));
    expect(oracleNavigationAuxiliaryText(source, (key) => key)).toBe("tree.navigationStatus.error");
    expect(source.objectCount).toBeUndefined();
    expect(source.isExpanded ?? false).toBe(false);
    await connections.loadTreeNodeChildren(source, { force: true });
    expect(source.oracleNavigationStatus).toBeUndefined();
    expect(source.objectCount).toBe(0);
    expect(oracleNavigationAuxiliaryText(source, (key) => key)).toBe("0");
  });
  it("does not replace a fresh PostgreSQL directory success with an old background failure", async () => {
    const { connections } = await stores("postgres", { database: "postgres" });
    let reject!: (error: Error) => void;
    mocks.listExtensions
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValueOnce([{ name: "plpgsql", schema: "pg_catalog", version: "1.0" }]);
    connections.treeNodes[0].children = [{ id: "c:postgres", type: "database", label: "postgres", connectionId: "c", database: "postgres", children: [{ id: "c:postgres:__extensions", type: "group-extensions", label: "Extensions", connectionId: "c", database: "postgres", children: [] }] }];
    const source = connections.treeNodes[0].children![0].children![0];
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(mocks.listExtensions).toHaveBeenCalledOnce());
    await connections.loadTreeNodeChildren(source, { force: true });
    reject(new Error("old directory failure"));
    await new Promise((done) => setTimeout(done, 0));
    expect(source.objectCount).toBe(1);
    expect(source.oracleNavigationStatus).toBeUndefined();
    expect(source.children![0].label).toBe("plpgsql");
    expect(connections.connectionErrors["c"]).toBeUndefined();
  });
  it("preloads only the selected directory without expanding nodes or reconnecting", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const group = (name: string): TreeNode => ({ id: `${name}:__tables`, type: "group-tables", label: "tree.tables", connectionId: "c", database: name, schema: name, children: [], isExpanded: false });
    const a = group("A");
    const b = group("B");
    connections.treeNodes[0].children = [a, b].map((node) => ({ id: `${node.schema}-schema`, type: "schema", label: node.schema!, connectionId: "c", database: node.database, schema: node.schema, isExpanded: false, children: [node] }));
    mocks.listTables.mockResolvedValue([]);
    const selected = connections.selectedTreeNodeId;
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(a.objectCount).toBe(0));
    expect(b.objectCount).toBeUndefined();
    expect(a.isExpanded).toBe(false);
    expect(connections.treeNodes[0].children.every((node) => !node.isExpanded)).toBe(true);
    expect(connections.selectedTreeNodeId).toBe(selected);
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
    expect(mocks.listObjects).toHaveBeenCalledOnce();
    expect(mocks.listTables).not.toHaveBeenCalled();
  });
  it("uses the reusable Oracle directory for table comments and preserves loaded expansion", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const group: TreeNode = { id: "A:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "A", schema: "A", children: [] };
    const routines: TreeNode = { id: "A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "A", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: [group, routines] }];
    mocks.listObjects.mockResolvedValue([
      { name: "T", object_type: "TABLE", schema: "A", comment: "table comment" },
      { name: "P", object_type: "PROCEDURE", schema: "A" },
    ]);
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(group.objectCount).toBe(1));
    expect(group.children?.[0].comment).toBe("table comment");
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ directoryPage: true });
    expect(mocks.listObjects.mock.calls[0][3]).toEqual(["TABLE", "PROCEDURE"]);
    expect(routines.objectCount).toBe(1);
    expect(mocks.listTables).not.toHaveBeenCalled();
    await connections.loadTreeNodeChildren(group);
    expect(mocks.listObjects).toHaveBeenCalledOnce();
    const index = await connections.refreshSidebarTableSearchIndex(group.id);
    expect(index).toEqual([{ name: "T", table_type: "TABLE", comment: "table comment" }]);
    expect(mocks.listTables).not.toHaveBeenCalled();
  });
  it("searches a completely preloaded object directory without another request", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const group: TreeNode = { id: "A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "A", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: [group] }];
    mocks.listObjects.mockResolvedValue([{ name: "P_MATCH", object_type: "PROCEDURE", schema: "A" }]);
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(group.objectCount).toBe(1));
    const found = await connections.searchSidebarObjects(group, "MATCH", new AbortController().signal);
    expect(found.map((node) => node.label)).toEqual(["P_MATCH"]);
    expect(mocks.listObjects).toHaveBeenCalledOnce();
    await connections.searchSidebarObjects({ ...group, linkedServer: "remote" }, "MATCH", new AbortController().signal);
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
  });
  it.each(["table index", "object search"] as const)("reuses a completed directory for %s after leaving and restoring its selected scope", async (consumer) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const tables: TreeNode = { id: "c:A:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "A", schema: "A", children: [] };
    const routines: TreeNode = { id: "c:A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "A", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "c:A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: [tables, routines] }];
    const container = { connectionId: "c", kind: "schema" as const };
    connections.setRelationalNavigationSelection(container, { kind: "named", name: "A" });
    mocks.listObjects.mockResolvedValue([
      { name: "T_MATCH", object_type: "TABLE", schema: "A", comment: "cached" },
      { name: "P_MATCH", object_type: "PROCEDURE", schema: "A" },
    ]);
    await connections.preloadRelationalNavigation("c");
    expect([tables.objectCount, routines.objectCount]).toEqual([1, 1]);
    const children = routines.children;
    mocks.listObjects.mockClear();

    connections.setRelationalNavigationSelection(container, { kind: "all" });
    connections.setRelationalNavigationSelection(container, { kind: "named", name: "A" });
    if (consumer === "table index") expect(await connections.refreshSidebarTableSearchIndex(tables.id)).toEqual([{ name: "T_MATCH", table_type: "TABLE", comment: "cached" }]);
    else expect((await connections.searchSidebarObjects(routines, "MATCH", new AbortController().signal)).map((node) => node.label)).toEqual(["P_MATCH"]);

    expect(mocks.listObjects).not.toHaveBeenCalled();
    expect(mocks.listTables).not.toHaveBeenCalled();
    expect(routines.children).toBe(children);
    expect([tables.objectCount, routines.objectCount]).toEqual([1, 1]);
  });
  it.each(["refresh", "disconnect", "source replacement", "children replacement"] as const)("does not reuse a completed directory after %s", async (change) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    let group: TreeNode = { id: "c:A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "A", schema: "A", children: [] };
    const schema: TreeNode = { id: "c:A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: [group] };
    connections.treeNodes[0].children = [schema];
    mocks.listObjects.mockResolvedValue([{ name: "OLD_MATCH", object_type: "PROCEDURE", schema: "A" }]);
    await connections.preloadRelationalNavigation("c");
    expect(group.objectCount).toBe(1);
    mocks.listObjects.mockClear().mockResolvedValue([{ name: "NEW_MATCH", object_type: "PROCEDURE", schema: "A" }]);

    if (change === "refresh") await connections.refreshTreeNode(group);
    if (change === "disconnect") {
      await connections.disconnect("c", { markClosedByUser: false, skipTabHandling: true });
      connections.markConnectionConnected("c");
      connections.treeNodes[0].children = [schema];
    }
    if (change === "source replacement") {
      group = { ...group };
      schema.children = [group];
    }
    if (change === "children replacement") group.children = [...group.children!];
    const found = await connections.searchSidebarObjects(group, "MATCH", new AbortController().signal);

    expect(found.map((node) => node.label)).toEqual(["NEW_MATCH"]);
    expect(mocks.listObjects).toHaveBeenCalledOnce();
  });
  it("does not install an unfinished directory response after changing its selected scope", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const group: TreeNode = { id: "c:A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "A", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "c:A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: [group] }];
    const container = { connectionId: "c", kind: "schema" as const };
    connections.setRelationalNavigationSelection(container, { kind: "named", name: "A" });
    let finish!: (rows: unknown[]) => void;
    mocks.listObjects.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    connections.setRelationalNavigationSelection(container, { kind: "all" });
    finish([{ name: "LATE_MATCH", object_type: "PROCEDURE", schema: "A" }]);
    await loading;

    expect(group.children).toEqual([]);
    expect(group.objectCount).toBeUndefined();
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(false);
  });
  it.each([1000, 2000])("reads %s ordinary objects across types in exact 1000-row batches", async (count) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const groups: TreeNode[] = ["procedures", "functions"].map((kind) => ({ id: `A:__${kind}`, type: kind === "procedures" ? "group-procedures" : "group-functions", label: kind, connectionId: "c", database: "A", schema: "A", children: [] }));
    connections.treeNodes[0].children = [{ id: "A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: groups }];
    const objects = Array.from({ length: count }, (_, index) => ({ name: `OBJECT_${index}`, object_type: index % 2 ? "FUNCTION" : "PROCEDURE", schema: "A" }));
    mocks.listObjects.mockImplementation(async (_connection, _database, _schema, _types, _filter, limit, offset) => objects.slice(offset, offset + limit));
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(groups.map((group) => group.objectCount)).toEqual([count / 2, count / 2]));
    expect(mocks.listObjects.mock.calls.map((call) => [call[3], call[5], call[6], call[10]])).toEqual(Array.from({ length: count / 1000 + 1 }, (_, index) => [["PROCEDURE", "FUNCTION"], 1000, index * 1000, { directoryPage: true }]));
    expect(groups.every((group) => !group.isExpanded)).toBe(true);
  });
  it.each(["simple", "grouped"] as const)("cold loads the %s presentation through the same complete directory", async (mode) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    settings.editorSettings.sidebarObjectDisplay = mode;
    const schema: TreeNode = { id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0].children = [schema];
    const rows = [...Array.from({ length: 1000 }, (_, index) => ({ name: `T_${index}`, object_type: "TABLE", schema: "A" })), { name: "V_LAST", object_type: "VIEW", schema: "A" }];
    mocks.listObjects.mockImplementation(async (_connection, _database, _schema, types, _filter, limit, offset = 0) => rows.filter((row) => types.includes(row.object_type)).slice(offset, offset + limit));
    await connections.loadTables("c", "DB", "A");
    await vi.waitFor(() => expect(schema.children?.find((node) => node.type === "group-views")?.objectCount).toBe(1));
    const directories = mocks.listObjects.mock.calls.filter((call) => call[10]?.directoryPage);
    expect(directories.map((call) => [call[5], call[6]])).toEqual([
      [1000, 0],
      [1000, 1000],
    ]);
    expect(mocks.listTables).not.toHaveBeenCalled();
    const readCount = mocks.listObjects.mock.calls.length;
    const original = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!;
    expect(original.some((node) => node.type === "group-tables")).toBe(mode === "grouped");
    expect(await connections.loadTableForLocate({ connectionId: "c", database: "DB", schema: "A", tableName: "V_LAST" })).toBe(true);
    settings.editorSettings.sidebarObjectDisplay = mode === "simple" ? "grouped" : "simple";
    await connections.refreshNavigationPresentation("c");
    settings.editorSettings.sidebarObjectDisplay = mode;
    await connections.refreshNavigationPresentation("c");
    await connections.loadTables("c", "DB", "A");
    expect(mocks.listObjects).toHaveBeenCalledTimes(readCount);
    expect(mocks.listTables).not.toHaveBeenCalled();
  });
  it("preserves per-category loading for a custom Oracle driver profile", async () => {
    const { connections } = await stores("oracle", { default_schema: "A", driver_profile: "oracle-legacy" });
    connections.treeNodes[0].children = [
      {
        id: "A",
        type: "schema",
        label: "A",
        connectionId: "c",
        database: "A",
        schema: "A",
        children: ["procedures", "functions"].map((kind) => ({ id: `A:__${kind}`, type: kind === "procedures" ? "group-procedures" : "group-functions", label: kind, connectionId: "c", database: "A", schema: "A", children: [] })),
      },
    ];
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(mocks.listObjects.mock.calls.map((call) => call[3])).toEqual([["PROCEDURE"], ["FUNCTION"]]);
    expect(mocks.listObjects.mock.calls.every((call) => !call[10]?.directoryPage)).toBe(true);
  });
  it("groups table and view batches locally while retaining a partition whose parent arrives on the next page", async () => {
    const { connections } = await stores("postgres", { database: "db", default_schema: "public" });
    const groups: TreeNode[] = [
      { id: "public:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "db", schema: "public", children: [] },
      { id: "public:__views", type: "group-views", label: "Views", connectionId: "c", database: "db", schema: "public", children: [] },
    ];
    connections.treeNodes[0].children = [{ id: "db", type: "database", label: "db", connectionId: "c", database: "db", children: [{ id: "public", type: "schema", label: "public", connectionId: "c", database: "db", schema: "public", children: groups }] }];
    const rows = [...Array.from({ length: 999 }, (_, index) => ({ name: `T_${index}`, table_type: "TABLE" })), { name: "PARTITION", table_type: "TABLE", parent_name: "ROOT", parent_schema: "public" }, { name: "ROOT", table_type: "TABLE", comment: "root comment" }];
    mocks.listTables.mockImplementation(async (_connection, _database, _schema, _filter, limit, offset) => rows.slice(offset, offset + limit));
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(groups.map((group) => group.objectCount)).toEqual([1000, 0]));
    expect(groups[0].children?.some((node) => node.label === "PARTITION")).toBe(false);
    const root = groups[0].children?.find((node) => node.label === "ROOT");
    expect(root?.comment).toBe("root comment");
    expect(root?.children?.some((node) => node.children?.some((child) => child.label === "PARTITION"))).toBe(true);
    expect(mocks.listTables.mock.calls.map((call) => [call[4], call[5], call[6]])).toEqual([
      [1000, 0, ["TABLE", "VIEW"]],
      [1000, 1000, ["TABLE", "VIEW"]],
    ]);
  });
  it("leaves partial batch counts blank and shares the batch with a foreground expansion", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const groups: TreeNode[] = ["procedures", "functions"].map((kind) => ({ id: `db:__${kind}`, type: kind === "procedures" ? "group-procedures" : "group-functions", label: kind, connectionId: "c", database: "db", children: [] }));
    connections.treeNodes[0].children = [{ id: "db", type: "database", label: "db", connectionId: "c", database: "db", children: groups }];
    let finish!: (value: unknown[]) => void;
    mocks.listObjects.mockImplementation(async (_connection, _database, _schema, _types, _filter, _limit, offset) =>
      offset === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ name: `P_${index}`, object_type: "PROCEDURE" }))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(groups[0].children).toHaveLength(1000);
    expect(groups[0].objectCount).toBeUndefined();
    expect(oracleNavigationAuxiliaryText({ ...groups[0], relationalNavigationSources: [groups[0].id] }, (key) => key)).toBe("");
    const expansion = connections.loadTreeNodeChildren(groups[1]);
    finish([{ name: "F_LAST", object_type: "FUNCTION" }]);
    await expansion;
    await vi.waitFor(() => expect(groups.map((group) => group.objectCount)).toEqual([1000, 1]));
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
    expect(groups[1].isExpanded).toBe(true);
  });
  it("does not overwrite a category refreshed during a shared batch, while completing the other category", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const groups: TreeNode[] = ["procedures", "functions"].map((kind) => ({ id: `A:__${kind}`, type: kind === "procedures" ? "group-procedures" : "group-functions", label: kind, connectionId: "c", database: "A", schema: "A", children: [] }));
    connections.treeNodes[0].children = [{ id: "A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: groups }];
    let finish!: (value: unknown[]) => void;
    mocks.listObjects.mockImplementation(async (_connection, _database, _schema, types) =>
      types.length > 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : [{ name: "FRESH", object_type: "PROCEDURE", schema: "A" }],
    );
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await connections.loadTreeNodeChildren(groups[0], { force: true });
    finish([
      { name: "OLD", object_type: "PROCEDURE", schema: "A" },
      { name: "F", object_type: "FUNCTION", schema: "A" },
    ]);
    await vi.waitFor(() => expect(groups[1].objectCount).toBe(1));
    expect(groups[0].children?.map((node) => node.label)).toEqual(["FRESH"]);
    expect(groups[0].objectCount).toBe(1);
  });
  it("finishes a refreshed partial first page instead of treating its numeric count as complete", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const group: TreeNode = { id: "db:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "db", children: [] };
    connections.treeNodes[0].children = [{ id: "db", type: "database", label: "db", connectionId: "c", database: "db", children: [group] }];
    const tables = Array.from({ length: 1002 }, (_, index) => ({ name: `T_${index}`, table_type: "TABLE" }));
    mocks.listTables.mockImplementation(async (_connection, _database, _schema, _filter, limit, offset) => tables.slice(offset, offset + limit));
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "group-tables")!;
    await connections.loadRelationalNavigationGroup(projected, true);
    await vi.waitFor(() => expect(group.objectCount).toBe(1002));
    expect(group.children?.some((node) => node.type === "load-more")).toBe(false);
    expect(mocks.listTables.mock.calls[1][4]).toBe(1000);
  });
  it("does not cache a late directory response across disconnect and reconnect", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const group = (): TreeNode => ({ id: "db:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "db", children: [] });
    const install = (source: TreeNode) => {
      connections.treeNodes[0].children = [{ id: "db", type: "database", label: "db", connectionId: "c", database: "db", children: [source] }];
    };
    install(group());
    let finish!: (value: unknown[]) => void;
    mocks.listObjects
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce([{ name: "FRESH", object_type: "PROCEDURE" }]);
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await connections.disconnect("c", { markClosedByUser: false, skipTabHandling: true });
    finish([{ name: "STALE", object_type: "PROCEDURE" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    connections.markConnectionConnected("c");
    const fresh = group();
    install(fresh);
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(fresh.objectCount).toBe(1));
    expect(fresh.children?.map((node) => node.label)).toEqual(["FRESH"]);
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
  });
  it("restores a directory count after a parent refresh replaces loaded contents with a placeholder", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const group: TreeNode = { id: "c:db:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "db", children: [], isExpanded: false };
    connections.treeNodes[0].children = [{ id: "c:db", type: "database", label: "db", connectionId: "c", database: "db", children: [group] }];
    mocks.listTables.mockResolvedValue([]);
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(group.objectCount).toBe(0));
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(true);
    group.children = [];
    group.objectCount = undefined;
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(group.objectCount).toBe(0));
    expect(group.isExpanded).toBe(false);
    expect(mocks.listTables).toHaveBeenCalledOnce();
  });
  it("clears a directory read failure after a successful explicit refresh", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const group: TreeNode = { id: "c:db:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "db", children: [] };
    const other: TreeNode = { ...group, id: "c:other:__tables", database: "other", children: [] };
    connections.treeNodes[0].children = [group, other].map((source) => ({ id: `c:${source.database}`, type: "database", label: source.database!, connectionId: "c", database: source.database, children: [source] }));
    connections.setRelationalNavigationSelection({ connectionId: "c", kind: "database" }, { kind: "all" });
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "group-tables")!;
    mocks.listTables.mockRejectedValueOnce(new Error("temporary directory failure"));
    await expect(connections.loadRelationalNavigationGroup(projected, true)).rejects.toThrow("temporary directory failure");
    expect(group.oracleNavigationStatus?.kind).toBe("error");
    expect(group.objectCount).toBeUndefined();
    expect(other.objectCount).toBe(0);
    mocks.listTables.mockResolvedValueOnce([]);
    await connections.loadRelationalNavigationGroup(projected, true);
    expect(group.oracleNavigationStatus).toBeUndefined();
    expect(group.objectCount).toBe(0);
  });
  it.each(["background", "foreground"])("keeps a successful forced refresh when an older %s directory request fails", async (mode) => {
    const { connections } = await stores("mysql", { database: "db" });
    const group: TreeNode = { id: "c:db:__tables", type: "group-tables", label: "Tables", connectionId: "c", database: "db", children: [] };
    connections.treeNodes[0].children = [{ id: "c:db", type: "database", label: "db", connectionId: "c", database: "db", children: [group] }];
    let rejectOld!: (reason: Error) => void;
    mocks.listTables
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce([]);
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "group-tables")!;
    const previous = mode === "foreground" ? connections.loadRelationalNavigationGroup(projected, true).catch(() => undefined) : connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    await connections.loadRelationalNavigationGroup(projected, true);
    expect(group.objectCount).toBe(0);
    rejectOld(new Error("older background failure"));
    await previous;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(group.oracleNavigationStatus).toBeUndefined();
    expect(group.objectCount).toBe(0);
  });
  it("preloads the complete selected scope while a search is active and retains it after clearing search", async () => {
    const { connections } = await stores("mysql", { database: "A" });
    connections.treeNodes[0].children = ["A", "B"].map((database) => ({ id: `c:${database}`, type: "database", label: database, connectionId: "c", database, children: [] }));
    mocks.listTables.mockImplementation(async (_connection, _database, _schema, filter) => [{ name: "MATCH", table_type: "TABLE" }, ...(!filter ? [{ name: "OTHER", table_type: "TABLE" }] : [])]);
    connections.sidebarSearchQuery = "MATCH";
    await connections.changeRelationalNavigationSelection({ connectionId: "c", kind: "database" }, { kind: "named", name: "B" });
    const group = connections.treeNodes[0].children![1].children!.find((node) => node.type === "group-tables")!;
    await vi.waitFor(() => expect(group.objectCount).toBeDefined());
    connections.sidebarSearchQuery = "";
    connections.discardFilteredTreeNodeChildren(group);
    expect(group.children?.map((node) => node.label)).toEqual(["MATCH", "OTHER"]);
    expect(group.objectCount).toBe(2);
  });
  it("rejects a late preload after disconnect without repopulating the raw source", async () => {
    const { connections } = await stores("mysql", { database: "db" });
    const group: TreeNode = { id: "db:__tables", type: "group-tables", label: "tree.tables", connectionId: "c", database: "db", children: [], isExpanded: false };
    connections.treeNodes[0].children = [{ id: "db", type: "database", label: "db", database: "db", connectionId: "c", children: [group] }];
    let finish!: (tables: unknown[]) => void;
    mocks.listTables.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    connections.connectedIds.delete("c");
    finish([{ name: "late", table_type: "TABLE" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(group.children).toEqual([]);
    expect(group.objectCount).toBeUndefined();
    expect(connections.connectedIds.has("c")).toBe(false);
  });
  it.each([false, true])("waits for an in-flight root load (force=%s) before initializing background directories", async (force) => {
    const { connections } = await stores("postgres", { database: "db" });
    let finish!: (value: { name: string }[]) => void;
    mocks.listDatabases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.listSchemaInfos.mockResolvedValueOnce([{ name: "public" }]);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["schema"], rows: [["public"]] });
    const loading = connections.loadDatabases("c", { force, connectedOnly: true, background: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const initializing = connections.initializeRelationalNavigation("c");
    finish([{ name: "db" }]);
    await loading;
    await initializing;
    await vi.waitFor(() => {
      const database = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "database")!;
      expect(database.children!.find((node) => node.type === "group-tables")?.objectCount).toBe(0);
    });
    expect(connections.treeNodes[0].isExpanded).toBeFalsy();
  });
  it("initializes background directories while retaining a collapsed connection", async () => {
    const { connections } = await stores("mysql", { database: "init-db" });
    connections.treeNodes[0].isExpanded = false;
    mocks.listDatabases.mockResolvedValueOnce([{ name: "init-db" }]);
    await connections.initializeRelationalNavigation("c");
    await vi.waitFor(() => expect(mocks.listTables.mock.calls.some((call) => call[1] === "init-db")).toBe(true));
    expect(connections.treeNodes[0].isExpanded).toBe(false);
    expect(connections.treeNodes[0].children!.filter((node) => node.type === "database").every((node) => !node.isExpanded)).toBe(true);
    expect(connections.selectedTreeNodeId).toBeNull();
  });
  it("keeps a background schema collapsed when directory placeholders are restored from a fresh cache", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const schema: TreeNode = { id: "c:A:A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", isExpanded: false, children: [] };
    connections.treeNodes[0].children = [schema];
    mocks.loadSchemaCache.mockResolvedValueOnce(encodeSchemaTreeCache([{ id: "tables", type: "group-tables", label: "Tables", connectionId: "c", database: "A", schema: "A", children: [] }]));
    await connections.loadTables("c", "A", "A", { background: true, connectedOnly: true });
    expect(schema.isExpanded).toBe(false);
    expect(schema.children!.some((node) => node.type === "group-tables")).toBe(true);
    expect(mocks.listTables).not.toHaveBeenCalled();
  });
  it("keeps all four job categories lazy while preloading public links", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    mocks.executeQuery.mockResolvedValue({ columns: ["OWNER", "DB_LINK"], rows: [] });
    const groups = oracleSchemaJobGroups({ id: "A", connectionId: "c", database: "A", schema: "A" });
    const shared = oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle");
    connections.treeNodes[0].children = [{ id: "A", type: "schema", label: "A", connectionId: "c", database: "A", schema: "A", children: groups }, shared];
    connections.preloadRelationalNavigation("c");
    await vi.waitFor(() => expect(shared.children![0].objectCount).toBe(0));
    expect(mocks.nativeJobList).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("tree.jobs");
    expect(groups[0].children!.map((node) => node.nativeJobPage)).toEqual([
      { schema: "A", kind: "scheduler", schedulerCategory: "regular" },
      { schema: "A", kind: "scheduler", schedulerCategory: "lightweight" },
      { schema: "A", kind: "scheduler", schedulerCategory: "in-memory" },
      { schema: "A", kind: "legacy" },
    ]);
    expect(groups.every((node) => !node.isExpanded)).toBe(true);
    expect(groups[0].children!.every((node) => !node.isExpanded)).toBe(true);
    expect(shared.children![0].isExpanded).toBe(false);
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it.each([0, 1])("does not restart a complete Oracle link preload with %i links on scope roundtrip", async (count) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    mocks.executeQuery.mockResolvedValue({ columns: ["OWNER", "DB_LINK", "USERNAME", "HOST"], rows: count ? [["PUBLIC", "fixture_link", "fixture_user", "fixture_host"]] : [] });
    const shared = oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle");
    connections.treeNodes[0].children = [shared];
    const source = connections.treeNodes[0].children![0].children![0];
    await connections.preloadRelationalNavigation("c");
    expect(source.objectCount).toBe(count);
    expect(connections.isTreeNodeChildrenLoaded(source.id)).toBe(true);
    const loading: boolean[] = [];
    const stop = watch(
      () => source.isLoading,
      (value) => loading.push(!!value),
      { flush: "sync" },
    );
    const reads = mocks.executeQuery.mock.calls.length;
    const children = source.children;
    try {
      for (const selection of [{ kind: "all" } as const, { kind: "named", name: "A" } as const]) {
        connections.setRelationalNavigationSelection({ connectionId: "c", kind: "schema" }, selection);
        await connections.preloadRelationalNavigation("c");
      }
      expect(loading).toEqual([]);
      expect(source.children).toBe(children);
      expect(source.objectCount).toBe(count);
      expect(mocks.executeQuery).toHaveBeenCalledTimes(reads);
      expect(source.isExpanded).toBe(false);
    } finally {
      stop();
    }
  });
  it.each(["unconfirmed", "error", "truncated", "load-more", "hidden-load-more"] as const)("does not treat an Oracle link %s preload as complete", async (state) => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    mocks.executeQuery.mockResolvedValue({ columns: ["OWNER", "DB_LINK", "USERNAME", "HOST"], rows: [["PUBLIC", "fixture_link", "fixture_user", "fixture_host"]] });
    connections.treeNodes[0].children = [oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle")];
    const source = connections.treeNodes[0].children![0].children![0];
    await connections.preloadRelationalNavigation("c");
    if (state === "unconfirmed") source.objectCount = undefined;
    else if (state === "error" || state === "truncated") source.oracleNavigationStatus = { kind: state, reason: "fixture" };
    else {
      const more: TreeNode = { id: `${source.id}:more`, type: "load-more", label: "more" };
      if (state === "load-more") source.children!.push(more);
      else source.hiddenChildren = [more];
    }
    const loading: boolean[] = [];
    const stop = watch(
      () => source.isLoading,
      (value) => loading.push(!!value),
      { flush: "sync" },
    );
    try {
      await connections.preloadRelationalNavigation("c");
      expect(loading).toContain(true);
      expect(source.isLoading).toBeFalsy();
    } finally {
      stop();
    }
  });
  it("still enters the Oracle link loader when a complete group is explicitly refreshed", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    mocks.executeQuery.mockResolvedValue({ columns: ["OWNER", "DB_LINK"], rows: [] });
    connections.treeNodes[0].children = [oracleSharedObjects({ id: "c", connectionId: "c" }, "oracle")];
    const source = connections.treeNodes[0].children![0].children![0];
    await connections.preloadRelationalNavigation("c");
    const loading: boolean[] = [];
    const stop = watch(
      () => source.isLoading,
      (value) => loading.push(!!value),
      { flush: "sync" },
    );
    try {
      await connections.refreshTreeNode(source);
      expect(loading).toContain(true);
      expect(source.isLoading).toBeFalsy();
      expect(source.objectCount).toBe(0);
    } finally {
      stop();
    }
  });
  it("preserves nonrelational database workspaces", async () => {
    const { connections } = await stores("mongodb");
    const collection: TreeNode = { id: "collection", type: "table", label: "orders", connectionId: "c", database: "app" };
    connections.treeNodes[0].children = [{ id: "mongo-db", type: "mongo-db", label: "app", connectionId: "c", database: "app", children: [collection] }];
    expect(connections.projectRelationalNavigationTree(connections.treeNodes)).toEqual(connections.treeNodes);
  });
  it.each(["oracle", "doris", "sqlserver"] as const)("projects %s scope selectors without reading object directory children", async (databaseType) => {
    const { connections } = await stores(databaseType, { database: "DB", default_schema: "A" });
    let objectChildrenReads = 0;
    const directory = (id: string, target: Partial<TreeNode>): TreeNode => {
      const leaf: TreeNode = { id: `${id}:table`, label: "T", type: "table", connectionId: "c", ...target };
      return {
        id: `${id}:tables`,
        label: "Tables",
        type: "group-tables",
        connectionId: "c",
        ...target,
        get children() {
          objectChildrenReads++;
          return [leaf];
        },
      };
    };
    const schemas = (parent: string, target: Partial<TreeNode> = {}): TreeNode[] =>
      ["A", "B"].map((schema) => ({
        id: `${parent}:${schema}`,
        label: schema,
        type: target.linkedServer ? "linked-server-schema" : "schema",
        connectionId: "c",
        database: "DB",
        schema,
        ...target,
        ...(target.linkedServer ? { linkedSchema: schema } : {}),
        children: [directory(`${parent}:${schema}`, { database: "DB", schema, ...target })],
      }));
    const connection = connections.treeNodes[0];
    connection.isExpanded = true;
    if (databaseType === "oracle") connection.children = schemas("c");
    if (databaseType === "doris")
      connection.children = ["open", "closed"].map((catalog) => ({
        id: `c:${catalog}`,
        label: catalog,
        type: "doris-catalog",
        connectionId: "c",
        catalog,
        isExpanded: catalog === "open",
        children: ["DB", "other"].map((database) => ({ id: `c:${catalog}:${database}`, label: database, type: "database", connectionId: "c", database, catalog, children: [directory(`c:${catalog}:${database}`, { database, catalog })] })),
      }));
    if (databaseType === "sqlserver")
      connection.children = [
        { id: "c:DB", label: "DB", type: "database", connectionId: "c", database: "DB", isExpanded: true, children: schemas("c:DB") },
        {
          id: "c:links",
          label: "Links",
          type: "linked-server-root",
          connectionId: "c",
          isExpanded: true,
          children: [
            {
              id: "c:links:server",
              label: "Server",
              type: "linked-server",
              connectionId: "c",
              linkedServer: "Server",
              isExpanded: true,
              children: ["open", "closed"].map((linkedCatalog) => ({
                id: `c:links:${linkedCatalog}`,
                label: linkedCatalog,
                type: "linked-server-catalog",
                connectionId: "c",
                database: "DB",
                linkedServer: "Server",
                linkedCatalog,
                isExpanded: linkedCatalog === "open",
                children: schemas(`c:links:${linkedCatalog}`, { linkedServer: "Server", linkedCatalog }),
              })),
            },
          ],
        },
      ];
    const visibleSelectors = (nodes: readonly TreeNode[]): TreeNode[] => nodes.flatMap((node) => (node.type === "relational-scope" ? [node] : node.isExpanded ? visibleSelectors(node.children ?? []) : []));
    const snapshot = (nodes: readonly TreeNode[]) => visibleSelectors(nodes).map((node) => ({ id: node.id, container: node.relationalNavigationContainer, options: node.relationalNavigationOptions, selection: node.relationalNavigationSelection }));
    const initial = connections.projectRelationalNavigationTree(connections.treeNodes);
    expect(visibleSelectors(initial)).toHaveLength(databaseType === "sqlserver" ? 2 : 1);
    expect(snapshot(connections.projectRelationalNavigationTree(connections.treeNodes, false, false))).toEqual(snapshot(initial));
    connections.setRelationalNavigationSelection(visibleSelectors(initial)[0].relationalNavigationContainer!, { kind: "all" });
    const expected = snapshot(connections.projectRelationalNavigationTree(connections.treeNodes));
    objectChildrenReads = 0;

    const selectorsOnly = connections.projectRelationalNavigationTree(connections.treeNodes, false, false);

    expect(snapshot(selectorsOnly)).toEqual(expected);
    expect(objectChildrenReads).toBe(0);
    expect(connections.projectRelationalNavigationTree(connections.treeNodes, true, false)).toEqual(connections.projectRelationalNavigationTree(connections.treeNodes, true));
  });
  it("does not traverse an object directory when the selector projection passes through a container without ranges", async () => {
    const { connections } = await stores("postgres");
    let reads = 0;
    connections.treeNodes[0].isExpanded = true;
    connections.treeNodes[0].children = [
      {
        id: "c:DB",
        label: "DB",
        type: "database",
        connectionId: "c",
        database: "DB",
        isExpanded: true,
        children: [
          {
            id: "c:DB:tables",
            label: "Tables",
            type: "group-tables",
            connectionId: "c",
            database: "DB",
            get children() {
              reads++;
              return [{ id: "c:DB:T", label: "T", type: "table" }];
            },
          },
        ],
      },
    ];

    connections.projectRelationalNavigationTree(connections.treeNodes, false, false);

    expect(reads).toBe(0);
  });
  it("does not substitute another loaded schema while the selected schema has no directories yet", async () => {
    const { connections } = await stores("oracle", { default_schema: "B" });
    mocks.listSchemas.mockResolvedValueOnce(["A", "B"]);
    await connections.loadDatabases("c", { force: true, connectedOnly: true });
    const a = connections.treeNodes[0].children!.find((node) => node.schema === "A")!;
    a.children = [{ id: "A-tables", type: "group-tables", label: "Tables", connectionId: "c", database: "A", schema: "A", children: [{ id: "A-ONLY", label: "A-ONLY", type: "table", connectionId: "c", database: "A", schema: "A" }] }];
    const children = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!;
    expect(children.find((node) => node.type === "relational-scope")?.relationalNavigationSelection).toEqual({ kind: "named", name: "B" });
    expect(children.flatMap((node) => node.children ?? []).some((node) => node.id === "A-ONLY")).toBe(false);
  });
  it("keeps catalog database pickers independent while retaining catalog identity on every object", async () => {
    const { connections } = await stores("doris", { database: "same" });
    connections.treeNodes[0].children = ["one", "two"].map((catalog) => ({
      id: `catalog-${catalog}`,
      type: "doris-catalog",
      label: catalog,
      connectionId: "c",
      catalog,
      children: ["same", "other"].map((database) => ({ id: `${catalog}-${database}`, type: "database", label: database, connectionId: "c", database, catalog, children: [{ id: `${catalog}-${database}-table`, type: "table", label: "T", connectionId: "c", database, catalog }] })),
    }));
    const catalogs = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!;
    const picker = catalogs[0].children!.find((node) => node.type === "relational-scope")!;
    connections.setRelationalNavigationSelection(picker.relationalNavigationContainer!, { kind: "named", name: "other" });
    const selected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!;
    expect(selected.map((catalog) => catalog.children!.filter((node) => node.type === "table").map((node) => [node.id, node.catalog]))).toEqual([[["one-other-table", "one"]], [["two-same-table", "two"]]]);
  });
  it("uses readable linked schema choices without applying the local default or changing encoded targets", async () => {
    const { connections } = await stores("sqlserver", { database: "DB", default_schema: "A" });
    const catalog: TreeNode = { id: "remote", type: "linked-server-catalog", label: "Remote", connectionId: "c", database: "DB", linkedServer: "Server", linkedCatalog: "Remote", children: [] };
    connections.treeNodes[0].children = [catalog];
    await connections.loadSqlServerLinkedServerSchemas(catalog, { force: true });
    for (const schema of catalog.children!) schema.children = [{ ...schema, id: `${schema.id}-table`, type: "table", label: "T", tableName: "T", children: undefined }];
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children![0];
    const picker = projected.children!.find((node) => node.type === "relational-scope")!;
    expect(picker.relationalNavigationOptions).toEqual(["A", "B"]);
    expect(picker.relationalNavigationSelection).toEqual({ kind: "all" });
    connections.setRelationalNavigationSelection(picker.relationalNavigationContainer!, { kind: "named", name: "B" });
    const selected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children![0].children!.filter((node) => node.type === "table");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ schema: catalog.children![1].schema, linkedServer: "Server", linkedCatalog: "Remote", linkedSchema: "B" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    mocks.listSqlServerLinkedServerSchemas.mockResolvedValueOnce([]);
    await connections.loadSqlServerLinkedServerSchemas(catalog, { force: true });
    expect(connections.relationalNavigationSelection(picker.relationalNavigationContainer!, [], false)).toEqual({ kind: "all" });
  });
  it("retains flat object entries and their real targets when the saved display mode has no object directories", async () => {
    const { connections } = await stores("postgres", { default_schema: "A" });
    const schemas: TreeNode[] = ["A", "B"].map((schema) => ({ id: schema, type: "schema", label: schema, connectionId: "c", database: "DB", schema, children: [{ id: `${schema}-table`, label: "SAME", type: "table", connectionId: "c", database: "DB", schema, tableName: "SAME" }] }));
    connections.treeNodes[0].children = [{ id: "DB", type: "database", label: "DB", database: "DB", connectionId: "c", children: schemas }];
    const selected = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children![0];
    expect(selected.children?.filter((child) => child.type === "table").map((child) => child.id)).toEqual(["A-table"]);
    const picker = selected.children!.find((child) => child.type === "relational-scope")!;
    connections.setRelationalNavigationSelection(picker.relationalNavigationContainer!, { kind: "all" });
    const all = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children![0];
    expect(all.children?.filter((child) => child.type === "table").map((child) => [child.id, child.schema, child.relationalNavigationOwner])).toEqual([
      ["A-table", "A", "A"],
      ["B-table", "B", "B"],
    ]);
    expect(schemas[0].children![0].relationalNavigationOwner).toBeUndefined();
  });
  it("removes cached query shortcuts while keeping SQL library content and linked query drafts", async () => {
    const { connections, queries } = await stores("mysql", { database: "db" });
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const savedSql = useSavedSqlStore();
    savedSql.files = [{ id: "saved", name: "kept.sql", connectionId: "c", database: "db", sql: "SELECT 'saved content'", createdAt: "2026-11-03", updatedAt: "2026-11-03", sqlLoaded: true }];
    const tabId = queries.createTab("c", "db", "kept.sql", "query");
    const tab = queries.tabs.find((item) => item.id === tabId)!;
    tab.savedSqlId = "saved";
    queries.updateSql(tabId, "SELECT 'unsaved draft'");
    connections.treeNodes[0].children = [
      { id: "c:db", type: "database", label: "db", connectionId: "c", database: "db", children: [{ id: "old-queries", type: "saved-sql-root", label: "Queries", connectionId: "c", database: "db", children: [{ id: "saved-node", type: "saved-sql-file", label: "kept.sql", savedSqlId: "saved" }] }] },
    ];
    mocks.listDatabases.mockResolvedValueOnce([{ name: "db" }]);
    await connections.loadDatabases("c", { force: true, connectedOnly: true });
    await connections.loadTables("c", "db", undefined, { force: true, connectedOnly: true });
    expect(JSON.stringify(connections.treeNodes)).not.toContain("saved-sql-root");
    expect(JSON.stringify(connections.treeNodes)).not.toContain("saved-sql-file");
    expect(savedSql.getFile("saved")?.sql).toBe("SELECT 'saved content'");
    expect(tab).toMatchObject({ savedSqlId: "saved", sql: "SELECT 'unsaved draft'", database: "db" });
  });
  it("isolates transient aggregate creation from existing pages and disk restoration", async () => {
    const { queries } = await stores("oracle");
    const fixed = queries.openDatabaseJobAdmin("c", undefined, { database: "DB", schema: "A", kind: "scheduler" });
    const targets = [
      { database: "DB", schema: "A", kind: "scheduler" as const },
      { database: "DB", schema: "B", kind: "scheduler" as const },
    ];
    const first = queries.openDatabaseJobCreation("c", targets);
    const second = queries.openDatabaseJobCreation("c", targets);
    expect(new Set([fixed, first, second]).size).toBe(3);
    targets[0].schema = "CHANGED";
    expect(queries.tabs.find((tab) => tab.id === first)?.nativeJobCreationTargets?.[0].schema).toBe("A");
    await queries.resolveNativeJobNavigation(first!);
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    expect(serializeOpenTabs(queries.tabs).map((tab) => tab.id)).toEqual([fixed]);
    expect(queries.tabs.find((tab) => tab.id === fixed)?.nativeJobPage?.schema).toBe("A");
  });
  it("keeps an untargeted table form out of disk restoration and binds the selected catalog without reusing an existing editor", async () => {
    const { queries } = await stores("postgres");
    const existing = queries.openTableStructure("c", "DB", "A", "existing");
    const id = queries.openTableCreation("c", [
      { database: "DB", schema: "A", catalog: "one" },
      { database: "DB", schema: "B", catalog: "two" },
    ]);
    const tab = queries.tabs.find((tab) => tab.id === id)!;
    expect(id).not.toBe(existing);
    expect(tab.database).toBe("");
    expect(serializeOpenTabs(queries.tabs).map((tab) => tab.id)).toEqual([existing]);
    queries.selectTableCreationTarget(id!, 1);
    expect(tab).toMatchObject({ database: "DB", schema: "B", catalog: "two", structureCreationTargetIndex: 1 });
    expect(serializeOpenTabs(queries.tabs).find((tab) => tab.id === id)).toMatchObject({ database: "DB", schema: "B", catalog: "two" });
    queries.selectTableCreationTarget(id!, 0);
    expect(tab).toMatchObject({ schema: "A", catalog: "one" });
    expect(queries.tabs.find((tab) => tab.id === existing)?.schema).toBe("A");
  });
  it("requires an explicit template target before execution and generates SQL only for the first selection", async () => {
    const { queries } = await stores("mysql");
    const id = queries.openObjectTemplateCreation("c", [
      { database: "one", nodeType: "group-procedures" },
      { database: "two", nodeType: "group-procedures" },
    ])!;
    const tab = queries.tabs.find((tab) => tab.id === id)!;
    expect(tab.sql).toBe("");
    expect(serializeOpenTabs(queries.tabs)).toEqual([]);
    expect(await queries.executeTabSql(id, "SELECT 1")).toBe(false);
    expect(await queries.explainTabSql(id, "SELECT 1", "mysql")).toEqual({ ok: false, reason: "empty" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    queries.selectObjectTemplateTarget(id, 0);
    expect(tab.sql).toContain("CREATE PROCEDURE `one`.`new_procedure`");
    queries.updateSql(id, "SELECT 'keep user input'");
    tab.explainSql = "EXPLAIN SELECT 'old target'";
    tab.lastExplainedSql = "SELECT 'old target'";
    queries.selectObjectTemplateTarget(id, 1);
    expect(tab).toMatchObject({ database: "two", sql: "SELECT 'keep user input'" });
    expect(tab.explainSql).toBeUndefined();
    expect(tab.lastExplainedSql).toBeUndefined();
    expect(serializeOpenTabs(queries.tabs)[0]).toMatchObject({ database: "two", sql: "SELECT 'keep user input'" });
    tab.isExplaining = true;
    queries.selectObjectTemplateTarget(id, 0);
    expect(tab.database).toBe("two");
  });
  it("binds a new view to the exact first schema without overwriting its SQL on later target changes", async () => {
    const { queries } = await stores("postgres");
    const id = queries.openObjectTemplateCreation("c", [
      { database: "DB", schema: "A", catalog: "one", nodeType: "group-views" },
      { database: "DB", schema: "B", catalog: "two", nodeType: "group-views" },
    ])!;
    queries.selectObjectTemplateTarget(id, 0);
    const tab = queries.tabs.find((tab) => tab.id === id)!;
    const sql = tab.sql;
    expect(sql).toContain("CREATE VIEW");
    expect(sql).toContain("A");
    expect(tab.objectSource).toMatchObject({ schema: "A", name: "new_view", objectType: "VIEW" });
    queries.selectObjectTemplateTarget(id, 1);
    expect(tab).toMatchObject({ database: "DB", schema: "B", catalog: "two", sql });
  });
  it("requires a scoped Oracle page and reuses its exact selections without mutating the caller", async () => {
    const { queries } = await stores("oracle");
    const first = { kind: "scheduler" as const, owner: "Owner.One", name: 'Job,"One' };
    expect(queries.openDatabaseJobAdmin("c", first)).toBeUndefined();
    const page = { database: "DB", schema: first.owner, kind: "scheduler" as const };
    const id = queries.openDatabaseJobAdmin("c", first, page);
    first.owner = "Changed outside";
    expect(queries.tabs[0]).toMatchObject({ id, mode: "database-jobs", database: "DB", nativeJobAdmin: { owner: "Owner.One", name: 'Job,"One' } });
    const again = queries.openDatabaseJobAdmin("c", { kind: "scheduler", owner: "Owner.One", name: "NEXT" }, page);
    expect(again).toBe(id);
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]?.nativeJobAdmin).toEqual({ kind: "scheduler", owner: "Owner.One", name: "NEXT" });
    expect(treeNodeRowAction("native-job", false, "double", "oracle")).toBe("none");
  }, 30_000);
  it("isolates scoped tabs by database, schema and job kind", async () => {
    const { queries } = await stores("oracle");
    const selection = { kind: "scheduler" as const, owner: "A", name: "SAME" };
    const a = queries.openDatabaseJobAdmin("c", selection, { database: "DB", schema: "A", kind: "scheduler" });
    const b = queries.openDatabaseJobAdmin("c", { ...selection, owner: "B" }, { database: "DB", schema: "B", kind: "scheduler" });
    const legacy = queries.openDatabaseJobAdmin("c", undefined, { database: "DB", schema: "A", kind: "legacy" });
    const otherDatabase = queries.openDatabaseJobAdmin("c", selection, { database: "OTHER", schema: "A", kind: "scheduler" });
    expect(new Set([a, b, legacy, otherDatabase]).size).toBe(4);
    expect(queries.openDatabaseJobAdmin("c", undefined, { database: "DB", schema: "A", kind: "scheduler" })).toBe(a);
    expect(queries.tabs.find((tab) => tab.id === a)?.nativeJobAdmin).toEqual(selection);
    expect(queries.tabs.find((tab) => tab.id === b)?.nativeJobPage).toEqual({ schema: "B", kind: "scheduler" });
    expect(queries.openDatabaseJobAdmin("c", { ...selection, owner: "B" }, { database: "DB", schema: "A", kind: "scheduler" })).toBeUndefined();
    expect(queries.openDatabaseJobAdmin("c", { kind: "legacy", jobId: "9007199254740993" }, { database: "DB", schema: "A", kind: "scheduler" })).toBeUndefined();
    expect(queries.tabs.find((tab) => tab.id === a)?.nativeJobAdmin).toEqual(selection);
  }, 30_000);
  it("keeps the existing Dameng tab entry and does not create a second parallel page", async () => {
    const { queries } = await stores("dameng");
    const old = queries.openDamengJobAdmin("c");
    expect(queries.openDatabaseJobAdmin("c")).toBe(old);
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]?.mode).toBe("dameng-jobs");
  });
  it("owns session drafts per tab, isolates duplicates and preserves an explicitly reopened tab", async () => {
    const { queries } = await stores("oracle");
    const selection = { kind: "scheduler" as const, owner: "A", name: "SAME" };
    const aId = queries.openDatabaseJobAdmin("c", selection, { database: "DB", schema: "A", kind: "scheduler" })!;
    const bId = queries.openDatabaseJobAdmin("c", { ...selection, owner: "B" }, { database: "DB", schema: "B", kind: "scheduler" })!;
    const a = queries.nativeJobWorkspaceForTab(aId)!;
    expect(queries.nativeJobWorkspaceForTab(aId)).toBe(a);
    expect(queries.nativeJobWorkspaceForTab(bId)).not.toBe(a);
    a.snapshot = { pageIdentity: JSON.stringify(["c", "DB", "A", "scheduler"]), retained: [], create: { open: true, name: "PRIVATE_DRAFT_A", kind: "scheduler", scheduler: {}, legacy: {}, dameng: {} } };
    a.mainExecution = { callbackGeneration: 4 };
    a.stopExecution = { callbackGeneration: 2 };
    queries.duplicateTab(aId);
    const duplicate = queries.tabs.find((tab) => tab.id === queries.activeTabId)!;
    expect(duplicate.id).not.toBe(aId);
    expect(duplicate.nativeJobPage).toEqual({ schema: "A", kind: "scheduler" });
    expect(duplicate.nativeJobAdmin).toEqual(selection);
    const copied = queries.nativeJobWorkspaceForTab(duplicate.id)!;
    expect(copied).not.toBe(a);
    expect(copied.mainExecution).toBeUndefined();
    expect(copied.stopExecution).toBeUndefined();
    copied.snapshot!.create.name = "COPY_ONLY";
    expect(a.snapshot.create.name).toBe("PRIVATE_DRAFT_A");
    queries.tabs.find((tab) => tab.id === aId)!.nativeJobCreateRequest = 1;
    queries.closeTab(aId, { force: true });
    const reopened = queries.reopenClosedTab()!;
    expect(queries.nativeJobWorkspaceForTab(reopened)).toBe(a);
    expect(a.mainExecution.callbackGeneration).toBe(4);
    expect(a.stopExecution.callbackGeneration).toBe(2);
    expect(queries.tabs.find((tab) => tab.id === reopened)?.nativeJobCreateRequest).toBeUndefined();
  });
  it("recovers exact saved Scheduler ownership without using an old owner filter or querying", async () => {
    const { queries } = await stores("oracle");
    const old = legacyTab({ uiState: { page: { "database-jobs": { DatabaseJobAdmin: { ownerFilter: "WRONG", selectedJob: { kind: "scheduler", owner: 'Exact.Owner:特殊"', name: "SAME" }, search: "kept" } } } } });
    const retained = JSON.stringify(old.uiState);
    queries.tabs.push(old);
    await queries.resolveNativeJobNavigation(old.id);
    expect(old.nativeJobPage).toEqual({ schema: 'Exact.Owner:特殊"', kind: "scheduler" });
    expect(old.nativeJobAdmin).toEqual({ kind: "scheduler", owner: 'Exact.Owner:特殊"', name: "SAME" });
    expect(old.sql).toBe("RETAINED_INPUT");
    expect(JSON.stringify(old.uiState)).toBe(retained);
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it("resolves a legacy ID only through its exact runtime database and SCHEMA_USER", async () => {
    const { queries } = await stores("oracle");
    const old = legacyTab();
    queries.tabs.push(old);
    mocks.nativeJobRead.mockImplementation(async (target: NativeJobRef) => legacyDetails(target));
    await queries.resolveNativeJobNavigation(old.id);
    expect(mocks.nativeJobOpenContext).toHaveBeenCalledWith("c", "DB");
    expect(mocks.nativeJobRead).toHaveBeenCalledWith({ kind: "legacy", jobId: "900719925474099312345", scope: { connectionId: "c", database: "DB", contextId: "runtime" } });
    expect(old.nativeJobPage).toEqual({ schema: "ParseOwner", kind: "legacy" });
    expect(old.database).toBe("ParseOwner");
    expect(queries.openDatabaseJobAdmin("c", undefined, { database: "ParseOwner", schema: "ParseOwner", kind: "legacy" })).toBe(old.id);
    expect(old.sql).toBe("RETAINED_INPUT");
  });
  it.each([undefined, { kind: "legacy", jobId: 9007199254740992 }, { kind: "scheduler", name: "SAME" }])("keeps unidentified saved content without guessing from names or filters (%j)", async (selection) => {
    const { queries } = await stores("oracle");
    const old = legacyTab({ uiState: { page: { "database-jobs": { DatabaseJobAdmin: { ownerFilter: "Owner", selectedJobName: "9007199254740993", selectedJob: selection } } } } });
    queries.tabs.push(old);
    await queries.resolveNativeJobNavigation(old.id);
    expect(old.nativeJobPage).toBeUndefined();
    expect(old.nativeJobScopeResolution).toEqual({ status: "unresolved", retryable: false });
    expect(old.sql).toBe("RETAINED_INPUT");
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it.each(["empty", "denied", "unknown-identity", "wrong-id"])("does not install a scope from unverified legacy metadata (%s)", async (mode) => {
    const { queries } = await stores("oracle");
    const old = legacyTab();
    queries.tabs.push(old);
    mocks.nativeJobRead.mockImplementation(async (target: NativeJobRef) => {
      const result = legacyDetails(target);
      if (mode === "empty") result.snapshot.definition = { status: "empty" };
      if (mode === "denied") result.snapshot.definition = { status: "denied", reason: "catalog_denied" };
      if (mode === "unknown-identity") result.nativeIdentity = { status: "unknown", reason: "identity_unknown" };
      if (mode === "wrong-id") result.snapshot.ref = { ...target, kind: "legacy", jobId: "41" };
      return result;
    });
    await queries.resolveNativeJobNavigation(old.id);
    expect(old.nativeJobPage).toBeUndefined();
    expect(old.nativeJobScopeResolution).toEqual({ status: "unresolved", retryable: true, error: "native_job_scope_resolution_unavailable" });
    expect(old.sql).toBe("RETAINED_INPUT");
  });
  it("retries a failed exact-ID recovery without discarding its saved content", async () => {
    const { queries } = await stores("oracle");
    const old = legacyTab();
    queries.tabs.push(old);
    mocks.nativeJobRead.mockRejectedValueOnce(new Error("catalog_temporarily_unavailable")).mockImplementation(async (target: NativeJobRef) => legacyDetails(target));
    await queries.resolveNativeJobNavigation(old.id);
    expect(old.nativeJobScopeResolution?.error).toBe("catalog_temporarily_unavailable");
    await queries.resolveNativeJobNavigation(old.id);
    expect(old.nativeJobPage).toEqual({ schema: "ParseOwner", kind: "legacy" });
    expect(old.sql).toBe("RETAINED_INPUT");
    expect(mocks.nativeJobRead).toHaveBeenCalledTimes(2);
  });
  it.each(["visibility", "identity", "database", "reopened"])("checks the original tab and connection before accepting a late scope response (%s)", async (change) => {
    const { connections, queries } = await stores("oracle");
    const old = legacyTab();
    queries.tabs.push(old);
    let finish!: (value: NativeJobDetails) => void;
    mocks.nativeJobRead.mockImplementationOnce(
      () =>
        new Promise<NativeJobDetails>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = queries.resolveNativeJobNavigation(old.id);
    await vi.waitFor(() => expect(mocks.nativeJobRead).toHaveBeenCalledTimes(1));
    if (change === "visibility") connections.getConfig("c")!.show_extensions = false;
    if (change === "identity") connections.getConfig("c")!.host = "another-database";
    if (change === "database") queries.tabs.find((tab) => tab.id === old.id)!.database = "another-source";
    if (change === "reopened")
      queries.tabs.splice(
        queries.tabs.findIndex((tab) => tab.id === old.id),
        1,
        legacyTab({ sql: "NEW_TAB_INPUT" }),
      );
    finish(legacyDetails(mocks.nativeJobRead.mock.calls[0]![0]));
    await pending;
    const current = queries.tabs.find((tab) => tab.id === old.id)!;
    expect(current.nativeJobPage).toEqual(change === "visibility" ? { schema: "ParseOwner", kind: "legacy" } : undefined);
    expect(current.sql).toBe(change === "reopened" ? "NEW_TAB_INPUT" : "RETAINED_INPUT");
  });
  it("keeps Job management out of the tree after actual JDBC metadata without replacing loaded nodes", async () => {
    const { connections, queries } = await stores("jdbc", { driver_label: "Dameng", connection_string: "jdbc:oceanbase://host/db" });
    await connections.loadDatabases("c", { force: true });
    const node = connections.treeNodes[0]!;
    node.isExpanded = true;
    const metadataChild = node.children!.find((child) => child.type === "database" || child.type === "schema")!;
    expect(node.children!.some((child) => child.type === "connection-extensions" || child.type === "dameng-job-admin")).toBe(false);
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "oracle" });
    expect(connections.treeNodes[0]).toBe(node);
    expect(node.isExpanded).toBe(true);
    expect(node.children).toContain(metadataChild);
    expect(node.children!.filter((child) => child.type === "database-job-admin" || child.type === "dameng-job-admin")).toEqual([]);
    queries.openDatabaseJobAdmin("c", undefined, { database: "DB", schema: "Owner", kind: "scheduler" });
    expect(queries.tabs[0]?.mode).toBe("database-jobs");
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase" });
    expect(connections.treeNodes[0]).toBe(node);
    expect(node.children).toContain(metadataChild);
    expect(node.children!.some((child) => child.type === "database-job-admin" || child.type === "dameng-job-admin")).toBe(false);
  });
  it("adds JDBC Job access when background mode arrives and ignores a changed-config response", async () => {
    const { connections } = await stores("jdbc", { connection_string: "jdbc:oceanbase://host/db" });
    await connections.loadDatabases("c", { force: true });
    const node = connections.treeNodes[0]!;
    expect(node.children!.some((child) => child.type === "database-job-admin")).toBe(false);
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "oracle" });
    expect(node.children!.filter((child) => child.type === "database-job-admin")).toHaveLength(0);
    const config = connections.getConfig("c")!;
    const fingerprint = connectionConfigFingerprint(config);
    let finish!: () => void;
    mocks.saveConnectionDatabaseInfo.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "mysql" }, fingerprint);
    config.username = "Changed";
    finish();
    await pending;
    expect(connections.getConfig("c")?.database_info?.compatibilityMode).toBe("oracle");
    expect(node.children!.filter((child) => child.type === "database-job-admin")).toHaveLength(0);
  });
  it.each(["oracle", "oceanbase-oracle", "dameng", "xugu"] as const)("does not restore management entries for %s when reloading objects", async (type) => {
    const { connections } = await stores(type);
    await connections.loadDatabases("c", { force: true });
    await connections.loadDatabases("c", { force: true });
    const rootChildren = connections.treeNodes[0]?.children ?? [];
    const extensionChildren = rootChildren.find((node) => node.type === "connection-extensions")?.children ?? [];
    const entries = [...rootChildren, ...extensionChildren].filter((node) => node.type === "database-job-admin" || node.type === "dameng-job-admin");
    expect(entries).toEqual([]);
    expect(rootChildren.some((node) => node.type === "connection-extensions")).toBe(false);
  });

  it("discovers schema categories without scanning jobs and keeps public links outside extensions", async () => {
    const { connections } = await stores("oracle", { show_extensions: false });
    mocks.listSchemas.mockResolvedValueOnce(["Owner", "Other"]);
    await connections.loadDatabases("c", { force: true });
    const root = connections.treeNodes[0]!;
    const shared = root.children!.find((node) => node.type === "oracle-shared-objects")!;
    expect(shared.databaseLinkScope).toEqual({ kind: "public" });
    expect(shared.children?.[0].databaseLinkScope).toEqual({ kind: "public" });
    for (const schema of root.children!.filter((node) => node.type === "schema")) {
      await connections.loadTables("c", schema.database!, schema.schema, { force: true });
      expect(schema.children?.filter((node) => node.type === "oracle-db-links")).toHaveLength(1);
      const scheduler = schema.children?.find((node) => node.type === "native-job-scheduler");
      expect(scheduler?.children?.at(-1)?.nativeJobPage).toEqual({ schema: schema.schema, kind: "legacy" });
      expect(scheduler?.children).toHaveLength(4);
    }
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    expect(mocks.nativeJobList).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls.map((call) => call[2])).toEqual(["SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y'", "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"]);
    expect(root.children?.some((node) => node.type === "oracle-db-links" || node.type === "database-job-admin")).toBe(false);
  });

  it.each(["schema", "parent"])("adds missing Oracle categories when restoring an old %s cache", async (cacheLevel) => {
    const { connections } = await stores("oracle");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
    const schema: TreeNode = { id: "c:Other:Other", type: "schema", label: "Other", connectionId: "c", database: "Other", schema: "Other", children: [{ id: "views", type: "group-views", label: "Views", connectionId: "c", database: "Other", schema: "Other" }] };
    if (cacheLevel === "schema") {
      connections.treeNodes[0]!.children = [schema];
      mocks.loadSchemaCache.mockResolvedValueOnce(encodeSchemaTreeCache(schema.children));
      await connections.loadTables("c", "Other", "Other");
    } else {
      mocks.loadSchemaCache.mockResolvedValue(encodeSchemaTreeCache([schema]));
      await connections.loadDatabases("c");
    }
    const restored = connections.treeNodes[0]!.children!.find((node) => node.type === "schema")!;
    expect(restored.children?.filter((node) => node.type === "oracle-db-links")).toHaveLength(1);
    expect(restored.children?.find((node) => node.type === "oracle-db-links")?.databaseLinkScope).toEqual({ kind: "schema", schema: "Other" });
    expect(restored.children?.find((node) => node.type === "native-job-scheduler")?.children?.at(-1)?.nativeJobPage).toEqual({ schema: "Other", kind: "legacy" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Other's"])("reads the precise Oracle link catalog for %s using SESSION_USER", async (schema) => {
    const { connections } = await stores("oracle");
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["USER"], rows: [["Owner"]] }).mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [[schema, "REMOTE"]] });
    expect(await connections.listOracleDatabaseLinks("c", "DB", { kind: "schema", schema })).toMatchObject([{ owner: schema, name: "REMOTE" }]);
    const sql = mocks.executeQuery.mock.calls[1]![2];
    expect(sql).toContain(schema === "Owner" ? "FROM ALL_DB_LINKS L" : "FROM SYS.DBA_DB_LINKS L");
    expect(sql).toContain(`L.OWNER = '${schema.replaceAll("'", "''")}'`);
    expect(sql).not.toContain("CURRENT_SCHEMA");
  });

  it.each(["ORA-00942: table or view does not exist", "ORA-01031: insufficient privileges", "ORA-00900: invalid SQL", "request timed out"])("keeps catalog failures inline and retryable: %s", async (message) => {
    const { connections } = await stores("oracle");
    const group = oracleDatabaseLinkGroup({ id: "schema", connectionId: "c", database: "DB" }, { kind: "schema", schema: "Other" });
    connections.treeNodes[0]!.children = [group];
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["USER"], rows: [["Owner"]] }).mockRejectedValueOnce(new Error(message));
    await connections.loadTreeNodeChildren(group);
    expect(group.objectCount).toBeUndefined();
    expect(group.oracleNavigationStatus).toEqual({ kind: /00942|01031/.test(message) ? "denied" : "error", reason: message });
    expect(connections.connectionErrors.c).toBeUndefined();
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(false);
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["USER"], rows: [["Owner"]] }).mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [] });
    await connections.loadTreeNodeChildren(group, { force: true });
    expect(group.objectCount).toBe(0);
    expect(group.oracleNavigationStatus).toBeUndefined();
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(true);
  });

  it("does not classify a failed identity lookup as catalog permission denial", async () => {
    const { connections } = await stores("oracle");
    const group = oracleDatabaseLinkGroup({ id: "schema", connectionId: "c", database: "DB" }, { kind: "schema", schema: "Other" });
    connections.treeNodes[0]!.children = [group];
    mocks.executeQuery.mockRejectedValueOnce(new Error("ORA-00942: identity unavailable"));
    await connections.loadTreeNodeChildren(group);
    expect(group.oracleNavigationStatus?.kind).toBe("error");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("uses structured vendor codes while retaining real disconnect handling", async () => {
    const { connections } = await stores("oracle");
    const group = oracleDatabaseLinkGroup({ id: "shared", connectionId: "c", database: "DB" }, { kind: "public" });
    connections.treeNodes[0]!.children = [group];
    mocks.executeQuery.mockRejectedValueOnce({ version: 1, code: "DBX-QUERY-1001", messageKey: "backendErrors.query", messageParams: {}, source: "driver", operationOutcome: "not_started", diagnostics: { vendorCode: 1031 } });
    await connections.loadTreeNodeChildren(group);
    expect(group.oracleNavigationStatus?.kind).toBe("denied");
    expect(connections.connectedIds.has("c")).toBe(true);
    mocks.executeQuery.mockRejectedValueOnce(new Error("ORA-03114: not connected to ORACLE"));
    await expect(connections.loadTreeNodeChildren(group, { force: true })).rejects.toThrow("ORA-03114");
    expect(connections.connectedIds.has("c")).toBe(false);
  });

  it("retains the original public/unscoped read contract and the thrown backend object", async () => {
    const { connections } = await stores("oracle");
    const error = { version: 1, code: "DBX-QUERY-1001", messageKey: "backendErrors.query", messageParams: {}, source: "driver", operationOutcome: "not_started", diagnostics: { vendorCode: 1031 } };
    mocks.executeQuery.mockRejectedValueOnce(error);
    await expect(connections.listOracleDatabaseLinks("c", "DB")).rejects.toBe(error);
    expect(mocks.executeQuery.mock.calls[0]![2]).toContain("FROM ALL_DB_LINKS");
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [] });
    await connections.listOracleDatabaseLinks("c", "DB", { kind: "public" });
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.executeQuery.mock.calls[1]![2]).toContain("L.OWNER = 'PUBLIC'");
  });

  it("clears stale rows on failure, but never lets a late failure replace a newer result", async () => {
    const { connections } = await stores("oracle");
    const group = oracleDatabaseLinkGroup({ id: "shared", connectionId: "c", database: "DB" }, { kind: "public" });
    connections.treeNodes[0]!.children = [group];
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [["PUBLIC", "OLD"]] });
    await connections.loadTreeNodeChildren(group);
    expect(group.objectCount).toBe(1);
    mocks.executeQuery.mockRejectedValueOnce(new Error("ORA-01031: denied"));
    await connections.loadTreeNodeChildren(group, { force: true });
    expect(group.children).toEqual([]);
    expect(group.objectCount).toBeUndefined();
    let reject!: (reason: Error) => void;
    mocks.executeQuery.mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const old = connections.loadTreeNodeChildren(group, { force: true });
    await vi.waitFor(() => expect(reject).toBeDefined());
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [["PUBLIC", "NEW"]] });
    await connections.loadTreeNodeChildren(group, { force: true });
    reject(new Error("ORA-01031: late denied"));
    await old;
    expect(group.children?.[0]?.label).toBe("NEW");
    expect(group.objectCount).toBe(1);
    expect(group.oracleNavigationStatus).toBeUndefined();
  });

  it("does not present a truncated link catalog as an exact total", async () => {
    const { connections } = await stores("oracle");
    const group = oracleDatabaseLinkGroup({ id: "shared", connectionId: "c", database: "DB" }, { kind: "public" });
    connections.treeNodes[0]!.children = [group];
    expect(oracleNavigationAuxiliaryText(group, (key) => key)).toBe("");
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK"], rows: [["PUBLIC", "REMOTE"]], truncated: true });
    await connections.loadTreeNodeChildren(group);
    expect(group.children).toHaveLength(1);
    expect(group.objectCount).toBeUndefined();
    expect(oracleNavigationAuxiliaryText(group, (key) => key)).toBe("");
  });

  it.each(["direct-grant", "no-direct-grant", "unreadable"])("keeps OceanBase link deletion authority separate from creator visibility (%s)", async (permission) => {
    const { connections } = await stores("oceanbase-oracle");
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["OWNER", "DB_LINK", "USERNAME", "HOST", "CREATED", "DBX_CAN_DROP"], rows: [["PUBLIC", "TENANT_LINK", "REMOTE", "test-target", "2026-10-29", null]] });
    if (permission === "unreadable") mocks.executeQuery.mockRejectedValueOnce(new Error("catalog_denied"));
    else mocks.executeQuery.mockResolvedValueOnce({ columns: ["PRIVILEGE"], rows: permission === "direct-grant" ? [["DROP DATABASE LINK"]] : [] });
    const links = await connections.listOracleDatabaseLinks("c", "DB", { kind: "tenant" });
    expect(links).toHaveLength(1);
    expect(links[0]?.canDrop).toBe(permission === "direct-grant" ? true : undefined);
    expect(links[0]?.permissionUnknown).toBe(permission !== "direct-grant");
    expect(mocks.executeQuery).toHaveBeenLastCalledWith("c", "DB", "SELECT PRIVILEGE FROM USER_SYS_PRIVS WHERE PRIVILEGE = 'DROP DATABASE LINK'", undefined, undefined, { maxRows: 1, timeoutSecs: 15 });
  });

  it("automatically reads all fixed-schema legacy pages and reuses the complete cache", async () => {
    const { connections } = await stores("oceanbase-oracle");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().desktopSettings.sidebar_table_page_size = 1;
    const schema: TreeNode = { id: "schema", type: "schema", label: "Owner", connectionId: "c", database: "DB", schema: "Owner" };
    schema.children = oracleSchemaJobGroups(schema);
    connections.treeNodes[0]!.children = [schema];
    const group = schema.children[0]!.children![3]!;
    const job = (jobId: string) => ({ ref: { scope: { connectionId: "c", database: "DB", contextId: "runtime" }, kind: "legacy", jobId }, name: jobId, schemaUser: "Owner", logUser: "Login", privUser: "Privilege" });
    const first = job("900719925474099312345"),
      second = job("900719925474099312346");
    mocks.nativeJobList.mockResolvedValueOnce({ jobs: { status: "truncated", value: [first], limit: 1 } }).mockResolvedValueOnce({ jobs: { status: "available", value: [second] } });
    await connections.loadTreeNodeChildren(group);
    expect(mocks.nativeJobList).toHaveBeenNthCalledWith(1, expect.objectContaining({ schema: "Owner", kind: "legacy", offset: 0, limit: 1000 }));
    expect(group.children?.[0].nativeJobSelection).toEqual({ kind: "legacy", jobId: first.ref.jobId });
    expect(group.children!.some((node) => node.type === "load-more")).toBe(false);
    expect(mocks.nativeJobList).toHaveBeenLastCalledWith(expect.objectContaining({ schema: "Owner", kind: "legacy", offset: 1 }));
    expect(group.children?.map((node) => node.nativeJobSelection)).toEqual([
      { kind: "legacy", jobId: first.ref.jobId },
      { kind: "legacy", jobId: second.ref.jobId },
    ]);
    expect(group.objectCount).toBe(2);
    await connections.loadTreeNodeChildren(group);
    expect(mocks.nativeJobList).toHaveBeenCalledTimes(2);
    expect(group.children?.every((node) => node.nativeJobPage?.schema === "Owner" && !JSON.stringify(node).includes("contextId"))).toBe(true);
  });

  it("caps the default tree page at the native API limit without adding a second sentinel", async () => {
    const { connections } = await stores("oracle");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().desktopSettings.sidebar_table_page_size = 1000;
    const schema: TreeNode = { id: "schema", type: "schema", label: "Owner", connectionId: "c", database: "DB", schema: "Owner" };
    schema.children = oracleSchemaJobGroups(schema);
    connections.treeNodes[0]!.children = [schema];
    mocks.nativeJobList.mockImplementation(async (request) => {
      if (request.limit > 1000) throw new Error("native_job_list_input_invalid");
      return { jobs: { status: "empty" }, offset: request.offset, limit: request.limit };
    });
    const group = schema.children[0]!.children![0]!;
    await connections.loadTreeNodeChildren(group);
    expect(mocks.nativeJobList).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ limit: 1000, schedulerCategory: "regular" }));
    expect(group.objectCount).toBe(0);
  });

  it.each(["denied", "unknown", "unsupported", "error"] as const)("keeps %s job categories retryable instead of reporting an empty result", async (kind) => {
    const { connections } = await stores("oracle");
    const schema: TreeNode = { id: "schema", type: "schema", label: "Owner", connectionId: "c", database: "DB", schema: "Owner" };
    schema.children = oracleSchemaJobGroups(schema);
    connections.treeNodes[0]!.children = [schema];
    const group = schema.children[0]!.children![3]!;
    mocks.nativeJobList.mockResolvedValueOnce({ jobs: { status: kind, reason: "native_job_catalog_denied" } });
    await connections.loadTreeNodeChildren(group);
    expect(group.objectCount).toBeUndefined();
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(false);
    expect(group.oracleNavigationStatus).toEqual({ kind, reason: "native_job_catalog_denied" });
    expect(connections.connectionErrors.c).toBeUndefined();
    await connections.loadTreeNodeChildren(group, { force: true });
    expect(group.objectCount).toBe(0);
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(true);
  });

  it("locates an exact off-page legacy ID without scanning pages or changing pagination", async () => {
    const { connections } = await stores("oracle");
    const schema: TreeNode = { id: "schema", type: "schema", label: "Owner", connectionId: "c", database: "DB", schema: "Owner" };
    schema.children = oracleSchemaJobGroups(schema);
    connections.treeNodes[0]!.children = [schema];
    const group = schema.children[0]!.children![3]!;
    const more: TreeNode = { id: `${group.id}:more`, type: "load-more", label: "More", offset: 100 } as TreeNode;
    group.children = [more];
    const selection = { kind: "legacy" as const, jobId: "900719925474099312345" };
    mocks.nativeJobRead.mockImplementation(async (target: NativeJobRef) => legacyDetails(target, "Owner"));
    await connections.ensureNativeJobTreeSelection(group, selection);
    expect(mocks.nativeJobRead).toHaveBeenCalledExactlyOnceWith({ ...selection, scope: { connectionId: "c", database: "DB", contextId: "runtime" } }, { schema: "Owner", kind: "legacy" });
    expect(group.children?.[0]?.nativeJobSelection).toEqual(selection);
    expect(group.children?.at(-1)).toEqual(more);
    expect(group.objectCount).toBeUndefined();
    expect(JSON.stringify(group)).not.toContain("contextId");
    await connections.ensureNativeJobTreeSelection(group, selection);
    await connections.ensureNativeJobTreeSelection(group, { kind: "scheduler", owner: "Other", name: "SAME" });
    expect(mocks.nativeJobRead).toHaveBeenCalledTimes(1);
    expect(mocks.nativeJobList).not.toHaveBeenCalled();
  });

  it("refreshes only expanded job categories and keeps unopened categories lazy", async () => {
    const { connections } = await stores("oracle");
    const parent = oracleSchemaJobGroups({ id: "A", connectionId: "c", database: "DB", schema: "A" })[0]!;
    connections.treeNodes[0]!.children = [parent];
    await connections.loadTreeNodeChildren(parent);
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    await connections.loadTreeNodeChildren(parent, { force: true });
    expect(mocks.nativeJobList).not.toHaveBeenCalled();
    await connections.loadTreeNodeChildren(parent.children![0]!);
    expect(parent.children![0]!.objectCount).toBe(0);
    await connections.loadTreeNodeChildren(parent, { force: true });
    expect(mocks.nativeJobList).toHaveBeenCalledTimes(2);
    expect(mocks.nativeJobList.mock.calls.every(([request]) => request.schedulerCategory === "regular")).toBe(true);
    expect(parent.children!.slice(1).every((node) => node.objectCount === undefined)).toBe(true);
    await connections.refreshNativeJobTree("c", "DB", { schema: "A", kind: "scheduler" });
    expect(mocks.nativeJobList).toHaveBeenCalledTimes(3);
    expect(parent.children!.slice(1).every((node) => node.objectCount === undefined)).toBe(true);
  });

  it("shows each job page and preserves successful pages when the next page fails", async () => {
    const { connections } = await stores("oracle");
    const parent = oracleSchemaJobGroups({ id: "A", connectionId: "c", database: "DB", schema: "A" })[0]!;
    const group = parent.children![3]!;
    connections.treeNodes[0]!.children = [parent];
    let fail!: (reason: Error) => void;
    mocks.nativeJobList.mockResolvedValueOnce({ jobs: { status: "truncated", limit: 1000, value: [{ ref: { kind: "legacy", jobId: "900719925474099312345" }, name: "job", schemaUser: "A" }] } }).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const loading = connections.loadTreeNodeChildren(group);
    await vi.waitFor(() => expect(fail).toBeDefined());
    expect(group.children?.[0]?.nativeJobSelection).toEqual({ kind: "legacy", jobId: "900719925474099312345" });
    expect(group.objectCount).toBeUndefined();
    expect(connections.isTreeNodeChildrenLoaded(group.id)).toBe(false);
    fail(new Error("catalog_read_failed"));
    await loading;
    expect(group.children).toHaveLength(1);
    expect(group.oracleNavigationStatus?.kind).toBe("error");
    expect(group.objectCount).toBeUndefined();
  });

  it("keeps Scheduler categories in separate tabs and persists their stable scope", async () => {
    const { queries } = await stores("oracle");
    const pages = (["regular", "lightweight", "in-memory"] as const).map((schedulerCategory) => ({ database: "DB", schema: "A", kind: "scheduler" as const, schedulerCategory }));
    const ids = pages.map((page) => queries.openDatabaseJobAdmin("c", undefined, page));
    expect(new Set(ids).size).toBe(3);
    expect(queries.openDatabaseJobAdmin("c", undefined, pages[0])).toBe(ids[0]);
    expect(queries.tabs.map((tab) => tab.nativeJobPage?.schedulerCategory)).toEqual(["regular", "lightweight", "in-memory"]);
  });

  it("reprojects cached layouts and display hints without querying or clearing completion data", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    settings.editorSettings.sidebarObjectDisplay = "simple";
    const schema: TreeNode = { id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0]!.children = [schema];
    mocks.listObjects.mockResolvedValue([{ name: "CACHED_T", schema: "A", object_type: "TABLE", comment: "retained" }]);
    await connections.loadTables("c", "DB", "A", { force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cachedTables = schema.children!.find((node) => node.type === "group-tables")!;
    const cached = cachedTables.children!.find((node) => node.type === "table")!;
    expect(cached).toBeDefined();
    const reads = [mocks.listObjects.mock.calls.length, mocks.listTables.mock.calls.length, mocks.listSchemaInfos.mock.calls.length, mocks.executeQuery.mock.calls.length];
    settings.editorSettings.sidebarObjectDisplay = "grouped";
    await connections.refreshNavigationPresentation("c");
    const tables = schema.children!.find((node) => node.type === "group-tables")!;
    expect(toRaw(tables.children?.[0])).toBe(toRaw(cached));
    expect(tables.objectCount).toBe(1);
    expect(connections.isTreeNodeChildrenLoaded(tables.id)).toBe(true);
    settings.editorSettings.sidebarObjectDisplay = "simple";
    settings.editorSettings.sidebarObjectInfoMode = "hidden";
    settings.editorSettings.sidebarHiddenTablePrefixes = ["CACHED_"];
    await connections.refreshNavigationPresentation("c");
    const projected = connections.projectRelationalNavigationTree(connections.treeNodes)[0]!.children!;
    expect(projected.some((node) => node.type === "table" && node.label === "CACHED_T")).toBe(true);
    expect(projected.some((node) => node.type === "group-tables")).toBe(false);
    expect([mocks.listObjects.mock.calls.length, mocks.listTables.mock.calls.length, mocks.listSchemaInfos.mock.calls.length, mocks.executeQuery.mock.calls.length]).toEqual(reads);
    expect(connections.lookupLocalCompletionTables("c", "DB", "A").some((node) => node.name === "CACHED_T")).toBe(true);
  });

  it("commits a late initial Simple response using the current Grouped presentation", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    settings.editorSettings.sidebarObjectDisplay = "simple";
    const schema: TreeNode = { id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0]!.children = [schema];
    let finish!: (rows: Array<{ name: string; schema: string; object_type: string }>) => void;
    mocks.listObjects.mockImplementation((...args) =>
      args[10]?.directoryPage
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve([]),
    );
    const loading = connections.loadTables("c", "DB", "A", { force: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    settings.editorSettings.sidebarObjectDisplay = "grouped";
    await connections.refreshNavigationPresentation("c");
    finish([{ name: "LATE_T", schema: "A", object_type: "TABLE" }]);
    await loading;
    expect(schema.children?.some((node) => node.type === "table")).toBe(false);
    expect(schema.children?.find((node) => node.type === "group-tables")?.children?.[0]?.label).toBe("LATE_T");
    expect(mocks.listObjects.mock.calls.filter((call) => call[10]?.directoryPage)).toHaveLength(1);
  });

  it("only reloads metadata for an explicit visibility change", async () => {
    const { connections } = await stores("oracle", { default_schema: "Owner" });
    await connections.refreshNavigationPresentation("c");
    expect(mocks.listSchemaInfos).not.toHaveBeenCalled();
    await connections.refreshNavigationPresentation("c", { visibilityChanged: true });
    expect(mocks.listSchemaInfos).toHaveBeenCalledOnce();
  });

  it("shares an in-flight raw object page across display changes", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    const group: TreeNode = { id: "c:DB:A:__procedures", type: "group-procedures", label: "Procedures", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [group] }];
    let finish!: (rows: unknown[]) => void;
    mocks.listObjects.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = connections.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledOnce());
    settings.editorSettings.sidebarObjectDisplay = "simple";
    await connections.refreshNavigationPresentation("c");
    const second = connections.loadObjectGroupChildren(group);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.listObjects).toHaveBeenCalledOnce();
    finish([{ name: "P", object_type: "PROCEDURE", schema: "A" }]);
    await Promise.all([first, second]);
    expect(group.children?.[0]?.label).toBe("P");
  });
  it("shares the editor Schema options read with the navigation Schema source", async () => {
    const { connections } = await stores("oracle");
    const { useSchemaOptions } = await import("@/composables/useSchemaOptions");
    let finish!: (rows: Array<{ name: string; comment: null }>) => void;
    mocks.listSchemaInfos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const navigation = connections.listCompletionSchemas("c", "Service-not-owner");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const options = useSchemaOptions();
    const editor = options.loadSchemaOptions("c", "Service-not-owner");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.listSchemas).not.toHaveBeenCalled();
    finish([{ name: "Owner", comment: null }]);
    await Promise.all([navigation, editor]);
    expect(mocks.listSchemaInfos).toHaveBeenCalledOnce();
    expect(options.getSchemaOptionsForDb("c", "Service-not-owner")).toEqual(["Owner"]);
  });
  it("persists the same SQL Server schema tree identity for either presentation", async () => {
    const { connections } = await stores("sqlserver", { database: "DB", default_schema: "Owner" });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    connections.treeNodes[0].children = [{ id: "c:DB", type: "database", label: "DB", connectionId: "c", database: "DB", children: [] }];
    await connections.loadSqlServerDatabaseObjects("c", "DB", { force: true });
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    await connections.refreshNavigationPresentation("c");
    await connections.loadSqlServerDatabaseObjects("c", "DB", { force: true });
    expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(2);
    expect(mocks.saveSchemaCache.mock.calls[0][0]).toBe(mocks.saveSchemaCache.mock.calls[1][0]);
  });
  it("refreshes a complete canonical directory and shares its table filter between presentations", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const schema: TreeNode = { id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0].children = [schema];
    let name = "OLD";
    mocks.listObjects.mockImplementation(async (_connection, _database, _schema, types) => (types.includes("TABLE") ? [{ name, schema: "A", object_type: "TABLE" }] : []));
    await connections.loadTables("c", "DB", "A");
    name = "NEW";
    await connections.loadTables("c", "DB", "A", { force: true });
    expect(schema.children?.find((node) => node.type === "group-tables")?.children?.[0]?.label).toBe("NEW");
    const parts = { connectionId: "c", database: "DB", schema: "A" };
    const flatKey = connections.tableNameFilterScopeKey({ ...parts, nodeKind: "simple-tables" });
    expect(flatKey).toBe(connections.tableNameFilterScopeKey({ ...parts, nodeKind: "group-tables" }));
    connections.setSidebarTableNameFilter(flatKey, { includePatterns: ["NEW"], excludePatterns: [] });
    await connections.loadTables("c", "DB", "A", { force: true });
    expect(mocks.listObjects.mock.calls.some((call) => call[3].includes("TABLE") && call[8]?.includePatterns?.[0] === "NEW")).toBe(true);
  });
  it("refreshes a displayed ordinary category through the shared 1000-row directory", async () => {
    const { connections } = await stores("oracle", { default_schema: "A" });
    const schema: TreeNode = { id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0].children = [schema];
    await connections.loadTables("c", "DB", "A");
    mocks.listObjects.mockClear().mockResolvedValue([{ name: "NEW_P", object_type: "PROCEDURE", schema: "A" }]);
    const displayed = connections.projectRelationalNavigationTree(connections.treeNodes)[0].children!.find((node) => node.type === "group-procedures")!;
    await connections.loadRelationalNavigationGroup(displayed, true);
    expect(mocks.listObjects).toHaveBeenCalledOnce();
    expect(mocks.listObjects.mock.calls[0].slice(3, 7)).toEqual([["PROCEDURE"], undefined, 1000, 0]);
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ directoryPage: true });
    expect(schema.children?.find((node) => node.type === "group-procedures")?.children?.[0]?.label).toBe("NEW_P");
  });

  it.each(["oracle", "oceanbase-oracle", "postgres", "mysql", "sqlserver"] as const)("refreshes a named-scope raw table group through the complete native directory for %s", async (dbType) => {
    const { connections } = await stores(dbType, { database: "DB", default_schema: "A" });
    const schemaName = dbType === "mysql" ? undefined : "A";
    const schema: TreeNode = { id: schemaName ? "c:DB:A" : "c:DB", type: schemaName ? "schema" : "database", label: schemaName ?? "DB", connectionId: "c", database: "DB", schema: schemaName, children: [] };
    connections.treeNodes[0].children = ["postgres", "sqlserver"].includes(dbType) ? [{ id: "c:DB", type: "database", label: "DB", connectionId: "c", database: "DB", children: [schema] }] : [schema];
    await connections.loadTables("c", "DB", schemaName);
    const tables = schema.children!.find((node) => node.type === "group-tables")!;
    const first = Array.from({ length: 1000 }, (_, index) => ({ name: `T${index}`, object_type: "TABLE", schema: schemaName }));
    mocks.listObjects.mockClear().mockImplementation(async (...args) => (args[6] === 0 ? first : [{ name: "T_LAST", object_type: "TABLE", schema: schemaName }]));
    mocks.listTables.mockClear().mockImplementation(async (...args) => (args[5] === 0 ? first.map((row) => ({ name: row.name, table_type: "TABLE" })) : [{ name: "T_LAST", table_type: "TABLE" }]));
    await connections.refreshTreeNode(tables);
    await vi.waitFor(() => expect(tables.objectCount).toBe(1001));
    if (dbType === "oracle") {
      expect(mocks.listTables).not.toHaveBeenCalled();
      expect(mocks.listObjects.mock.calls.map((call) => call.slice(3, 7))).toEqual([
        [["TABLE"], undefined, 1000, 0],
        [["TABLE"], undefined, 1000, 1000],
      ]);
      expect(mocks.listObjects.mock.calls.every((call) => call[10]?.directoryPage === true)).toBe(true);
    } else {
      expect(mocks.listObjects).not.toHaveBeenCalled();
      expect(mocks.listTables.mock.calls.map((call) => call.slice(4, 7))).toEqual([
        [1000, 0, ["TABLE"]],
        [1000, 1000, ["TABLE"]],
      ]);
    }
    expect(tables.children?.some((node) => node.type === "load-more")).toBe(false);
    expect(tables.children).toHaveLength(1001);
    expect(tables.children?.map((node) => node.label)).toContain("T_LAST");
  });

  it.each(["custom driver", "active search"] as const)("retains the existing raw table refresh contract for %s", async (mode) => {
    const { connections } = await stores("oracle", mode === "custom driver" ? { driver_profile: "oracle-legacy" } : {});
    const tables: TreeNode = { id: "c:DB:A:__tables", type: "group-tables", label: "tree.tables", connectionId: "c", database: "DB", schema: "A", children: [] };
    connections.treeNodes[0].children = [{ id: "c:DB:A", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A", children: [tables] }];
    if (mode === "active search") connections.sidebarSearchQuery = "MATCH";
    mocks.listTables.mockResolvedValue([{ name: "MATCH", table_type: "TABLE" }]);
    await connections.refreshTreeNode(tables);
    expect(mocks.listTables).toHaveBeenCalledOnce();
    expect(mocks.listTables.mock.calls[0].slice(3, 6)).toEqual(mode === "active search" ? ["MATCH", 2000, undefined] : [undefined, 1001, 0]);
    expect(mocks.listObjects).not.toHaveBeenCalled();
    expect(tables.children?.map((node) => node.label)).toEqual(["MATCH"]);
  });

  it("uses collision-free scope identities and no Program or parameter shells", () => {
    const a = { id: "same-old-id", connectionId: "c", database: "DB:One", schema: 'A:特殊"' };
    const b = { ...a, database: "DB", schema: 'One:A:特殊"' };
    const groups = [...oracleSchemaJobGroups(a), ...oracleSchemaJobGroups(b)];
    expect(new Set(groups.flatMap((node) => [node.id, ...(node.children?.map((child) => child.id) || [])])).size).toBe(10);
    const publicScope = oracleSharedObjects(a, "oracle"),
      tenantScope = oracleSharedObjects(a, "oceanbase-oracle");
    expect(publicScope.id).not.toBe(tenantScope.id);
    expect(publicScope.children?.[0].databaseLinkScope).toEqual({ kind: "public" });
    expect(tenantScope.children?.[0].databaseLinkScope).toEqual({ kind: "tenant" });
    expect(groups.flatMap((node) => node.children || []).map((node) => node.type)).toEqual(Array(8).fill("native-job-group"));
  });
});
