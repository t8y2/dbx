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

  it("transports package kinds and typed selection without turning BODY-only into a legacy name selection", async () => {
    const options = { objectKinds: ["PACKAGE", "PACKAGE_BODY"] as Array<"PACKAGE" | "PACKAGE_BODY">, selectedObjects: [{ name: 'Pkg.With.Dot,"中文😀', kind: "PACKAGE_BODY" as const }] };
    response = {
      endpoint: { connectionId: "connection", database: "database", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle", generation: 3 },
      state: "partial",
      enumerationComplete: true,
      issues: [],
      objects: [
        {
          version: { identity: { owner: "Owner.With.Dot", ...options.selectedObjects[0] }, objectId: "9007199254740993", status: "INVALID", lastDdlTime: "2026-10-23T01:00:00" },
          source: null,
          sourceComplete: false,
          dependencies: [],
          dependenciesComplete: true,
          issues: [{ stage: "source", code: "permission-denied", message: "ORA-01031" }],
        },
      ],
    };
    await expect(backend.loadSchemaDiffRoutines("connection", "database", "Owner.With.Dot", undefined, options)).resolves.toEqual(response);
    if (transport === "tauri") {
      expect(mocks.invoke).toHaveBeenLastCalledWith("load_schema_diff_routines", { connectionId: "connection", database: "database", schema: "Owner.With.Dot", ...options });
    } else {
      const params = new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://localhost").searchParams;
      expect(JSON.parse(params.get("object_kinds")!)).toEqual(options.objectKinds);
      expect(JSON.parse(params.get("selected_objects")!)).toEqual(options.selectedObjects);
      expect(params.has("selected_routines")).toBe(false);
    }
  });

  it("uses the original operation ID and approved SQL for execution", async () => {
    response = { operationId: "bound-operation", lifecycle: "running", dispatched: true };
    await expect(backend.executeOracleRoutineOperation("bound-operation", wireProcedure.definition)).resolves.toEqual(response);
    expect(sent()).toEqual({ operationId: "bound-operation", approvedSql: wireProcedure.definition });
  });

  it("preserves explicit new-package absence protection in controlled save requests", async () => {
    const input = { connectionId: "target", database: "tenant", identity: { owner: "Owner.With.Dot", name: "Pkg.With.Dot", kind: "PACKAGE" as const }, sql: 'CREATE PACKAGE "Owner.With.Dot"."Pkg.With.Dot" AS g NUMBER; END;', requireAbsent: true };
    response = { operationId: "package-save", identity: input.identity, lifecycle: "prepared" };
    await expect(backend.prepareOracleRoutineSave(input)).resolves.toEqual(response);
    expect(transport === "tauri" ? sent().input : sent()).toEqual(input);
  });

  it("binds a Save As body request to its original verified specification operation", async () => {
    const input = {
      connectionId: "target",
      database: "tenant",
      identity: { owner: "Owner.With.Dot", name: "Pkg.With.Dot", kind: "PACKAGE_BODY" as const },
      sql: 'CREATE PACKAGE BODY "Owner.With.Dot"."Pkg.With.Dot" AS END;',
      requireAbsent: true,
      prerequisiteOperationId: "verified-new-specification",
    };
    response = { operationId: "package-body-save", identity: input.identity, lifecycle: "prepared" };
    await expect(backend.prepareOracleRoutineSave(input)).resolves.toEqual(response);
    expect(transport === "tauri" ? sent().input : sent()).toEqual(input);
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

  it("preserves explicit retained-body and target-contract choices instead of broadening package selection", async () => {
    const snapshot = { endpoint: { connectionId: "target", database: "db", schema: "Owner.With.Dot", databaseType: "oceanbase-oracle" as const, generation: 7 }, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
    const identity = { owner: "Owner.With.Dot", name: "Pkg.With.Dot", kind: "PACKAGE_BODY" as const };
    const input = { source: snapshot, target: snapshot, drafts: [{ identity, action: "replace" as const, packageBodySource: "target" as const, packageContract: "target" as const, confirmPackagePair: true, sql: "retained body draft" }] };
    response = {
      target: snapshot.endpoint,
      ready: false,
      steps: [
        {
          identity,
          sql: input.drafts[0].sql,
          packageImpact: { companion: { ...identity, kind: "PACKAGE" }, companionAction: null, implicitCompanionDelete: false, retainsTargetBody: true, bodyPending: false, mayInitialize: true, grants: null },
          issues: [{ code: "plan-preflight", message: "Refresh the complete target pair", line: 1, column: 1 }],
        },
      ],
    };
    const result = await backend.prepareOracleRoutinePlan(input);
    expect(result).toEqual(response);
    expect(transport === "tauri" ? sent().input : sent()).toEqual(input);
    expect(result.steps[0]?.packageImpact?.retainsTargetBody).toBe(true);
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

  it("retains the independently identified package companion and exact source origins in operation readback", async () => {
    const identity = { owner: "Owner.With.Dot", name: "Pkg.With.Dot", kind: "PACKAGE" as const };
    const companion = {
      identity: { ...identity, kind: "PACKAGE_BODY" as const },
      state: "invalid" as const,
      exists: true,
      version: null,
      source: "CREATE PACKAGE BODY ...",
      sourceOrigin: "oceanbase-dictionary" as const,
      definitionMatches: null,
      compilerMessages: [{ attribute: "ERROR", line: 1, position: 0, text: "PLS-00323" }],
      issues: [],
    };
    response = {
      operation: {
        operationId: "package-spec",
        identity,
        lifecycle: "terminal",
        dispatched: true,
        acknowledged: true,
        error: null,
        readback: { identity, state: "verified", exists: true, version: null, source: "CREATE PACKAGE ...", sourceOrigin: "oracle-metadata", packageCompanion: companion, definitionMatches: true, compilerMessages: [], issues: [] },
      },
      lifecycle: "terminal",
      error: null,
    };
    const observed = await backend.observeOracleRoutineOperation("package-spec", true);
    expect(observed).toEqual(response);
    expect(observed.operation?.readback?.packageCompanion).toEqual(companion);
    expect(observed.operation?.readback?.sourceOrigin).toBe("oracle-metadata");
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

  it("retains explicit package diff identity and kind-scoped read issues through preparation and selected SQL requests", async () => {
    const body = { ...procedure, name: "Pkg.With.Dot", function_type: "PACKAGE_BODY", definition: 'CREATE OR REPLACE PACKAGE BODY "S"."Pkg.With.Dot" AS END;' };
    const targetBody = { ...body, definition: body.definition.replace('"S".', '"T".') };
    const wireBody = { ...wireProcedure, name: body.name, functionType: "PACKAGE_BODY", definition: body.definition };
    const wireTarget = { ...wireBody, definition: targetBody.definition };
    const packageDiff: FunctionDiff = { type: "unreadable", name: body.name, programKind: "PACKAGE_BODY", source: body, target: targetBody };
    const oracleRoutines = {
      sourceDatabaseType: "oceanbase-oracle",
      targetDatabaseType: "oceanbase-oracle",
      sourceSchema: "S",
      targetSchema: "T",
      sourceEnumerationComplete: true,
      targetEnumerationComplete: true,
      sourceIncompleteNames: [body.name],
      targetIncompleteNames: [],
      objectKinds: ["PACKAGE", "PACKAGE_BODY"] as Array<"PACKAGE" | "PACKAGE_BODY">,
      sourceIncompleteObjects: [{ name: body.name, kind: "PACKAGE_BODY" as const }],
      targetIncompleteObjects: [],
    };
    response = { diffs: [], syncSql: "", functionDiffs: [{ ...packageDiff, source: wireBody, target: wireTarget }] };
    const result = await backend.prepareSchemaDiff({ sourceTables: [], targetTables: [], sourceDetails: [], targetDetails: [], sourceFunctions: [body], targetFunctions: [targetBody], databaseType: "oceanbase-oracle", oracleRoutines });
    expect(result.functionDiffs).toEqual([packageDiff]);
    expect(transport === "tauri" ? sent().options : sent()).toMatchObject({ oracleRoutines });
    response = { syncSql: "", rollbackCompleteness: "complete", missingRollbackObjects: [] };
    await backend.generateSchemaSyncPlan({ diffs: [], functionDiffs: result.functionDiffs!, sequenceDiffs: [], ruleDiffs: [], ownerDiffs: [] }, { databaseType: "oceanbase-oracle", targetSchema: "T" });
    expect(sent()).toMatchObject({ functionDiffs: [{ programKind: "PACKAGE_BODY", source: wireBody, target: wireTarget }] });
  });

  it("uses the same routine wire fields for the legacy SQL plan entry", async () => {
    response = "";
    await backend.generateSchemaSyncSql([], "oracle", "APP", [diff]);
    expect(sent()).toMatchObject({ functionDiffs: [{ source: wireProcedure, target: { ...wireProcedure, definition: "old" } }] });
  });
});
