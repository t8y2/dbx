import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { OraclePackageTransferPreview, OraclePackageTransferRequest } from "@/lib/backend/api";
import { acceptOraclePackageTransferApproval, acceptOraclePackageTransferPreflight, acceptOracleRoutineDeploymentOperation, createOracleRoutineDeployment, disposeOracleRoutineDeployment, oraclePackageTransferPendingReady, refreshOracleRoutineDeployment } from "@/lib/schema/oracleRoutineDeploy";

const refs = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend/api", () => ({ updateOracleRoutineOperationReferences: refs, loadSchemaDiffRoutines: load }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn() }));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: vi.fn() }));

function fixture() {
  const endpoint = { connectionId: "T", database: "tenant", schema: "T", databaseType: "oceanbase-oracle" as const, generation: 1 };
  const source = { endpoint: { ...endpoint, connectionId: "S", schema: "S" }, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
  const target = { ...source, endpoint };
  const drafts = (["PACKAGE", "PACKAGE_BODY"] as const).map((kind) => ({ identity: { owner: "T", name: "P", kind }, action: "create" as const, sourceName: "P", sql: `CREATE ${kind.replace("_", " ")} "T".P AS END;` }));
  const state = reactive(createOracleRoutineDeployment(source, target));
  state.drafts = drafts.map((draft) => ({ ...draft, objectId: draft.identity.kind, included: true }));
  state.executing = true;
  const steps = drafts.map((draft) => ({ ...draft, sourceOriginal: "完整原文 中文😀", targetOriginal: null, recoverySql: null, recoveryComplete: true, references: [], incomingCallers: [], issues: [], operation: null }));
  state.plan = { target: endpoint, steps, ready: false };
  const frozen: OraclePackageTransferRequest = { input: { source, target, drafts }, operationIds: [], pendingTables: { source: source.endpoint, target: endpoint, tables: [{ sourceTable: "SOURCE" }], dependencyManifest: {}, tableEvidence: [{ sourceTable: "SOURCE" }] } };
  const approval: OraclePackageTransferPreview = {
    input: frozen.input!,
    skipped: [],
    plan: { target: endpoint, ready: true, steps: steps.map((step, index) => ({ ...step, operation: { operationId: `operation-${index}`, target: endpoint, identity: step.identity, lifecycle: "prepared", dispatched: false, acknowledged: false, error: null, readback: null } })) },
  };
  return { state, frozen: structuredClone(frozen), approval: structuredClone(approval) };
}

beforeEach(() => {
  refs.mockReset();
  refs.mockResolvedValue(undefined);
});

describe("mixed package transfer approval handoff", () => {
  it("enables only the transfer confirmation layer for a matching pending plan, never ordinary deployment", () => {
    const { state, frozen, approval } = fixture();
    state.executing = false;
    const preview = { ...approval, pendingTables: frozen.pendingTables, plan: { ...approval.plan, ready: false, steps: approval.plan.steps.map((step) => ({ ...step, operation: null })) } };
    expect(oraclePackageTransferPendingReady(state, preview)).toBe(true);
    expect(state.plan?.ready).toBe(false);
    state.drafts[0].sql += " -- edited after validation";
    expect(oraclePackageTransferPendingReady(state, preview)).toBe(false);
    state.drafts[0].sql = frozen.input!.drafts[0].sql;
    preview.plan.steps[0].issues = [{ code: "missing-reference", message: "missing", line: 1, column: 1 }];
    expect(oraclePackageTransferPendingReady(state, preview)).toBe(false);
  });

  it("keeps post-table preflight issues in the original draft editor without adopting IDs or replaying tables", async () => {
    const { state, frozen, approval } = fixture();
    const preview = structuredClone(approval);
    preview.plan.ready = false;
    preview.plan.steps.forEach((step) => {
      step.operation = null;
    });
    preview.plan.steps[1].issues = [{ code: "missing-reference", message: "Missing column 中文😀", line: 3, column: 7 }];
    expect(acceptOraclePackageTransferPreflight(state, frozen, preview)).toBe(true);
    expect(state.plan?.steps[1].issues[0].column).toBe(7);
    expect(state.drafts[1].sql).toBe(frozen.input!.drafts[1].sql);
    expect(state.records).toEqual([]);
    await expect(acceptOraclePackageTransferApproval(state, frozen, approval)).resolves.toBe(false);
    const original = fixture();
    await acceptOraclePackageTransferApproval(original.state, original.frozen, original.approval);
    expect(acceptOraclePackageTransferPreflight(original.state, original.frozen, preview)).toBe(false);
    expect(original.state.records).toHaveLength(2);
    await disposeOracleRoutineDeployment(original.state);
  });

  it("freezes transfer refresh generations while preserving the ordinary explicit-refresh contract", async () => {
    const { state } = fixture();
    state.executing = false;
    const fixed = { source: { ...state.source.endpoint }, target: { ...state.target.endpoint } };
    load.mockImplementation(async (id: string, database: string, schema: string) => ({
      state: "complete",
      enumerationComplete: true,
      objects: [],
      issues: [],
      endpoint: { ...fixed.target, connectionId: id, database, schema, generation: 2 },
    }));
    await refreshOracleRoutineDeployment(state, fixed);
    expect(state.error).toContain("generation changed");
    expect(state.source.endpoint).toEqual(fixed.source);
    expect(state.target.endpoint).toEqual(fixed.target);
    const ordinary = fixture().state;
    ordinary.executing = false;
    await refreshOracleRoutineDeployment(ordinary);
    expect(ordinary.error).toBeNull();
    expect(ordinary.target.endpoint.generation).toBe(2);
  });

  it("installs only the exact ordered batch before a result can arrive and retains it for the task", async () => {
    const { state, frozen, approval } = fixture();
    let finish!: () => void;
    refs.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const accepting = acceptOraclePackageTransferApproval(state, frozen, approval);
    expect(state.records.map((record) => record.operationId)).toEqual(["operation-0", "operation-1"]);
    const result = { ...approval.plan.steps[1].operation!, lifecycle: "terminal" as const, dispatched: true, acknowledged: true, error: "body invalid" };
    expect(acceptOracleRoutineDeploymentOperation(state, result)).toBe(true);
    expect(state.drafts[1].operation).toEqual(result);
    expect(acceptOracleRoutineDeploymentOperation(state, { ...result, operationId: "unrelated" })).toBe(false);
    await vi.waitFor(() => expect(refs).toHaveBeenCalledWith(["operation-0", "operation-1"], []));
    finish();
    await expect(accepting).resolves.toBe(true);
    await expect(acceptOraclePackageTransferApproval(state, frozen, approval)).resolves.toBe(false);
    await disposeOracleRoutineDeployment(state);
    expect(refs).toHaveBeenLastCalledWith([], ["operation-0", "operation-1"]);
  });

  it("rejects changed source/target generations, final SQL, order, selection and unfamiliar execution state", async () => {
    for (let change = 0; change < 12; change++) {
      const { state, frozen, approval } = fixture();
      switch (change) {
        case 0:
          approval.input.source.endpoint.generation++;
          break;
        case 1:
          approval.plan.target = { ...approval.plan.target, connectionId: "another-target" };
          break;
        case 2:
          approval.plan.steps[1].sql += " -- changed";
          break;
        case 3:
          approval.plan.steps.reverse();
          break;
        case 4:
          approval.plan.steps.pop();
          break;
        case 5:
          approval.plan.steps[1].operation!.operationId = "operation-0";
          break;
        case 6:
          approval.plan.steps[0].operation!.dispatched = true;
          break;
        case 7:
          state.plan = null;
          break;
        case 8:
          state.executing = false;
          break;
        case 9:
          frozen.pendingTables = undefined;
          break;
        case 10:
          approval.input.drafts[0].sql += " -- changed";
          break;
        default:
          for (const identity of [state.drafts[0].identity, state.plan!.steps[0].identity, frozen.input!.drafts[0].identity, approval.input.drafts[0].identity, approval.plan.steps[0].identity, approval.plan.steps[0].operation!.identity]) identity.kind = "PROCEDURE";
      }
      await expect(acceptOraclePackageTransferApproval(state, frozen, approval)).resolves.toBe(false);
      expect(state.records).toEqual([]);
      expect(state.retainedOperationIds).toEqual([]);
    }
    expect(refs).not.toHaveBeenCalled();
  });

  it("releases a batch when its task is removed while the retain RPC is still pending", async () => {
    const { state, frozen, approval } = fixture();
    let finish!: () => void;
    refs.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const accepting = acceptOraclePackageTransferApproval(state, frozen, approval);
    await vi.waitFor(() => expect(refs).toHaveBeenCalledOnce());
    const disposing = disposeOracleRoutineDeployment(state);
    finish();
    await expect(accepting).resolves.toBe(false);
    await disposing;
    expect(refs).toHaveBeenLastCalledWith([], ["operation-0", "operation-1"]);
    expect(state.retainedOperationIds).toEqual([]);
  });

  it("keeps known IDs and the retain failure visible until normal task cleanup", async () => {
    const { state, frozen, approval } = fixture();
    refs.mockRejectedValueOnce(new Error("reference update unavailable"));
    await expect(acceptOraclePackageTransferApproval(state, frozen, approval)).resolves.toBe(false);
    expect(state.error).toBe("reference update unavailable");
    expect(state.records).toHaveLength(2);
    expect(state.retainedOperationIds).toEqual(["operation-0", "operation-1"]);
    await disposeOracleRoutineDeployment(state);
    expect(refs).toHaveBeenLastCalledWith([], ["operation-0", "operation-1"]);
  });
});
