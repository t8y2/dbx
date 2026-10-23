import * as api from "@/lib/backend/api";
import { oracleRoutineOperationVerified } from "@/lib/table/oracleRoutineWrite";
import { beginSourceSave, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";
import type { OracleRoutineIdentity, OracleRoutineOperation, OracleRoutinePlan, OracleRoutinePlanDraft, OracleRoutinePlanStep, OracleRoutineSnapshot } from "@/types/schemaDiff";
import { releaseOracleRoutineOperations, retainOracleRoutineOperations } from "@/lib/table/oracleRoutineOperationReferences";

export interface OracleRoutineDeployDraft extends OracleRoutinePlanDraft {
  objectId: string;
  included: boolean;
  operation?: OracleRoutineOperation;
}

/** Owned by the existing comparison session, not the mounted dialog. */
export interface OracleRoutineDeployment {
  source: OracleRoutineSnapshot;
  target: OracleRoutineSnapshot;
  drafts: OracleRoutineDeployDraft[];
  selectedObjectId: string | null;
  revision: number;
  plan: OracleRoutinePlan | null;
  recoveryPlan: OracleRoutinePlan | null;
  records: OracleRoutineOperation[];
  validating: boolean;
  executing: boolean;
  pendingOperationId: string | null;
  stopRequested: boolean;
  reviewOpen: boolean;
  error: string | null;
  retainedOperationIds: string[];
  attemptedOperationIds: string[];
  disposed: boolean;
}

export function routineIdentityKey(identity: OracleRoutineIdentity): string {
  return JSON.stringify([identity.owner, identity.name, identity.kind]);
}

export function createOracleRoutineDeployment(source: OracleRoutineSnapshot, target: OracleRoutineSnapshot): OracleRoutineDeployment {
  return {
    source,
    target,
    drafts: [],
    selectedObjectId: null,
    revision: 0,
    plan: null,
    recoveryPlan: null,
    records: [],
    validating: false,
    executing: false,
    pendingOperationId: null,
    stopRequested: false,
    reviewOpen: false,
    error: null,
    retainedOperationIds: [],
    attemptedOperationIds: [],
    disposed: false,
  };
}

const referenceUpdates = new WeakMap<OracleRoutineDeployment, Promise<void>>();
function planOperationIds(plan: OracleRoutinePlan | null): string[] {
  return plan?.steps.flatMap((step) => (step.operation ? [step.operation.operationId] : [])) ?? [];
}

function pruneOperationReferences(state: OracleRoutineDeployment): Promise<void> {
  const update = (referenceUpdates.get(state) ?? Promise.resolve()).then(async () => {
    const used = new Set([...planOperationIds(state.plan), ...planOperationIds(state.recoveryPlan), ...state.drafts.flatMap((draft) => (draft.operation ? [draft.operation.operationId] : [])), ...state.attemptedOperationIds, ...(state.pendingOperationId ? [state.pendingOperationId] : [])]);
    state.records = state.records.filter((record) => record.dispatched || used.has(record.operationId));
    state.records.forEach((record) => used.add(record.operationId));
    const released = state.retainedOperationIds.filter((id) => state.disposed || !used.has(id));
    await releaseOracleRoutineOperations(released);
    state.retainedOperationIds = state.retainedOperationIds.filter((id) => !released.includes(id));
  });
  referenceUpdates.set(state, update);
  return update;
}

export function disposeOracleRoutineDeployment(state: OracleRoutineDeployment): Promise<void> {
  state.disposed = true;
  state.stopRequested = true;
  state.revision++;
  return pruneOperationReferences(state);
}

export function synchronizeOracleRoutineSelection(state: OracleRoutineDeployment, objects: SchemaDiffObject[]): void {
  if (state.disposed) return;
  let changed = false;
  for (const draft of state.drafts) {
    const included = objects.some((object) => object.id === draft.objectId && object.selected && object.operationType !== "none");
    if (draft.included !== included) {
      draft.included = included;
      changed = true;
    }
  }
  for (const object of objects) {
    if (!object.selected || object.operationType === "none" || state.drafts.some((draft) => draft.objectId === object.id)) continue;
    if (object.routineType !== "FUNCTION" && object.routineType !== "PROCEDURE") throw new Error("Routine selection has no exact function/procedure kind");
    state.drafts.push({
      objectId: object.id,
      identity: { owner: state.target.endpoint.schema, name: object.targetName ?? object.name, kind: object.routineType },
      action: object.operationType === "create" ? "create" : object.operationType === "delete" ? "delete" : "replace",
      sourceName: object.sourceName ?? object.name,
      included: true,
    });
    changed = true;
  }
  if (changed) {
    state.revision++;
    state.plan = null;
    state.recoveryPlan = null;
    for (const draft of state.drafts) {
      if (!draft.included && draft.operation?.lifecycle === "prepared" && !state.attemptedOperationIds.includes(draft.operation.operationId)) draft.operation = undefined;
    }
    void pruneOperationReferences(state);
  }
  if (!state.drafts.some((draft) => draft.objectId === state.selectedObjectId && draft.included)) {
    state.selectedObjectId = state.drafts.find((draft) => draft.included)?.objectId ?? null;
  }
}

export function editOracleRoutineDraft(state: OracleRoutineDeployment, objectId: string, sql: string): void {
  if (state.disposed) return;
  const draft = state.drafts.find((draft) => draft.objectId === objectId);
  if (!draft || draft.sql === sql || state.executing || (draft.operation && oracleRoutineOperationVerified(draft.operation))) return;
  draft.sql = sql;
  state.revision++;
  state.plan = null;
  state.recoveryPlan = null;
  state.error = null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectOracleRoutineDraft(state: OracleRoutineDeployment, objectId: string): void {
  if (state.disposed) return;
  if (!state.drafts.some((draft) => draft.objectId === objectId && draft.included)) return;
  if (state.selectedObjectId !== objectId && state.recoveryPlan) {
    if (state.executing) return;
    state.recoveryPlan = null;
    state.revision++;
    void pruneOperationReferences(state);
  }
  state.selectedObjectId = objectId;
}
function sameTarget(left: OracleRoutinePlan["target"], right: OracleRoutinePlan["target"]): boolean {
  return left.connectionId === right.connectionId && left.database === right.database && left.schema === right.schema && left.databaseType === right.databaseType && left.generation === right.generation;
}

function remember(state: OracleRoutineDeployment, operation: OracleRoutineOperation): void {
  if (state.disposed) return;
  const index = state.records.findIndex((record) => record.operationId === operation.operationId);
  if (index < 0) state.records.push(operation);
  else state.records[index] = operation;
  const draft = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(operation.identity));
  // An old response cannot replace a newer approval on the same target.
  if (draft && (!draft.operation || draft.operation.operationId === operation.operationId)) draft.operation = operation;
}

async function invalidateTarget(operation: OracleRoutineOperation): Promise<void> {
  if (!operation.dispatched && operation.lifecycle !== "unproven" && operation.lifecycle !== "running") return;
  const target = operation.target;
  invalidateObjectBrowserRowsCache({ connectionId: target.connectionId, database: target.database, schema: target.schema });
  await Promise.allSettled([invalidateObjectDdlCache({ connectionId: target.connectionId, database: target.database, schema: target.schema, tableName: operation.identity.name })]);
}

export async function observeOracleRoutineDeployment(state: OracleRoutineDeployment, operationId: string): Promise<void> {
  if (state.disposed) return;
  try {
    const observed = await api.observeOracleRoutineOperation(operationId, true);
    if (!observed.operation) {
      state.error = `${operationId}: ${observed.error ?? "Original request outcome is unproven"}`;
      return;
    }
    remember(state, observed.operation);
    await invalidateTarget(observed.operation);
  } catch (error) {
    state.error = `${operationId}: ${errorText(error)}`;
  }
}

/** Final text + exact identities are sent to Core; old database dependencies are
 * not reused as proof of a manually edited draft. */
export async function validateOracleRoutineDeployment(state: OracleRoutineDeployment): Promise<void> {
  if (state.disposed || state.validating || state.executing) return;
  const previousPlan = state.plan;
  let replacementPrepared = false;
  state.validating = true;
  state.error = null;
  state.recoveryPlan = null;
  const revision = state.revision;
  try {
    const drafts: OracleRoutinePlanDraft[] = [];
    for (const draft of state.drafts.filter((draft) => draft.included)) {
      if (draft.operation && oracleRoutineOperationVerified(draft.operation)) continue;
      let previous = draft.operation;
      if (previous) {
        const observed = await api.observeOracleRoutineOperation(previous.operationId, false);
        if (!observed.operation) throw new Error(`${previous.operationId}: ${observed.error ?? "Original operation is unavailable; do not replay"}`);
        remember(state, observed.operation);
        previous = observed.operation;
        if (previous.lifecycle === "running" || previous.lifecycle === "unproven") throw new Error(`${previous.operationId}: original request termination is not proven; observe this operation before any new write`);
        if (oracleRoutineOperationVerified(previous)) continue;
      }
      const baseline = previous?.lifecycle === "terminal" && previous.dispatched ? previous : undefined;
      const action = baseline && draft.action !== "delete" ? (baseline.readback?.exists === true ? "replace" : "create") : draft.action;
      drafts.push({ identity: { ...draft.identity }, action, sourceName: draft.sourceName, sql: draft.sql, baselineOperationId: baseline?.operationId, supersedesOperationId: previous?.lifecycle === "prepared" ? previous.operationId : undefined });
    }
    if (drafts.length === 0) {
      state.plan = null;
      return;
    }
    const plan = await api.prepareOracleRoutinePlan({ source: state.source, target: state.target, drafts });
    const ids = planOperationIds(plan);
    replacementPrepared = plan.ready && ids.length > 0;
    try {
      await retainOracleRoutineOperations(ids);
      if (revision !== state.revision || state.disposed) {
        await releaseOracleRoutineOperations(ids.filter((id) => !state.retainedOperationIds.includes(id)));
        return;
      }
      if (!sameTarget(plan.target, state.target.endpoint)) throw new Error("Routine plan belongs to another comparison target");
      if (plan.steps.some((step) => !state.drafts.some((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity)))) throw new Error("Routine plan returned an unselected object");
    } catch (error) {
      await releaseOracleRoutineOperations(ids.filter((id) => !state.retainedOperationIds.includes(id)));
      throw error;
    }
    state.retainedOperationIds = [...new Set([...state.retainedOperationIds, ...ids])];
    state.plan = plan;
    for (const step of plan.steps) {
      const draft = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
      if (!draft) throw new Error("Routine plan returned an unselected object");
      draft.sql = step.sql;
      if (step.operation) {
        draft.operation = step.operation;
        remember(state, step.operation);
      }
    }
  } catch (error) {
    if (revision === state.revision) {
      state.plan = previousPlan;
      if (replacementPrepared && previousPlan) previousPlan.ready = false;
      state.error = errorText(error);
    }
  } finally {
    state.validating = false;
    await pruneOperationReferences(state);
  }
}

/** Explicit refresh replaces only read baselines. Drafts and execution history
 * remain attached to the original session; unresolved writes cannot be erased. */
export async function refreshOracleRoutineDeployment(state: OracleRoutineDeployment): Promise<void> {
  if (state.disposed || state.validating || state.executing) return;
  state.validating = true;
  state.error = null;
  state.plan = null;
  state.recoveryPlan = null;
  const revision = ++state.revision;
  try {
    for (const draft of state.drafts) {
      if (!draft.operation || oracleRoutineOperationVerified(draft.operation)) continue;
      const observed = await api.observeOracleRoutineOperation(draft.operation.operationId, draft.action === "delete");
      if (!observed.operation || observed.lifecycle === "running" || observed.lifecycle === "unproven") throw new Error(`${draft.operation.operationId}: establish the original request's termination before refreshing this write baseline`);
      remember(state, observed.operation);
    }
    const sourceNames = [...new Set(state.drafts.map((draft) => draft.sourceName ?? draft.identity.name))];
    const targetNames = [...new Set(state.drafts.map((draft) => draft.identity.name))];
    const read = (snapshot: OracleRoutineSnapshot, names: string[]) => api.loadSchemaDiffRoutines(snapshot.endpoint.connectionId, snapshot.endpoint.database, snapshot.endpoint.schema, names);
    const [source, target] = await Promise.all([read(state.source, sourceNames), read(state.target, targetNames)]);
    if (revision !== state.revision || state.disposed) return;
    const sameReadTarget = (current: OracleRoutineSnapshot, before: OracleRoutineSnapshot) =>
      current.endpoint.connectionId === before.endpoint.connectionId && current.endpoint.database === before.endpoint.database && current.endpoint.schema === before.endpoint.schema && current.endpoint.databaseType === before.endpoint.databaseType;
    if (!sameReadTarget(source, state.source) || !sameReadTarget(target, state.target)) throw new Error("Refreshed snapshots do not match this comparison's original endpoints");
    state.source = source;
    state.target = target;
    for (const draft of state.drafts) {
      if (draft.operation && oracleRoutineOperationVerified(draft.operation)) continue;
      if (draft.operation?.lifecycle === "terminal" && draft.action !== "delete") draft.operation = undefined;
      if (draft.action !== "delete") draft.action = target.objects.some((object) => object.version.identity.owner === draft.identity.owner && object.version.identity.name === draft.identity.name) ? "replace" : "create";
    }
  } catch (error) {
    state.error = errorText(error);
  } finally {
    state.validating = false;
    await pruneOperationReferences(state);
  }
}

export function oracleRoutinePlanSql(state: OracleRoutineDeployment): string {
  return (state.recoveryPlan ?? state.plan)?.steps.map((step) => step.sql).join("\n/\n") ?? "";
}

export function oracleRoutineActiveStep(state: OracleRoutineDeployment): OracleRoutinePlanStep | undefined {
  const draft = state.drafts.find((draft) => draft.objectId === state.selectedObjectId);
  return (state.recoveryPlan ?? state.plan)?.steps.find((step) => draft && routineIdentityKey(step.identity) === routineIdentityKey(draft.identity));
}

export async function prepareOracleRoutineRecovery(state: OracleRoutineDeployment, operationId: string): Promise<void> {
  if (state.disposed || state.validating || state.executing) return;
  state.validating = true;
  state.error = null;
  const revision = state.revision;
  try {
    const plan = await api.prepareOracleRoutineRecovery(operationId);
    const ids = planOperationIds(plan);
    try {
      await retainOracleRoutineOperations(ids);
      if (revision !== state.revision || state.disposed) {
        await releaseOracleRoutineOperations(ids.filter((id) => !state.retainedOperationIds.includes(id)));
        return;
      }
      if (!sameTarget(plan.target, state.target.endpoint)) throw new Error("Recovery belongs to another target");
      if (!state.drafts.some((draft) => draft.included && plan.steps.some((step) => routineIdentityKey(step.identity) === routineIdentityKey(draft.identity)))) throw new Error("Recovery does not belong to an included routine");
    } catch (error) {
      await releaseOracleRoutineOperations(ids.filter((id) => !state.retainedOperationIds.includes(id)));
      throw error;
    }
    state.retainedOperationIds = [...new Set([...state.retainedOperationIds, ...ids])];
    const draft = state.drafts.find((draft) => draft.included && plan.steps.some((step) => routineIdentityKey(step.identity) === routineIdentityKey(draft.identity)));
    if (!draft) throw new Error("Recovery does not belong to an included routine");
    state.selectedObjectId = draft.objectId;
    state.recoveryPlan = plan;
    state.revision++;
  } catch (error) {
    state.error = errorText(error);
  } finally {
    state.validating = false;
    await pruneOperationReferences(state);
  }
}

/** authorize reuses the existing production guard. It may cancel without calling
 * run. Closing the view stops the NEXT step, never the server's current worker. */
export async function executeOracleRoutineDeployment(state: OracleRoutineDeployment, authorize: (sql: string, run: () => Promise<void>) => Promise<unknown>): Promise<void> {
  const plan = state.recoveryPlan ?? state.plan;
  if (state.disposed || state.executing || state.validating || !plan?.ready || !plan.steps.length) return;
  const revision = state.revision;
  state.executing = true;
  state.stopRequested = false;
  state.error = null;
  let attempted = false;
  try {
    await authorize(oracleRoutinePlanSql(state), async () => {
      if (state.disposed || revision !== state.revision || (state.recoveryPlan ?? state.plan) !== plan) throw new Error("Draft changed during confirmation; validate it again");
      for (const step of plan.steps) {
        if (state.stopRequested) break;
        const operation = step.operation;
        if (!operation) throw new Error("Routine step has no Core approval");
        if (state.records.some((record) => record.operationId === operation.operationId && (record.dispatched || record.lifecycle !== "prepared"))) {
          throw new Error(`${operation.operationId}: this approval has already been used; observe its original ID`);
        }
        const release = beginSourceSave(captureSourceIdentity({ connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema, objectType: step.identity.kind, name: step.identity.name }));
        let result: OracleRoutineOperation;
        try {
          attempted = true;
          state.pendingOperationId = operation.operationId;
          if (!state.attemptedOperationIds.includes(operation.operationId)) state.attemptedOperationIds.push(operation.operationId);
          try {
            result = await api.executeOracleRoutineOperation(operation.operationId, step.sql);
          } catch (error) {
            // Never dispatch again after a lost response, including Prepared: a
            // late original execute must be superseded atomically by Core.
            const observed = await api.observeOracleRoutineOperation(operation.operationId, false).catch(() => null);
            result = observed?.operation ?? { ...operation, lifecycle: "unproven", error: errorText(error) };
          }
          if (!state.disposed) step.operation = result;
          remember(state, result);
          await invalidateTarget(result);
        } finally {
          state.pendingOperationId = null;
          release();
        }
        if (!oracleRoutineOperationVerified(result)) break;
      }
    });
  } catch (error) {
    state.error = errorText(error);
  } finally {
    state.executing = false;
    if (attempted) plan.ready = false;
    await pruneOperationReferences(state);
  }
}
