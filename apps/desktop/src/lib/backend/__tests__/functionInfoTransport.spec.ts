import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionInfo } from "@/types/database";
import type { FunctionDiff, SchemaDiffPreparationOptions } from "@/lib/schema/schemaDiff";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const wireProcedure = { name: "Mixed.Proc", functionType: "PROCEDURE", dataType: "", definition: 'CREATE PROCEDURE "Mixed.Proc" AS BEGIN NULL; END;', arguments: "" };
const procedure: FunctionInfo = { name: wireProcedure.name, function_type: "PROCEDURE", data_type: "", definition: wireProcedure.definition, arguments: "" };
const diff: FunctionDiff = { type: "modified", name: procedure.name, source: procedure, target: { ...procedure, definition: "old" } };

describe.each(["http", "tauri"] as const)("FunctionInfo %s transport", (transport) => {
  let backend: typeof import("@/lib/backend/http");
  let response: unknown;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    response = undefined;
    mocks.invoke.mockImplementation(async () => response);
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => response }));
    vi.stubGlobal("fetch", fetchMock);
    backend = await import(transport === "http" ? "@/lib/backend/http" : "@/lib/backend/tauri");
  });

  afterEach(() => vi.unstubAllGlobals());

  function sent(): Record<string, unknown> {
    if (transport === "tauri") return mocks.invoke.mock.calls.at(-1)![1] as Record<string, unknown>;
    return JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as Record<string, unknown>;
  }

  it("decodes the actual camelCase procedure list without treating it as a function", async () => {
    response = [wireProcedure];
    await expect(backend.listFunctions("connection", "database", "Owner.With.Dot")).resolves.toEqual([procedure]);
  });

  it("retains non-Oracle routine kinds and PostgreSQL overload arguments", async () => {
    response = [{ ...wireProcedure, functionType: "AGGREGATE", dataType: "integer", arguments: "integer, text" }];
    await expect(backend.listFunctions("pg", "db", "public")).resolves.toEqual([{ ...procedure, function_type: "AGGREGATE", data_type: "integer", arguments: "integer, text" }]);
  });

  it("continues accepting existing snake_case responses without mutating them", async () => {
    response = [procedure];
    await expect(backend.listFunctions("connection", "database", "APP")).resolves.toEqual([procedure]);
    expect(response).toEqual([procedure]);
  });

  it("retains a partial strict snapshot and its unread object instead of returning an empty list", async () => {
    response = {
      endpoint: { connectionId: "connection", database: "database", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle", generation: 3 },
      state: "partial",
      enumerationComplete: true,
      objects: [
        {
          version: { identity: { owner: "Owner.With.Dot", name: "Mixed.Proc", kind: "PROCEDURE" }, objectId: "9007199254740993", status: "INVALID", lastDdlTime: "2026-10-21T08:30:00" },
          source: null,
          sourceComplete: false,
          dependencies: [],
          dependenciesComplete: true,
          issues: [{ stage: "source", code: "read-incomplete", message: "source read failed" }],
        },
      ],
      issues: [],
    };
    await expect(backend.loadSchemaDiffRoutines("connection", "database", "Owner.With.Dot")).resolves.toEqual(response);
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("load_schema_diff_routines", { connectionId: "connection", database: "database", schema: "Owner.With.Dot" });
    else expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("/api/schema/diff-routines?connection_id=connection&database=database&schema=Owner.With.Dot");
  });

  it("keeps confirmed empty strict snapshots distinct from permission failures", async () => {
    response = { endpoint: { connectionId: "connection", database: "database", schema: "Owner.With.Dot", databaseType: "oracle", generation: 3 }, state: "complete", enumerationComplete: true, objects: [], issues: [] };
    await expect(backend.loadSchemaDiffRoutines("connection", "database", "Owner.With.Dot")).resolves.toEqual(response);
    response = { ...(response as object), state: "permission-denied", enumerationComplete: false, issues: [{ stage: "visibility", code: "permission-denied", message: "ORA-00942" }] };
    await expect(backend.loadSchemaDiffRoutines("connection", "database", "Owner.With.Dot")).resolves.toEqual(response);
  });

  it.each([{ names: [] }, { names: ["Quoted.Proc", "Dot.Name,WithComma", "lowerCase"] }])("transports exact selected routine names without broadening the read: $names", async ({ names }) => {
    await backend.loadSchemaDiffRoutines("connection", "database", "Owner.With.Dot", names);
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("load_schema_diff_routines", { connectionId: "connection", database: "database", schema: "Owner.With.Dot", selectedRoutines: names });
    else expect(JSON.parse(new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://localhost").searchParams.get("selected_routines")!)).toEqual(names);
  });

  it("prepares the exact routine identity and SQL without dispatching it", async () => {
    const input = { connectionId: "connection", database: "database", identity: { owner: "Owner.With.Dot", name: "Mixed.Proc", kind: "PROCEDURE" as const }, sql: wireProcedure.definition };
    response = { operationId: "bound-operation", lifecycle: "prepared", dispatched: false };
    await expect(backend.prepareOracleRoutineSave(input)).resolves.toEqual(response);
    expect(transport === "tauri" ? sent().input : sent()).toEqual(input);
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("prepare_oracle_routine_save", { input });
  });

  it("uses the original operation ID and approved SQL for execution", async () => {
    response = { operationId: "bound-operation", lifecycle: "running", dispatched: true };
    await expect(backend.executeOracleRoutineOperation("bound-operation", wireProcedure.definition)).resolves.toEqual(response);
    expect(sent()).toEqual({ operationId: "bound-operation", approvedSql: wireProcedure.definition });
  });

  it("retains complete snapshots and final per-object drafts in both controlled-plan transports", async () => {
    const snapshot = { endpoint: { connectionId: "target", database: "db", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle" as const, generation: 7 }, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
    const input = { source: snapshot, target: snapshot, drafts: [{ identity: { owner: "Owner.With.Dot", name: "Mixed.Proc", kind: "PROCEDURE" as const }, action: "replace" as const, sql: wireProcedure.definition, baselineOperationId: "failed-original", supersedesOperationId: "old-prepared" }] };
    response = { target: snapshot.endpoint, ready: false, steps: [{ sql: wireProcedure.definition, issues: [{ line: 4, column: 8, code: "unresolved-reference", message: "retain the final draft" }], operation: null }] };
    await expect(backend.prepareOracleRoutinePlan(input)).resolves.toEqual(response);
    expect(transport === "tauri" ? sent().input : sent()).toEqual(input);
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("prepare_oracle_routine_plan", { input });
  });

  it("prepares recovery only from the original recorded operation", async () => {
    response = { ready: false, steps: [{ recoveryComplete: false, sql: wireProcedure.definition }] };
    await expect(backend.prepareOracleRoutineRecovery("original-operation")).resolves.toEqual(response);
    expect(sent()).toEqual({ operationId: "original-operation" });
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("prepare_oracle_routine_recovery", { operationId: "original-operation" });
  });

  it("transports atomic operation retain and release through the same ownership boundary", async () => {
    await backend.updateOracleRoutineOperationReferences(["current"], ["abandoned"]);
    expect(sent()).toEqual({ retainOperationIds: ["current"], releaseOperationIds: ["abandoned"] });
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("update_oracle_routine_operation_references", { retainOperationIds: ["current"], releaseOperationIds: ["abandoned"] });
  });

  it("retains unproven when the original backend operation record is missing", async () => {
    response = { operation: null, lifecycle: "unproven", error: "record unavailable" };
    await expect(backend.observeOracleRoutineOperation("old-operation", true)).resolves.toEqual(response);
    if (transport === "tauri") expect(mocks.invoke).toHaveBeenLastCalledWith("observe_oracle_routine_operation", { operationId: "old-operation", refreshReadback: true });
    else expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("/api/schema/routine-operation?operation_id=old-operation&refresh_readback=true");
  });

  it("does not guess a kind when snake_case and camelCase disagree", async () => {
    response = [{ ...wireProcedure, function_type: "FUNCTION" }];
    await expect(backend.listFunctions("connection", "database", "APP")).rejects.toThrow(/conflict/i);
  });

  it("rejects contradictory return type fields", async () => {
    response = [{ ...wireProcedure, data_type: "NUMBER" }];
    await expect(backend.listFunctions("connection", "database", "APP")).rejects.toThrow(/conflict/i);
  });

  it("encodes both preparation inputs and decodes nested diff definitions", async () => {
    response = { diffs: [], syncSql: "", functionDiffs: [{ ...diff, source: wireProcedure, target: { ...wireProcedure, definition: "old" } }] };
    const options: SchemaDiffPreparationOptions = { sourceTables: [], targetTables: [], sourceDetails: [], targetDetails: [], sourceFunctions: [procedure], targetFunctions: [procedure], databaseType: "oceanbase-oracle" };
    const result = await backend.prepareSchemaDiff(options);
    const payload = transport === "tauri" ? sent().options : sent();
    expect(payload).toMatchObject({ sourceFunctions: [wireProcedure], targetFunctions: [wireProcedure] });
    expect((payload as SchemaDiffPreparationOptions).sourceFunctions![0]).not.toHaveProperty("function_type");
    expect(result.functionDiffs![0].source).toEqual(procedure);
    expect(result.functionDiffs![0].target).toEqual({ ...procedure, definition: "old" });
  });

  it("encodes nested source and target definitions in selected plan requests", async () => {
    response = { syncSql: "", rollbackCompleteness: "complete", missingRollbackObjects: [] };
    await backend.generateSchemaSyncPlan({ diffs: [], functionDiffs: [diff], sequenceDiffs: [], ruleDiffs: [], ownerDiffs: [] }, { databaseType: "oracle", targetSchema: "APP" });
    expect(sent()).toMatchObject({ functionDiffs: [{ source: wireProcedure, target: { ...wireProcedure, definition: "old" } }] });
    expect((sent().functionDiffs as FunctionDiff[])[0].source).not.toHaveProperty("function_type");
  });

  it("uses the same routine wire fields for the legacy SQL plan entry", async () => {
    response = "";
    await backend.generateSchemaSyncSql([], "oracle", "APP", [diff]);
    expect(sent()).toMatchObject({ functionDiffs: [{ source: wireProcedure, target: { ...wireProcedure, definition: "old" } }] });
  });
});
