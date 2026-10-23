import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOracleRoutineDeployment,
  disposeOracleRoutineDeployment,
  editOracleRoutineDraft,
  executeOracleRoutineDeployment,
  observeOracleRoutineDeployment,
  prepareOracleRoutineRecovery,
  refreshOracleRoutineDeployment,
  selectOracleRoutineDraft,
  synchronizeOracleRoutineSelection,
  validateOracleRoutineDeployment,
} from "@/lib/schema/oracleRoutineDeploy";
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";
import type { OracleRoutineOperation, OracleRoutinePlan, OracleRoutineSnapshot } from "@/types/schemaDiff";

const calls = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn(), observe: vi.fn(), recovery: vi.fn(), load: vi.fn(), invalidate: vi.fn(), refs: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  prepareOracleRoutinePlan: calls.prepare,
  executeOracleRoutineOperation: calls.execute,
  observeOracleRoutineOperation: calls.observe,
  prepareOracleRoutineRecovery: calls.recovery,
  loadSchemaDiffRoutines: calls.load,
  updateOracleRoutineOperationReferences: calls.refs,
}));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: calls.invalidate }));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: calls.invalidate }));

const endpoint = { connectionId: "target", database: "db", schema: "Target.With.Dot", databaseType: "oceanbase-oracle" as const, generation: 7 };
const snapshot: OracleRoutineSnapshot = { endpoint, state: "complete", enumerationComplete: true, objects: [], issues: [] };
function object(name: string): SchemaDiffObject {
  return { id: `func-${name}`, name, operationType: "create", objectKind: "function", routineType: "FUNCTION", selected: true };
}
function operation(name: string, id = `${name}-approved`): OracleRoutineOperation {
  return { operationId: id, target: endpoint, identity: { owner: endpoint.schema, name, kind: "FUNCTION" }, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null, error: null };
}
function plan(...names: string[]): OracleRoutinePlan {
  return {
    target: endpoint,
    ready: true,
    steps: names.map((name) => ({
      identity: operation(name).identity,
      action: "create",
      sql: `CREATE FUNCTION "Target.With.Dot"."${name}" RETURN NUMBER AS BEGIN RETURN 1; END;`,
      sourceOriginal: `original ${name}`,
      targetOriginal: null,
      recoverySql: `DROP FUNCTION "Target.With.Dot"."${name}";`,
      recoveryComplete: true,
      references: [],
      incomingCallers: [],
      issues: [],
      operation: operation(name),
    })),
  };
}
function finished(name: string, state: "verified" | "invalid" = "verified"): OracleRoutineOperation {
  return {
    ...operation(name),
    lifecycle: "terminal",
    dispatched: true,
    acknowledged: true,
    readback: { identity: operation(name).identity, state, exists: true, version: null, source: "recorded full source", definitionMatches: true, compilerMessages: state === "invalid" ? [{ attribute: "ERROR", line: 2, position: 3, text: "missing identifier" }] : [], issues: [] },
  };
}
function state(...names: string[]) {
  const state = createOracleRoutineDeployment({ ...snapshot, endpoint: { ...endpoint, connectionId: "source", schema: "Source" } }, snapshot);
  synchronizeOracleRoutineSelection(state, names.map(object));
  return state;
}
const authorize = async (_: string, run: () => Promise<void>) => run();

beforeEach(() => {
  vi.clearAllMocks();
  calls.invalidate.mockResolvedValue(undefined);
  calls.refs.mockResolvedValue(undefined);
  calls.observe.mockImplementation(async (id: string) => ({ operation: operation(id.replace(/-approved$/, ""), id), lifecycle: "prepared", error: null }));
});

describe("Oracle routine deployment in the existing comparison session", () => {
  it("preserves the existing approved plan when revalidation is rejected by capacity admission", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValueOnce(plan("F"));
    await validateOracleRoutineDeployment(session);
    const approved = session.plan;
    calls.prepare.mockRejectedValueOnce(new Error("Routine operation registry capacity exceeded"));
    await validateOracleRoutineDeployment(session);
    expect(session.plan).toBe(approved);
    expect(session.plan?.ready).toBe(true);
    expect(session.drafts[0].operation?.operationId).toBe("F-approved");
    expect(calls.refs).not.toHaveBeenCalledWith([], ["F-approved"]);
  });
  it("keeps approval ownership across a stopped view, releasing only when the session is removed", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    expect(calls.refs).toHaveBeenCalledWith(["F-approved"], []);
    session.stopRequested = true;
    expect(calls.refs).not.toHaveBeenCalledWith([], ["F-approved"]);
    await disposeOracleRoutineDeployment(session);
    expect(calls.refs).toHaveBeenLastCalledWith([], ["F-approved"]);
    expect(session.retainedOperationIds).toEqual([]);
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("releases a late plan instead of reviving a removed session", async () => {
    const session = state("F");
    let resolve!: (plan: OracleRoutinePlan) => void;
    calls.prepare.mockReturnValue(
      new Promise<OracleRoutinePlan>((done) => {
        resolve = done;
      }),
    );
    const pending = validateOracleRoutineDeployment(session);
    await vi.waitFor(() => expect(calls.prepare).toHaveBeenCalled());
    await disposeOracleRoutineDeployment(session);
    resolve(plan("F"));
    await pending;
    expect(session.plan).toBeNull();
    expect(session.retainedOperationIds).toEqual([]);
    expect(calls.refs).toHaveBeenLastCalledWith([], ["F-approved"]);
  });

  it("reclaims superseded unsubmitted approvals after the replacement has been retained", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValueOnce(plan("F"));
    await validateOracleRoutineDeployment(session);
    editOracleRoutineDraft(session, "func-F", "changed draft");
    const replacement = plan("F");
    replacement.steps[0].operation = operation("F", "replacement");
    calls.prepare.mockResolvedValueOnce(replacement);
    await validateOracleRoutineDeployment(session);
    expect(session.records.map((record) => record.operationId)).toEqual(["replacement"]);
    expect(session.retainedOperationIds).toEqual(["replacement"]);
    expect(calls.refs.mock.calls.slice(-2)).toEqual([
      [["replacement"], []],
      [[], ["F-approved"]],
    ]);
  });

  it("does not forget a submitted execute temporarily observed as Prepared during edit and refresh", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    calls.execute.mockRejectedValue(new Error("response lost before arrival is known"));
    await executeOracleRoutineDeployment(session, authorize);
    expect(session.attemptedOperationIds).toEqual(["F-approved"]);
    editOracleRoutineDraft(session, "func-F", "new draft");
    calls.load.mockImplementation(async (id: string) => (id === "source" ? session.source : session.target));
    await refreshOracleRoutineDeployment(session);
    calls.prepare.mockRejectedValue(new Error("capacity exceeded"));
    await validateOracleRoutineDeployment(session);
    expect(session.retainedOperationIds).toContain("F-approved");
    expect(session.records.some((record) => record.operationId === "F-approved")).toBe(true);
    expect(calls.prepare.mock.calls.at(-1)![0].drafts[0].supersedesOperationId).toBe("F-approved");
    expect(calls.refs).not.toHaveBeenCalledWith([], ["F-approved"]);
    expect(calls.execute).toHaveBeenCalledTimes(1);
  });

  it("retains raw snapshots and drafts while final validation replaces only the approved plan", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    const original = session.source;
    editOracleRoutineDraft(session, "func-F", "manual final definition");
    expect(session.plan).toBeNull();
    expect(session.source).toBe(original);
    await validateOracleRoutineDeployment(session);
    expect(calls.prepare.mock.calls[1][0].drafts[0]).toMatchObject({ sql: "manual final definition", supersedesOperationId: "F-approved" });
  });

  it("ignores a late validation after an edit without replacing the newer draft", async () => {
    const session = state("F");
    let resolve!: (value: OracleRoutinePlan) => void;
    calls.prepare.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = validateOracleRoutineDeployment(session);
    editOracleRoutineDraft(session, "func-F", "newer final text");
    resolve(plan("F"));
    await pending;
    expect(session.plan).toBeNull();
    expect(session.drafts[0].sql).toBe("newer final text");
  });

  it("keeps object issues and corrected text available instead of discarding the entire preview", async () => {
    const session = state("F", "G");
    const response = plan("F", "G");
    response.ready = false;
    response.steps[0].issues = [{ code: "unresolved-reference", message: "qualify the reference", line: 4, column: 9 }];
    calls.prepare.mockResolvedValue(response);
    await validateOracleRoutineDeployment(session);
    expect(session.plan?.steps[0].issues[0]).toMatchObject({ line: 4, column: 9 });
    expect(session.drafts[1].sql).toContain('"G"');
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("canceling production confirmation retains approval and drafts without dispatch", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    const text = session.drafts[0].sql;
    await executeOracleRoutineDeployment(session, async () => undefined);
    expect(calls.execute).not.toHaveBeenCalled();
    expect(session.plan?.ready).toBe(true);
    expect(session.drafts[0].sql).toBe(text);
  });

  it("stops at the first INVALID result, retains the first success and only corrects the failed/remaining steps", async () => {
    const session = state("F", "G", "H");
    calls.prepare.mockResolvedValue(plan("F", "G", "H"));
    await validateOracleRoutineDeployment(session);
    calls.execute.mockResolvedValueOnce(finished("F")).mockResolvedValueOnce(finished("G", "invalid"));
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute.mock.calls.map((call) => call[0])).toEqual(["F-approved", "G-approved"]);
    expect(session.records.find((record) => record.operationId === "F-approved")?.readback?.state).toBe("verified");
    expect(session.plan?.ready).toBe(false);
    editOracleRoutineDraft(session, "func-G", "corrected G definition");
    calls.observe.mockImplementation(async (id: string) => ({ operation: id === "G-approved" ? finished("G", "invalid") : operation("H"), lifecycle: id === "G-approved" ? "terminal" : "prepared", error: null }));
    calls.prepare.mockResolvedValue(plan("G", "H"));
    await validateOracleRoutineDeployment(session);
    const input = calls.prepare.mock.calls.at(-1)![0];
    expect(input.drafts.map((draft: { identity: { name: string } }) => draft.identity.name)).toEqual(["G", "H"]);
    expect(input.drafts[0]).toMatchObject({ action: "replace", baselineOperationId: "G-approved", sql: "corrected G definition" });
    expect(input.drafts[1]).toMatchObject({ supersedesOperationId: "H-approved" });
  });

  it("closing during the current write only prevents the next step and keeps the late result on its original session", async () => {
    const original = state("F", "G");
    calls.prepare.mockResolvedValue(plan("F", "G"));
    await validateOracleRoutineDeployment(original);
    let resolve!: (value: OracleRoutineOperation) => void;
    calls.execute.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = executeOracleRoutineDeployment(original, authorize);
    original.stopRequested = true;
    const other = state("Other");
    resolve(finished("F"));
    await pending;
    expect(calls.execute).toHaveBeenCalledTimes(1);
    expect(original.records.some((record) => record.readback?.state === "verified")).toBe(true);
    expect(other.records).toEqual([]);
    await executeOracleRoutineDeployment(original, authorize);
    expect(calls.execute).toHaveBeenCalledTimes(1);
  });

  it("duplicate clicks cannot dispatch a second request while the first is waiting", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    let resolve!: (value: OracleRoutineOperation) => void;
    calls.execute.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = executeOracleRoutineDeployment(session, authorize);
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute).toHaveBeenCalledTimes(1);
    resolve(finished("F"));
    await first;
  });

  it("a lost execute response retains its original ID and unknown only offers read-only observation", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    calls.execute.mockRejectedValue(new Error("transport ended"));
    calls.observe.mockResolvedValue({ operation: { ...operation("F"), lifecycle: "unproven", dispatched: true }, lifecycle: "unproven", error: null });
    await executeOracleRoutineDeployment(session, authorize);
    await validateOracleRoutineDeployment(session);
    expect(calls.prepare).toHaveBeenCalledTimes(1);
    expect(calls.execute).toHaveBeenCalledTimes(1);
    expect(session.error).toContain("F-approved");
    await observeOracleRoutineDeployment(session, "F-approved");
    expect(calls.observe).toHaveBeenLastCalledWith("F-approved", true);
    expect(calls.execute).toHaveBeenCalledTimes(1);
  });

  it("a missing Core record cannot be treated as permission to prepare a new operation", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue(plan("F"));
    await validateOracleRoutineDeployment(session);
    calls.execute.mockRejectedValue(new Error("lost"));
    calls.observe.mockResolvedValue({ operation: null, lifecycle: "unproven", error: "original record unavailable" });
    await executeOracleRoutineDeployment(session, authorize);
    await validateOracleRoutineDeployment(session);
    expect(calls.prepare).toHaveBeenCalledTimes(1);
    expect(session.error).toContain("original record unavailable");
  });

  it("selection changes retain manual drafts and completed history instead of rebuilding from raw source", () => {
    const session = state("F");
    editOracleRoutineDraft(session, "func-F", "manual F");
    synchronizeOracleRoutineSelection(session, [{ ...object("F"), selected: false }]);
    synchronizeOracleRoutineSelection(session, [object("F")]);
    expect(session.drafts).toHaveLength(1);
    expect(session.drafts[0].sql).toBe("manual F");
  });

  it("recovery preserves copyable SQL and blocks incomplete restoration instead of dispatching it", async () => {
    const session = state("F");
    const response = plan("F");
    response.ready = false;
    response.steps[0].recoveryComplete = false;
    response.steps[0].issues = [{ code: "plan-preflight", message: "deleted grants were not captured", line: 1, column: 1 }];
    calls.recovery.mockResolvedValue(response);
    await prepareOracleRoutineRecovery(session, "F-original");
    expect(calls.recovery).toHaveBeenCalledWith("F-original");
    expect(session.recoveryPlan?.steps[0].sql).toContain("CREATE FUNCTION");
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("rejects a validation response bound to another target", async () => {
    const session = state("F");
    calls.prepare.mockResolvedValue({ ...plan("F"), target: { ...endpoint, schema: "Other" } });
    await validateOracleRoutineDeployment(session);
    expect(session.plan).toBeNull();
    expect(session.error).toContain("another comparison target");
  });

  it("explicit baseline refresh retains manual text and history while adopting freshly read target existence", async () => {
    const session = state("F");
    editOracleRoutineDraft(session, "func-F", "manual corrected text");
    session.drafts[0].operation = finished("F", "invalid");
    session.records.push(finished("F", "invalid"));
    calls.observe.mockResolvedValue({ operation: finished("F", "invalid"), lifecycle: "terminal", error: null });
    calls.load.mockImplementation(async (connectionId: string) =>
      connectionId === "source" ? session.source : { ...snapshot, objects: [{ version: { identity: operation("F").identity, objectId: "1", status: "INVALID", lastDdlTime: "now" }, source: "current target source", sourceComplete: true, dependencies: [], dependenciesComplete: true, issues: [] }] },
    );
    await refreshOracleRoutineDeployment(session);
    expect(session.drafts[0]).toMatchObject({ sql: "manual corrected text", action: "replace" });
    expect(session.drafts[0].operation).toBeUndefined();
    expect(session.records).toHaveLength(1);
    expect(session.target.objects).toHaveLength(1);
    expect(calls.load).toHaveBeenCalledWith("source", session.source.endpoint.database, session.source.endpoint.schema, ["F"]);
    expect(calls.load).toHaveBeenCalledWith(snapshot.endpoint.connectionId, snapshot.endpoint.database, snapshot.endpoint.schema, ["F"]);
  });

  it("refresh verifies an acknowledged deletion by its original ID and resumes only unfinished steps", async () => {
    const session = state("F", "G");
    session.drafts[0].action = "delete";
    const approved = plan("F", "G");
    approved.steps[0].action = "delete";
    approved.steps[0].sql = 'DROP FUNCTION "Target.With.Dot"."F";';
    calls.prepare.mockResolvedValueOnce(approved).mockResolvedValueOnce(plan("G"));
    await validateOracleRoutineDeployment(session);
    const failedReadback = { ...finished("F"), readback: null, error: "Readback unavailable" };
    calls.execute.mockResolvedValueOnce(failedReadback).mockResolvedValueOnce(finished("G"));
    await executeOracleRoutineDeployment(session, authorize);
    const absent = finished("F");
    absent.readback = { ...absent.readback!, exists: false, source: null };
    calls.observe.mockImplementation(async (id: string, refresh: boolean) => ({ operation: id === "G-approved" ? operation("G") : refresh ? absent : failedReadback, lifecycle: id === "G-approved" ? "prepared" : "terminal", error: null }));
    calls.load.mockImplementation(async (id: string) => (id === "source" ? session.source : snapshot));
    await refreshOracleRoutineDeployment(session);
    expect(calls.observe).toHaveBeenCalledWith("F-approved", true);
    expect(session.drafts[0].operation).toMatchObject({ operationId: "F-approved", readback: { state: "verified", exists: false } });
    await validateOracleRoutineDeployment(session);
    expect(calls.prepare.mock.calls.at(-1)![0].drafts.map((draft: { identity: { name: string } }) => draft.identity.name)).toEqual(["G"]);
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute.mock.calls.map((call) => call[0])).toEqual(["F-approved", "G-approved"]);
    expect(session.records.find((record) => record.operationId === "F-approved")?.readback?.exists).toBe(false);
  });

  it.each(["unacknowledged", "readback-failed", "still-exists"] as const)("refresh retains the original deletion when completion is not proven (%s)", async (scenario) => {
    const session = state("F");
    session.drafts[0].action = "delete";
    const record = finished("F");
    if (scenario === "unacknowledged") {
      record.acknowledged = false;
      record.readback = { ...record.readback!, exists: false, source: null };
    } else if (scenario === "readback-failed") record.readback = null;
    else record.readback!.state = "invalid";
    session.drafts[0].operation = record;
    calls.observe.mockResolvedValue({ operation: record, lifecycle: "terminal", error: null });
    calls.load.mockImplementation(async (id: string) => (id === "source" ? session.source : snapshot));
    await refreshOracleRoutineDeployment(session);
    expect(session.drafts[0].operation).toEqual(record);
    calls.prepare.mockResolvedValue({ ...plan("F"), ready: false });
    await validateOracleRoutineDeployment(session);
    expect(calls.prepare.mock.calls.at(-1)![0].drafts).toHaveLength(1);
    expect(calls.prepare.mock.calls.at(-1)![0].drafts[0]).toMatchObject({ action: "delete", baselineOperationId: "F-approved" });
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("selects the recovery's own object and leaves recovery preview when another draft is selected", async () => {
    const session = state("F", "G");
    calls.recovery.mockResolvedValue(plan("G"));
    await prepareOracleRoutineRecovery(session, "G-original");
    expect(session.selectedObjectId).toBe("func-G");
    selectOracleRoutineDraft(session, "func-F");
    expect(session.recoveryPlan).toBeNull();
    expect(session.selectedObjectId).toBe("func-F");
    await executeOracleRoutineDeployment(session, authorize);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("keeps a recovery's visible identity fixed during its confirmation and write", async () => {
    const session = state("F", "G");
    session.recoveryPlan = plan("F");
    session.executing = true;
    selectOracleRoutineDraft(session, "func-G");
    expect(session.selectedObjectId).toBe("func-F");
    expect(session.recoveryPlan).not.toBeNull();
  });

  it("baseline refresh cannot erase an unresolved operation to obtain a new write ID", async () => {
    const session = state("F");
    session.drafts[0].operation = { ...operation("F"), lifecycle: "unproven" };
    calls.observe.mockResolvedValue({ operation: session.drafts[0].operation, lifecycle: "unproven", error: null });
    await refreshOracleRoutineDeployment(session);
    expect(calls.load).not.toHaveBeenCalled();
    expect(session.error).toContain("termination");
    expect(session.drafts[0].operation.operationId).toBe("F-approved");
  });
});
