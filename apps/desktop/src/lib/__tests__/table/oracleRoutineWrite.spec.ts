import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { OracleRoutineOperation, OracleRoutineSaveInput } from "@/types/schemaDiff";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

vi.mock("@/i18n", () => ({ default: { global: { t: (key: string, values?: Record<string, unknown>) => `${key} ${values?.operationId ?? ""}` } } }));
vi.mock("@/lib/backend/api", () => ({ prepareOracleRoutineSave: vi.fn(), updateOracleRoutineOperationReferences: vi.fn(async () => {}), executeOracleRoutineOperation: vi.fn(), observeOracleRoutineOperation: vi.fn(), executeQuery: vi.fn(), executeScript: vi.fn(), executeInTransaction: vi.fn() }));

const input = (): OracleRoutineSaveInput => ({ connectionId: "target", database: "tenant", identity: { owner: "Owner.Mixed", name: "Mixed.Func", kind: "FUNCTION" }, sql: 'CREATE OR REPLACE FUNCTION "Owner.Mixed"."Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END;' });
const record = (changes: Partial<OracleRoutineOperation> = {}): OracleRoutineOperation => ({
  operationId: "original-operation",
  target: { connectionId: "target", database: "tenant", schema: "Owner.Mixed", databaseType: "oceanbase-oracle", generation: 2 },
  identity: input().identity,
  lifecycle: "terminal",
  dispatched: true,
  acknowledged: true,
  readback: { identity: input().identity, state: "verified", exists: true, version: null, source: input().sql, definitionMatches: true, compilerMessages: [], issues: [] },
  error: null,
  ...changes,
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.mocked(api.prepareOracleRoutineSave).mockResolvedValue(record({ lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null }));
  vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(record());
});

describe("Oracle routine source save", () => {
  it.each(["PACKAGE", "PACKAGE_BODY"] as const)("routes ordinary %s saves through the same prepared operation instead of direct SQL", async (kind) => {
    const { prepareObjectSourceSave } = await import("@/lib/table/objectSourceEditor");
    const source = { ...input(), identity: { ...input().identity, kind }, sql: `CREATE OR REPLACE ${kind.replaceAll("_", " ")} "Owner.Mixed"."Mixed.Func" AS END "Mixed.Func";` };
    const operation = record({ identity: source.identity });
    operation.readback = { ...operation.readback!, identity: source.identity, source: source.sql };
    vi.mocked(api.prepareOracleRoutineSave).mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(operation);
    const save = await prepareObjectSourceSave(source.connectionId, source.database, "oceanbase-oracle", [source.sql], source.identity.owner, { objectType: kind, name: source.identity.name });
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledExactlyOnceWith(source);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    await expect(save()).resolves.toEqual(operation);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith(operation.operationId, source.sql);
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeScript).not.toHaveBeenCalled();
  });

  it("does not prepare or dispatch a specification while its body has an unknown original save", async () => {
    const { prepareObjectSourceSave } = await import("@/lib/table/objectSourceEditor");
    const source = input();
    const unknown = record({ identity: { ...source.identity, kind: "PACKAGE_BODY" }, lifecycle: "unproven", acknowledged: false });
    vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(unknown);
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: unknown, lifecycle: "unproven", error: null });
    const body = await prepareObjectSourceSave(source.connectionId, source.database, "oracle", ["body draft"], source.identity.owner, { objectType: "PACKAGE_BODY", name: source.identity.name });
    await expect(body()).rejects.toMatchObject({ operationId: unknown.operationId });
    const spec = await prepareObjectSourceSave(source.connectionId, source.database, "oracle", ["new specification draft"], source.identity.owner, { objectType: "PACKAGE", name: source.identity.name });
    await expect(spec()).rejects.toMatchObject({ operationId: unknown.operationId });
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledTimes(1);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("keeps specification success separate from its invalid companion body and includes the actual compiler error", async () => {
    const { objectSourceSaveSuccessMessage } = await import("@/lib/table/objectSourceEditor");
    const operation = record();
    operation.readback!.packageCompanion = {
      ...operation.readback!,
      identity: { ...operation.identity, kind: "PACKAGE_BODY" },
      state: "invalid",
      version: { identity: { ...operation.identity, kind: "PACKAGE_BODY" }, status: "INVALID", objectId: "2", lastDdlTime: "1" },
      compilerMessages: [{ attribute: "ERROR", line: 8, position: 4, text: "PLS-00323" }],
    };
    expect(objectSourceSaveSuccessMessage("saved", operation)).toBe("saved\nPACKAGE BODY: INVALID\nERROR 8:4 PLS-00323");
  });

  it("prepares before the real production confirmation and dispatches only the exact approved SQL", async () => {
    const { prepareObjectSourceSave } = await import("@/lib/table/objectSourceEditor");
    const { executeWithProductionSqlGuard } = await import("@/lib/database/productionExecutionGuard");
    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    setActivePinia(createPinia());
    const source = input();
    const execute = await prepareObjectSourceSave(source.connectionId, source.database, "oceanbase-oracle", [source.sql], source.identity.owner, { objectType: source.identity.kind, name: source.identity.name });
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledWith(source);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    const pending = executeWithProductionSqlGuard({ connection: { id: source.connectionId, name: "target", db_type: "oceanbase-oracle", is_production: true } as ConnectionConfig, database: source.database, sql: source.sql, source: "Object source", execute });
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toMatchObject({ sql: source.sql, database: source.database, source: "Object source" }));
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    useProductionSafetyStore().confirm();
    await expect(pending).resolves.toMatchObject({ operationId: "original-operation", lifecycle: "terminal" });
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith("original-operation", source.sql);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("canceling the real production confirmation leaves the prepared save undispatched", async () => {
    const { prepareObjectSourceSave } = await import("@/lib/table/objectSourceEditor");
    const { executeWithProductionSqlGuard } = await import("@/lib/database/productionExecutionGuard");
    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    setActivePinia(createPinia());
    const source = input();
    const execute = await prepareObjectSourceSave(source.connectionId, source.database, "oceanbase-oracle", [source.sql], source.identity.owner, { objectType: source.identity.kind, name: source.identity.name });
    const pending = executeWithProductionSqlGuard({ connection: { id: source.connectionId, name: "target", db_type: "oceanbase-oracle", is_production: true } as ConnectionConfig, database: source.database, sql: source.sql, source: "Object source", execute });
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeDefined());
    useProductionSafetyStore().cancel();
    await expect(pending).resolves.toBeUndefined();
    await execute.dispose?.();
    expect(api.updateOracleRoutineOperationReferences).toHaveBeenCalledWith(["original-operation"], []);
    expect(api.updateOracleRoutineOperationReferences).toHaveBeenLastCalledWith([], ["original-operation"]);
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledExactlyOnceWith(source);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("rejects acknowledged INVALID without reporting a successful save", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    const operation = record();
    operation.readback!.state = "invalid";
    operation.readback!.compilerMessages = [{ attribute: "ERROR", line: 3, position: 12, text: "missing identifier" }];
    vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(operation);
    const execute = await prepareOracleRoutineSourceSave(input());
    await expect(execute()).rejects.toMatchObject({ operation, operationId: "original-operation", message: expect.stringContaining("ERROR 3:12 missing identifier") });
  });

  it("retains the original ID after a lost wait and does not dispatch a newer draft", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    vi.mocked(api.executeOracleRoutineOperation).mockRejectedValue(new Error("HTTP wait ended"));
    const unresolved = record({ lifecycle: "unproven", acknowledged: false });
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: unresolved, lifecycle: "unproven", error: null });
    const first = await prepareOracleRoutineSourceSave(input());
    await expect(first()).rejects.toMatchObject({ operationId: "original-operation" });
    await first.dispose?.();
    expect(api.updateOracleRoutineOperationReferences).not.toHaveBeenCalledWith([], ["original-operation"]);
    const edited = { ...input(), sql: input().sql.replace("RETURN 1", "RETURN 2") };
    await expect((await prepareOracleRoutineSourceSave(edited))()).rejects.toMatchObject({ operationId: "original-operation" });
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledTimes(1);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
    expect(api.observeOracleRoutineOperation).toHaveBeenLastCalledWith("original-operation", true);
    // Matching readback is already present above, but cannot prove termination.
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: record(), lifecycle: "terminal", error: null });
    await expect((await prepareOracleRoutineSourceSave(edited))()).rejects.toThrow("objects.routineWriteDraftChanged");
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
  });

  it("a missing backend record remains unproven rather than creating a replacement ID", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    vi.mocked(api.executeOracleRoutineOperation).mockRejectedValue(new Error("disconnected"));
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: null, lifecycle: "unproven", error: "record unavailable" });
    await expect((await prepareOracleRoutineSourceSave(input()))()).rejects.toMatchObject({ operationId: "original-operation" });
    await expect((await prepareOracleRoutineSourceSave(input()))()).rejects.toMatchObject({ operationId: "original-operation", operation: null });
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledTimes(1);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
  });

  it("a second concurrently prepared editor cannot replace the pending ID", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    const first = await prepareOracleRoutineSourceSave(input());
    vi.mocked(api.prepareOracleRoutineSave).mockResolvedValue(record({ operationId: "second-operation", lifecycle: "prepared" }));
    const second = await prepareOracleRoutineSourceSave(input());
    vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(record({ lifecycle: "running", acknowledged: false, readback: null }));
    await expect(first()).rejects.toMatchObject({ operationId: "original-operation" });
    await expect(second()).rejects.toMatchObject({ operationId: "original-operation" });
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
  });

  it("verification requires terminal lifecycle, write acknowledgement, and full readback", async () => {
    const { oracleRoutineOperationVerified } = await import("@/lib/table/oracleRoutineWrite");
    expect(oracleRoutineOperationVerified(record())).toBe(true);
    for (const changes of [{ lifecycle: "running" }, { lifecycle: "unproven" }, { acknowledged: false }, { dispatched: false }, { readback: null }] as const) expect(oracleRoutineOperationVerified(record(changes))).toBe(false);
  });

  it("atomically supersedes an observed unstarted approval rather than replaying old edited SQL", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    const original = record({ lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    vi.mocked(api.executeOracleRoutineOperation).mockRejectedValueOnce(new Error("HTTP did not confirm arrival"));
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: original, lifecycle: "prepared", error: null });
    await expect((await prepareOracleRoutineSourceSave(input()))()).rejects.toMatchObject({ operationId: "original-operation" });
    const edited = { ...input(), sql: input().sql.replace("RETURN 1", "RETURN 2") };
    vi.mocked(api.prepareOracleRoutineSave).mockResolvedValue({ ...original, operationId: "new-approval" });
    vi.mocked(api.executeOracleRoutineOperation).mockResolvedValue(record({ operationId: "new-approval" }));
    const execute = await prepareOracleRoutineSourceSave(edited);
    expect(api.prepareOracleRoutineSave).toHaveBeenLastCalledWith({ ...edited, supersedesOperationId: "original-operation" });
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.updateOracleRoutineOperationReferences).mock.calls).toEqual([
      [["original-operation"], []],
      [["new-approval"], []],
      [[], ["original-operation"]],
    ]);
    await execute();
    expect(api.executeOracleRoutineOperation).toHaveBeenLastCalledWith("new-approval", edited.sql);
  });

  it("retains the original pending ID if replacement admission fails", async () => {
    const { prepareOracleRoutineSourceSave } = await import("@/lib/table/oracleRoutineWrite");
    const original = record({ lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    vi.mocked(api.executeOracleRoutineOperation).mockRejectedValue(new Error("response lost"));
    vi.mocked(api.observeOracleRoutineOperation).mockResolvedValue({ operation: original, lifecycle: "prepared", error: null });
    const execute = await prepareOracleRoutineSourceSave(input());
    await expect(execute()).rejects.toMatchObject({ operationId: original.operationId });
    vi.mocked(api.prepareOracleRoutineSave).mockRejectedValue(new Error("registry capacity exceeded"));
    await expect(prepareOracleRoutineSourceSave({ ...input(), sql: input().sql.replace("RETURN 1", "RETURN 2") })).rejects.toMatchObject({ operationId: original.operationId });
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledTimes(1);
    expect(api.updateOracleRoutineOperationReferences).not.toHaveBeenCalledWith([], [original.operationId]);
  });

  it("preserves WARNING locations in a successful source-save message", async () => {
    const { objectSourceSaveSuccessMessage } = await import("@/lib/table/objectSourceEditor");
    const operation = record();
    operation.readback!.compilerMessages = [{ attribute: "WARNING", line: 4, position: 8, text: "unused variable" }];
    expect(objectSourceSaveSuccessMessage("saved", operation)).toBe("saved\nWARNING 4:8 unused variable");
    expect(objectSourceSaveSuccessMessage("saved")).toBe("saved");
  });
});
