import { strict as assert } from "node:assert";
import { test, vi } from "vitest";
import { DEFAULT_MYSQL_OPTIONS, getDefaultOptionsForDbType } from "@/types/schemaDiff";

const apiMock = vi.hoisted(() => ({
  prepareSchemaDiff: vi.fn(),
  listFunctions: vi.fn(),
  listSequences: vi.fn(),
  listRules: vi.fn(),
  listOwners: vi.fn(),
}));
const openMock = vi.hoisted(() => vi.fn());
const trackerMock = vi.hoisted(() => ({
  addSchemaDiffTask: vi.fn(),
  updateCompareTask: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/composables/useDialogSources", () => ({ openSchemaDiffSession: openMock }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => trackerMock }));
vi.mock("@/lib/schema/schemaDiffMetadataLoad", () => ({ loadSchemaDetails: vi.fn().mockResolvedValue([]) }));

const { startSchemaDiffSession } = await import("../useSchemaDiffSession.ts");

test("disconnecting either side stops the compare after its issued table-list requests settle", async () => {
  const { cancelSchemaDiffTasksForConnection } = await import("@/lib/schema/schemaDiffCancellation");
  const { loadSchemaDetails } = await import("@/lib/schema/schemaDiffMetadataLoad");
  vi.clearAllMocks();
  const finish: Array<(tables: never[]) => void> = [];
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "cancel-source",
      sourceDatabase: "app",
      sourceSchema: "",
      targetConnectionId: "cancel-target",
      targetDatabase: "app",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: {},
      ignoreComments: false,
      label: "cancel compare",
    },
    { tableListLoader: { load: vi.fn(() => new Promise<never[]>((resolve) => finish.push(resolve))) } },
  );
  const cancellation = cancelSchemaDiffTasksForConnection("cancel-target", new Error("connection disconnected"));
  assert.ok(cancellation);
  finish[0]([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.status, "running");
  finish[1]([]);
  await cancellation;
  assert.equal(session.status, "failed");
  assert.equal(session.error, "connection disconnected");
  assert.equal(vi.mocked(loadSchemaDetails).mock.calls.length, 0);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
  assert.equal(trackerMock.updateCompareTask.mock.calls.at(-1)?.[1].status, "Error");
  vi.clearAllMocks();
});

test("applies every exclude rule before loading source and target details", async () => {
  const { loadSchemaDetails } = await import("@/lib/schema/schemaDiffMetadataLoad");
  vi.mocked(loadSchemaDetails).mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], renameCandidates: [], syncSql: "", rollbackSyncSql: "" });
  const tableListLoader = {
    load: vi.fn().mockResolvedValue(["im_users", "ib_orders", "audit_log", "users"].map((name) => ({ name, table_type: "BASE TABLE" }))),
  };
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "app",
      sourceSchema: "public",
      targetConnectionId: "target",
      targetDatabase: "warehouse",
      targetSchema: "public",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { functions: false, tableExcludePattern: "^im_,^ib_,log$" },
      ignoreComments: false,
      label: "app → warehouse",
    },
    { tableListLoader },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed");
  assert.equal(vi.mocked(loadSchemaDetails).mock.calls.length, 2);
  for (const [tables] of vi.mocked(loadSchemaDetails).mock.calls) {
    assert.deepEqual(
      tables.map((table) => table.name),
      ["users"],
    );
  }
  vi.clearAllMocks();
});

async function waitForSession(session: { status: string }) {
  for (let attempt = 0; attempt < 40 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("defaults enable tables and functions compare for common targets", () => {
  assert.equal(DEFAULT_MYSQL_OPTIONS.tables, true);
  assert.equal(DEFAULT_MYSQL_OPTIONS.functions, true);
  assert.equal(DEFAULT_MYSQL_OPTIONS.compareCharset, true);
  assert.equal(getDefaultOptionsForDbType("oracle").tables, true);
  assert.equal(getDefaultOptionsForDbType("oracle").functions, true);
  assert.equal(getDefaultOptionsForDbType("mysql").tables, true);
  assert.equal(getDefaultOptionsForDbType("mysql").functions, true);
  assert.equal(getDefaultOptionsForDbType("postgres").tables, true);
  assert.equal(getDefaultOptionsForDbType("postgres").functions, true);
});

test("runs a schema diff session after the dialog is closed and retains the prepared result", async () => {
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });
  apiMock.listFunctions.mockResolvedValue([]);

  const tableListLoader = {
    load: vi.fn().mockResolvedValue([]),
  };
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "app",
      sourceSchema: "public",
      targetConnectionId: "target",
      targetDatabase: "warehouse",
      targetSchema: "public",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: {},
      ignoreComments: false,
      label: "app → warehouse",
    },
    { tableListLoader },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.deepEqual(session.result?.diffs, []);
  assert.equal(tableListLoader.load.mock.calls.length, 2);
  assert.equal(tableListLoader.load.mock.calls[0]?.[1]?.refresh, true);
  assert.equal(trackerMock.addSchemaDiffTask.mock.calls.length, 1);
  assert.equal(trackerMock.updateCompareTask.mock.calls.at(-1)?.[1].status, "Done");
  // MySQL defaults now enable functions compare for same-dialect pairs.
  assert.equal(apiMock.listFunctions.mock.calls.length, 2);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.compareCharset, true);

  const onOpen = trackerMock.addSchemaDiffTask.mock.calls[0]?.[2] as (() => void) | undefined;
  onOpen?.();
  assert.equal(openMock.mock.calls.at(-1)?.[0], session.id);
});

test("forwards a disabled charset comparison to the backend", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "app",
      sourceSchema: "",
      targetConnectionId: "target",
      targetDatabase: "warehouse",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { compareCharset: false },
      ignoreComments: false,
      label: "charset disabled",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.compareCharset, false);
});

test("loads routines for mysql↔mysql when functions is enabled", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [{ diff_type: "added", name: "p1", source: { name: "p1", function_type: "PROCEDURE", data_type: "", definition: "body", arguments: "" }, target: null, changes: [] }],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });
  apiMock.listFunctions.mockResolvedValue([{ name: "p1", function_type: "PROCEDURE", data_type: "", definition: "body", arguments: "" }]);

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql-src",
      sourceDatabase: "gd_ebdata",
      sourceSchema: "",
      targetConnectionId: "mysql-dst",
      targetDatabase: "gd_ebdata_copy",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { functions: true },
      ignoreComments: false,
      label: "mysql → mysql",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 2);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.sourceFunctions?.length, 1);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.targetFunctions?.length, 1);
});

test("skips listFunctions for cross-family pairs even when functions is enabled", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql",
      sourceDatabase: "gd_ebdata",
      sourceSchema: "",
      targetConnectionId: "oracle",
      targetDatabase: "ARISK",
      targetSchema: "SYSTEM",
      sourceDbType: "mysql",
      targetDbType: "oracle",
      options: { functions: true },
      ignoreComments: false,
      label: "mysql → oracle",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.sourceFunctions, []);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.targetFunctions, []);
});

test("skips listFunctions when functions is disabled and routines are unrestricted", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql-src",
      sourceDatabase: "gd_ebdata",
      sourceSchema: "",
      targetConnectionId: "mysql-dst",
      targetDatabase: "gd_ebdata_copy",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { functions: false, selectedRoutines: undefined },
      ignoreComments: false,
      label: "mysql → mysql",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.sourceFunctions, []);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.targetFunctions, []);
});

test("skips listFunctions when functions is disabled even if selectedRoutines is set", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql-src",
      sourceDatabase: "gd_ebdata",
      sourceSchema: "",
      targetConnectionId: "mysql-dst",
      targetDatabase: "gd_ebdata_copy",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { functions: false, selectedRoutines: ["p1"] },
      ignoreComments: false,
      label: "mysql → mysql routines off",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.sourceFunctions, []);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.targetFunctions, []);
});

test("skips listFunctions when only one side supports routines", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql",
      sourceDatabase: "app",
      sourceSchema: "",
      targetConnectionId: "sqlite",
      targetDatabase: "local",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "sqlite",
      options: { functions: true },
      ignoreComments: false,
      label: "mysql → sqlite",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
});

test("skips table list loading for routines-only compares", async () => {
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.listFunctions.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });
  apiMock.listFunctions.mockResolvedValue([]);

  const tableListLoader = { load: vi.fn().mockResolvedValue([{ name: "should_not_load", table_type: "BASE TABLE" }]) };
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "mysql-src",
      sourceDatabase: "gd_ebdata",
      sourceSchema: "",
      targetConnectionId: "mysql-dst",
      targetDatabase: "gd_ebdata_copy",
      targetSchema: "",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { tables: false, views: true, functions: true },
      ignoreComments: false,
      label: "routines only",
    },
    { tableListLoader },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  assert.equal(tableListLoader.load.mock.calls.length, 0);
  assert.equal(apiMock.listFunctions.mock.calls.length, 2);
  assert.deepEqual(apiMock.prepareSchemaDiff.mock.calls[0]?.[0]?.sourceTables, []);
});

test("resolves the JDBC engine dialect from the connection's product type", async () => {
  // 「Oracle (JDBC)」这类连接的 db_type 是 jdbc，后端 DialectKind 认不出它：对话框把产品类型
  // 解析出来传进 sourceEngineDbType/targetEngineDbType 后，方言（以及视图比较）才成立。
  apiMock.prepareSchemaDiff.mockClear();
  apiMock.prepareSchemaDiff.mockResolvedValue({
    diffs: [],
    functionDiffs: [],
    sequenceDiffs: [],
    ruleDiffs: [],
    ownerDiffs: [],
    renameCandidates: [],
    syncSql: "",
    rollbackSyncSql: "",
  });

  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "jdbc-src",
      sourceDatabase: "XE",
      sourceSchema: "DBX_TEST",
      targetConnectionId: "jdbc-dst",
      targetDatabase: "XE",
      targetSchema: "DBX_TGT",
      sourceDbType: "jdbc",
      targetDbType: "jdbc",
      sourceEngineDbType: "oracle",
      targetEngineDbType: "oracle",
      options: {},
      ignoreComments: false,
      label: "jdbc oracle",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );

  await waitForSession(session);

  assert.equal(session.status, "completed");
  const payload = apiMock.prepareSchemaDiff.mock.calls[0]?.[0];
  assert.equal(payload?.sourceDialect, "oracle");
  assert.equal(payload?.targetDialect, "oracle");
  // 部署脚本按目标产品类型（而不是 jdbc）生成。
  assert.equal(payload?.databaseType, "oracle");
});

test.each([
  ["oracle", "oracle"],
  ["oceanbase-oracle", "oceanbase-oracle"],
  ["oracle", "oceanbase-oracle"],
  ["oceanbase-oracle", "oracle"],
] as const)("compares %s to %s routines with both schemas and actual engines", async (sourceDbType, targetDbType) => {
  vi.clearAllMocks();
  const source = { name: "P_SYNC", function_type: "PROCEDURE", data_type: "", arguments: "", definition: "CREATE PROCEDURE P_SYNC AS BEGIN NULL; END;", schema: "SRC", status: "VALID", dependencies: ["SRC.T_INPUT"] };
  const programs = [source, { ...source, function_type: "PACKAGE" }, { ...source, function_type: "PACKAGE BODY" }, { ...source, function_type: "TRIGGER", trigger: { tableOwner: "SRC", tableName: "T_INPUT", timing: "BEFORE", event: "INSERT", status: "DISABLED", baseObjectType: "TABLE" } }];
  apiMock.listFunctions.mockResolvedValueOnce(programs).mockResolvedValueOnce([]);
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], functionDiffs: [{ name: "P_SYNC", type: "added", source }], syncSql: "" });
  const tableListLoader = { load: vi.fn() };
  const session = startSchemaDiffSession(
    { sourceConnectionId: "routine-source", sourceDatabase: "db", sourceSchema: "SRC", targetConnectionId: "routine-target", targetDatabase: "db", targetSchema: "DST", sourceDbType, targetDbType, options: { tables: false, functions: true }, ignoreComments: false, label: "routines" },
    { tableListLoader },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed");
  assert.equal(tableListLoader.load.mock.calls.length, 0);
  assert.deepEqual(apiMock.listFunctions.mock.calls, [
    ["routine-source", "db", "SRC"],
    ["routine-target", "db", "DST"],
  ]);
  const options = apiMock.prepareSchemaDiff.mock.calls[0]?.[0];
  assert.equal(options.sourceDatabaseType, sourceDbType);
  assert.equal(options.databaseType, targetDbType);
  assert.equal(options.sourceSchema, "SRC");
  assert.equal(options.targetSchema, "DST");
  assert.deepEqual(options.routineEndpoints, { sourceConnectionId: "routine-source", sourceDatabase: "db", targetConnectionId: "routine-target", targetDatabase: "db" });
  assert.equal(options.routineContext, undefined);
  assert.deepEqual(options.sourceFunctions, programs);
});

test("fails a routine compare on source read errors before generating a removal plan", async () => {
  vi.clearAllMocks();
  apiMock.listFunctions.mockRejectedValueOnce(new Error("SRC.P_SYNC: ORA-01031")).mockResolvedValueOnce([]);
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "read-source",
      sourceDatabase: "db",
      sourceSchema: "SRC",
      targetConnectionId: "read-target",
      targetDatabase: "db",
      targetSchema: "DST",
      sourceDbType: "oracle",
      targetDbType: "oceanbase-oracle",
      options: { tables: false, functions: true },
      ignoreComments: false,
      label: "read failure",
    },
    { tableListLoader: { load: vi.fn() } },
  );
  await waitForSession(session);
  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /ORA-01031/);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
});

test("passes only the selected type body and exact source to preparation without merging its specification", async () => {
  vi.clearAllMocks();
  const source = { name: "Dot.Type", function_type: "TYPE", data_type: "", arguments: "", schema: "SRC", definition: 'CREATE TYPE "Dot.Type" UNDER BaseType (first NUMBER, second VARCHAR2(20)) NOT FINAL;' };
  const body = { ...source, function_type: "TYPE BODY", definition: 'CREATE TYPE BODY "Dot.Type" AS MEMBER PROCEDURE run AS BEGIN NULL; END; END;' };
  const targetBody = { ...body, schema: "DST" };
  apiMock.listFunctions.mockResolvedValueOnce([source, body]).mockResolvedValueOnce([{ ...source, schema: "DST" }, targetBody]);
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "type-source",
      sourceDatabase: "db",
      sourceSchema: "SRC",
      targetConnectionId: "type-target",
      targetDatabase: "db",
      targetSchema: "DST",
      sourceDbType: "oracle",
      targetDbType: "oracle",
      options: { tables: false, functions: true, selectedRoutines: ['TYPE BODY "Dot.Type"'] },
      ignoreComments: false,
      label: "type body",
    },
    { tableListLoader: { load: vi.fn() } },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed");
  const payload = apiMock.prepareSchemaDiff.mock.calls[0]?.[0];
  assert.deepEqual(payload.sourceFunctions, [body]);
  assert.deepEqual(payload.targetFunctions, [targetBody]);
  assert.equal(payload.sourceFunctions[0].definition, body.definition);
});
