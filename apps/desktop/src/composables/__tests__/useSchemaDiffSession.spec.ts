import { strict as assert } from "node:assert";
import { test, vi } from "vitest";
import { DEFAULT_MYSQL_OPTIONS, getDefaultOptionsForDbType } from "@/types/schemaDiff";

const apiMock = vi.hoisted(() => ({
  prepareSchemaDiff: vi.fn(),
  listFunctions: vi.fn(),
  listSequences: vi.fn(),
  listRules: vi.fn(),
  listOwners: vi.fn(),
  loadSchemaDiffRoutines: vi.fn().mockImplementation(async (connectionId: string, database: string, schema: string) => ({ endpoint: { connectionId, database, schema, databaseType: "oracle", generation: 1 }, state: "complete", enumerationComplete: true, objects: [], issues: [] })),
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
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ invalidateObjectMetadataCache: vi.fn().mockResolvedValue(undefined) }));

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
  const { invalidateObjectMetadataCache } = await import("@/lib/metadata/objectMetadataCache");
  assert.deepEqual(
    vi.mocked(invalidateObjectMetadataCache).mock.calls.map(([match]) => match),
    [
      { connectionId: "source", database: "app" },
      { connectionId: "target", database: "warehouse" },
    ],
  );
  for (const [tables] of vi.mocked(loadSchemaDetails).mock.calls) {
    assert.deepEqual(
      tables.map((table) => table.name),
      ["users"],
    );
  }
  vi.clearAllMocks();
});

test("skips metadata cache invalidation when refreshMetadata is turned off", async () => {
  const { loadSchemaDetails } = await import("@/lib/schema/schemaDiffMetadataLoad");
  const { invalidateObjectMetadataCache } = await import("@/lib/metadata/objectMetadataCache");
  vi.clearAllMocks();
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], renameCandidates: [], syncSql: "", rollbackSyncSql: "" });
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
      options: { functions: false, refreshMetadata: false },
      ignoreComments: false,
      label: "cached compare",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([{ name: "users", table_type: "BASE TABLE" }]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed");
  assert.equal(vi.mocked(loadSchemaDetails).mock.calls.length, 2);
  assert.equal(vi.mocked(invalidateObjectMetadataCache).mock.calls.length, 0);
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

test.each(["oracle", "oceanbase-oracle"] as const)("loads %s strict snapshots through the actual session entry instead of ordinary listFunctions", async (databaseType) => {
  vi.clearAllMocks();
  const raw = 'CREATE OR REPLACE PROCEDURE "Quoted.Proc" AS BEGIN NULL; /* keep  spaces 😀 */ END';
  apiMock.loadSchemaDiffRoutines.mockImplementation(async (connectionId: string, database: string, schema: string) => ({
    endpoint: { connectionId, database, schema, databaseType, generation: 4 },
    state: connectionId.endsWith("source") ? "partial" : "complete",
    enumerationComplete: true,
    objects: [
      {
        version: { identity: { owner: schema, name: "Quoted.Proc", kind: "PROCEDURE" }, objectId: "9007199254740993", status: "VALID", lastDdlTime: "2026-10-21T00:00:00" },
        source: raw,
        sourceComplete: !connectionId.endsWith("source"),
        dependenciesComplete: true,
        dependencies: [],
        issues: connectionId.endsWith("source") ? [{ stage: "source", code: "read-incomplete", message: "source limit" }] : [],
      },
    ],
    issues: [],
  }));
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: `${databaseType}-source`,
      sourceDatabase: "db",
      sourceSchema: "Source.With.Dot",
      targetConnectionId: `${databaseType}-target`,
      targetDatabase: "db",
      targetSchema: "Target",
      sourceDbType: databaseType,
      targetDbType: databaseType,
      options: { tables: false, views: false, functions: true, selectedRoutines: ["Quoted.Proc"] },
      ignoreComments: false,
      label: "strict routines",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  assert.equal(apiMock.loadSchemaDiffRoutines.mock.calls.length, 2);
  assert.equal(apiMock.loadSchemaDiffRoutines.mock.calls[0].length, 4);
  assert.deepEqual(apiMock.loadSchemaDiffRoutines.mock.calls[0][3], ["Quoted.Proc"]);
  assert.deepEqual(apiMock.loadSchemaDiffRoutines.mock.calls[1][3], ["Quoted.Proc"]);
  const payload = apiMock.prepareSchemaDiff.mock.calls[0][0];
  assert.equal(payload.sourceFunctions[0].function_type, "PROCEDURE");
  assert.equal(payload.sourceFunctions[0].definition, raw);
  assert.deepEqual(payload.oracleRoutines.sourceIncompleteNames, ["Quoted.Proc"]);
  assert.equal(payload.oracleRoutines.sourceDatabaseType, databaseType);
  assert.equal(payload.oracleRoutines.targetDatabaseType, databaseType);
  assert.equal(session.routineSnapshots?.source?.objects[0].source, raw);
});

test("a strict-snapshot endpoint mismatch fails the session without generating a false comparison", async () => {
  vi.clearAllMocks();
  apiMock.loadSchemaDiffRoutines.mockImplementation(async (connectionId: string, database: string, schema: string) => ({ endpoint: { connectionId, database, schema: `${schema}-wrong`, databaseType: "oracle", generation: 1 }, state: "complete", enumerationComplete: true, objects: [], issues: [] }));
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "wrong-source",
      sourceDatabase: "db",
      sourceSchema: "SOURCE",
      targetConnectionId: "wrong-target",
      targetDatabase: "db",
      targetSchema: "TARGET",
      sourceDbType: "oracle",
      targetDbType: "oracle",
      options: { tables: false, functions: true },
      ignoreComments: false,
      label: "mismatch",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /endpoint/);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
});

test("carries immutable BODY-only selection and kind-scoped evidence through the real comparison session", async () => {
  vi.clearAllMocks();
  apiMock.loadSchemaDiffRoutines.mockImplementation(async (connectionId: string, database: string, schema: string) => ({
    endpoint: { connectionId, database, schema, databaseType: "oceanbase-oracle", generation: 6 },
    state: connectionId.endsWith("source") ? "partial" : "complete",
    enumerationComplete: true,
    issues: [],
    objects: (["PACKAGE", "PACKAGE_BODY"] as const).map((kind, index) => ({
      version: { identity: { owner: schema, name: "Pkg.With.Dot", kind }, objectId: String(12 + index), status: "VALID", lastDdlTime: "2026-10-23T01:00:00" },
      source: `CREATE OR REPLACE ${kind.replace("_", " ")} "${schema}"."Pkg.With.Dot" AS END;`,
      sourceOrigin: "oceanbase-dictionary",
      sourceComplete: !(connectionId.endsWith("source") && kind === "PACKAGE_BODY"),
      dependenciesComplete: true,
      dependencies: [],
      issues: [],
    })),
  }));
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  const routineObjectKinds: Array<"PACKAGE_BODY" | "PACKAGE"> = ["PACKAGE_BODY"];
  const selectedRoutineObjects = [{ name: "Pkg.With.Dot", kind: "PACKAGE_BODY" as const }];
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "package-source",
      sourceDatabase: "db",
      sourceSchema: "S",
      targetConnectionId: "package-target",
      targetDatabase: "db",
      targetSchema: "T",
      sourceDbType: "oceanbase-oracle",
      targetDbType: "oceanbase-oracle",
      options: { tables: false, functions: true, routineObjectKinds, selectedRoutineObjects },
      ignoreComments: false,
      label: "body only",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  routineObjectKinds.push("PACKAGE");
  selectedRoutineObjects[0]!.name = "changed outside the session";
  await waitForSession(session);
  assert.equal(session.status, "completed", session.error ?? "");
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  for (const call of apiMock.loadSchemaDiffRoutines.mock.calls) {
    assert.equal(call[3], undefined);
    assert.deepEqual(call[4], { objectKinds: ["PACKAGE_BODY"], selectedObjects: [{ name: "Pkg.With.Dot", kind: "PACKAGE_BODY" }] });
  }
  assert.equal(session.routineSnapshots?.source?.objects.length, 2, "keep the specification as read-only evidence");
  assert.equal(session.routineSnapshots?.source?.objects[0]?.sourceOrigin, "oceanbase-dictionary");
  assert.equal(session.routineSnapshots?.target?.objects[1]?.sourceOrigin, "oceanbase-dictionary");
  const payload = apiMock.prepareSchemaDiff.mock.calls[0][0];
  assert.deepEqual(
    payload.sourceFunctions.map((object: { function_type: string }) => object.function_type),
    ["PACKAGE_BODY"],
  );
  assert.deepEqual(
    payload.targetFunctions.map((object: { function_type: string }) => object.function_type),
    ["PACKAGE_BODY"],
  );
  assert.deepEqual(payload.oracleRoutines.objectKinds, ["PACKAGE_BODY"]);
  assert.deepEqual(payload.oracleRoutines.sourceIncompleteObjects, [{ name: "Pkg.With.Dot", kind: "PACKAGE_BODY" }]);
  assert.deepEqual(payload.oracleRoutines.targetIncompleteObjects, []);
});

test("rejects package comparison on unsupported products instead of silently comparing empty lists", async () => {
  vi.clearAllMocks();
  apiMock.listFunctions.mockResolvedValue([]);
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "unsupported-source",
      sourceDatabase: "db",
      sourceSchema: "S",
      targetConnectionId: "unsupported-target",
      targetDatabase: "db",
      targetSchema: "T",
      sourceDbType: "mysql",
      targetDbType: "mysql",
      options: { tables: false, functions: true, routineObjectKinds: ["PACKAGE_BODY"] },
      ignoreComments: false,
      label: "unsupported",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /Oracle product/);
  assert.equal(apiMock.listFunctions.mock.calls.length, 0);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
});

test.each([
  ["oracle", "oceanbase-oracle"],
  ["oceanbase-oracle", "oracle"],
] as const)("loads exact package evidence for a read-only %s to %s comparison", async (sourceType, targetType) => {
  vi.clearAllMocks();
  apiMock.loadSchemaDiffRoutines.mockImplementation(async (connectionId: string, database: string, schema: string) => {
    const databaseType = connectionId.endsWith("source") ? sourceType : targetType;
    return {
      endpoint: { connectionId, database, schema, databaseType, generation: 1 },
      state: "complete",
      enumerationComplete: true,
      issues: [],
      objects: ["PACKAGE", "PACKAGE_BODY"].map((kind, index) => ({
        version: { identity: { owner: schema, name: "Pkg.With.Dot", kind }, objectId: String(10 + index), status: "VALID", lastDdlTime: "1" },
        source: `CREATE OR REPLACE ${kind.replace("_", " ")} "${schema}"."Pkg.With.Dot" AS END;`,
        sourceOrigin: databaseType === "oracle" ? "oracle-metadata" : "oceanbase-dictionary",
        sourceComplete: true,
        dependenciesComplete: true,
        dependencies: [],
        issues: [],
      })),
    };
  });
  apiMock.prepareSchemaDiff.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "cross-package-source",
      sourceDatabase: "db",
      sourceSchema: "S",
      targetConnectionId: "cross-package-target",
      targetDatabase: "db",
      targetSchema: "T",
      sourceDbType: sourceType,
      targetDbType: targetType,
      options: { tables: false, functions: true, routineObjectKinds: ["PACKAGE_BODY"], selectedRoutineObjects: [{ name: "Pkg.With.Dot", kind: "PACKAGE_BODY" }] },
      ignoreComments: false,
      label: "cross-product package",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "completed", session.error ?? "");
  assert.equal(apiMock.loadSchemaDiffRoutines.mock.calls.length, 2);
  const payload = apiMock.prepareSchemaDiff.mock.calls[0][0];
  assert.deepEqual(
    payload.sourceFunctions.map((object: { function_type: string }) => object.function_type),
    ["PACKAGE_BODY"],
  );
  assert.deepEqual(
    payload.targetFunctions.map((object: { function_type: string }) => object.function_type),
    ["PACKAGE_BODY"],
  );
  assert.equal(payload.oracleRoutines.sourceDatabaseType, sourceType);
  assert.equal(payload.oracleRoutines.targetDatabaseType, targetType);
  assert.equal(session.routineSnapshots?.source?.objects.length, 2);
});

test("rejects explicitly selected standalone kinds in a cross-product package comparison before metadata requests", async () => {
  vi.clearAllMocks();
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "cross-pf-source",
      sourceDatabase: "db",
      sourceSchema: "S",
      targetConnectionId: "cross-pf-target",
      targetDatabase: "db",
      targetSchema: "T",
      sourceDbType: "oracle",
      targetDbType: "oceanbase-oracle",
      options: { tables: false, functions: true, routineObjectKinds: ["FUNCTION", "PACKAGE_BODY"] },
      ignoreComments: false,
      label: "unsupported mixed kinds",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "failed");
  assert.equal(apiMock.loadSchemaDiffRoutines.mock.calls.length, 0);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
});

test.each([{ routineObjectKinds: ["PACKAGE_BODY"], selectedRoutines: ["P"] }, { selectedRoutineObjects: [{ name: "P", kind: "PACKAGE_BODY" }] }])("rejects ambiguous typed selection before issuing metadata requests: %j", async (selection) => {
  vi.clearAllMocks();
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "ambiguous-source",
      sourceDatabase: "db",
      sourceSchema: "S",
      targetConnectionId: "ambiguous-target",
      targetDatabase: "db",
      targetSchema: "T",
      sourceDbType: "oceanbase-oracle",
      targetDbType: "oceanbase-oracle",
      options: { tables: false, functions: true, ...selection },
      ignoreComments: false,
      label: "ambiguous",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  await waitForSession(session);
  assert.equal(session.status, "failed");
  assert.equal(apiMock.loadSchemaDiffRoutines.mock.calls.length, 0);
  assert.equal(apiMock.prepareSchemaDiff.mock.calls.length, 0);
});
