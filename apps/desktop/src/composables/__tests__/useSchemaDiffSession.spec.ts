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

async function waitForSession(session: { status: string }) {
  for (let attempt = 0; attempt < 40 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("defaults enable tables and functions compare for common targets", () => {
  assert.equal(DEFAULT_MYSQL_OPTIONS.tables, true);
  assert.equal(DEFAULT_MYSQL_OPTIONS.functions, true);
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

  const onOpen = trackerMock.addSchemaDiffTask.mock.calls[0]?.[2] as (() => void) | undefined;
  onOpen?.();
  assert.equal(openMock.mock.calls.at(-1)?.[0], session.id);
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
