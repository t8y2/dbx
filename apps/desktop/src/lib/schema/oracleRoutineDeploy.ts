import * as api from "@/lib/backend/api";
import { oracleRoutineOperationVerified } from "@/lib/table/oracleRoutineWrite";
import { beginSourceSave, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";
import type { OracleRoutineIdentity, OracleRoutineOperation, OracleRoutinePlan, OracleRoutinePlanDraft, OracleRoutinePlanStep, OracleRoutineSnapshot, OracleRoutinePlanInput } from "@/types/schemaDiff";
import { releaseOracleRoutineOperations, retainOracleRoutineOperations } from "@/lib/table/oracleRoutineOperationReferences";

export interface OracleRoutineDeployDraft extends OracleRoutinePlanDraft {
  objectId: string;
  included: boolean;
  operation?: OracleRoutineOperation;
  packageBodyDrafts?: Partial<Record<"source" | "target", string>>;
  packageBodyGeneratedSql?: Partial<Record<"source" | "target", string>>;
  companionFor?: string;
  reviewedTargetDraft?: boolean;
  generatedSql?: string;
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
  ddlPreferences?: { includeDdlStorage: boolean; compactDdlSql: boolean; separateDdlIndexes: boolean };
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
    const included = objects.some((object) => (object.id === draft.objectId || object.id === draft.companionFor) && object.selected && object.operationType !== "none");
    if (draft.included !== included) {
      draft.included = included;
      changed = true;
    }
  }
  for (const object of objects) {
    if (!object.selected || object.operationType === "none" || state.drafts.some((draft) => draft.objectId === object.id)) continue;
    if (object.routineType !== "FUNCTION" && object.routineType !== "PROCEDURE" && object.routineType !== "PACKAGE" && object.routineType !== "PACKAGE_BODY") throw new Error("Program selection has no exact supported kind");
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

export function includeOraclePackageCompanion(state: OracleRoutineDeployment, objectId: string, bodySource: "source" | "target" = "source"): OracleRoutineDeployDraft | undefined {
  const current = state.drafts.find((draft) => draft.objectId === objectId && draft.included);
  if (state.disposed || state.executing || !current || (current.identity.kind !== "PACKAGE" && current.identity.kind !== "PACKAGE_BODY")) return;
  if (current.identity.kind === "PACKAGE" && current.action === "delete") return;
  const kind = current.identity.kind === "PACKAGE" ? "PACKAGE_BODY" : "PACKAGE";
  const identity: OracleRoutineIdentity = { ...current.identity, kind };
  const existing = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(identity));
  if (existing?.included && (kind !== "PACKAGE_BODY" || (existing.operation && oracleRoutineOperationVerified(existing.operation)))) {
    state.selectedObjectId = existing.objectId;
    return existing;
  }
  const material = current.action === "delete" || (kind === "PACKAGE_BODY" && bodySource === "target") ? state.target : state.source;
  const name = material === state.source ? (current.sourceName ?? current.identity.name) : current.identity.name;
  const original = material.objects.find((object) => object.version.identity.owner === material.endpoint.schema && object.version.identity.name === name && object.version.identity.kind === kind);
  if (!original?.sourceComplete || !original.source) {
    state.error = "Completely read the selected package companion before adding its write; refresh the comparison without discarding the draft";
    return;
  }
  const target = state.target.objects.find((object) => routineIdentityKey(object.version.identity) === routineIdentityKey(identity));
  const draft: OracleRoutineDeployDraft = existing ?? { objectId: `package-companion:${routineIdentityKey(identity)}`, identity, action: current.action === "delete" ? "delete" : target ? "replace" : "create", sourceName: current.sourceName ?? current.identity.name, included: true };
  if (!existing) state.drafts.push(draft);
  const action = current.action === "delete" ? "delete" : target ? "replace" : "create";
  if (draft.action !== action) {
    draft.action = action;
    draft.sql = undefined;
    draft.generatedSql = undefined;
    draft.reviewedTargetDraft = false;
  }
  draft.included = true;
  draft.companionFor = current.objectId;
  if (kind === "PACKAGE_BODY") editOraclePackageOptions(state, draft.objectId, { packageBodySource: bodySource });
  for (const peer of state.drafts) if (peer.identity.owner === identity.owner && peer.identity.name === identity.name) peer.confirmPackagePair = false;
  state.selectedObjectId = draft.objectId;
  state.revision++;
  state.plan = null;
  state.recoveryPlan = null;
  state.error = null;
  return draft;
}

export function editOracleRoutineDraft(state: OracleRoutineDeployment, objectId: string, sql: string): void {
  if (state.disposed) return;
  const draft = state.drafts.find((draft) => draft.objectId === objectId);
  if (!draft || draft.sql === sql || state.executing || (draft.operation && oracleRoutineOperationVerified(draft.operation))) return;
  draft.sql = sql;
  draft.reviewedTargetDraft = true;
  draft.generatedSql = undefined;
  if (draft.identity.kind === "PACKAGE" || draft.identity.kind === "PACKAGE_BODY") {
    for (const peer of state.drafts) if (peer.identity.owner === draft.identity.owner && peer.identity.name === draft.identity.name) peer.confirmPackagePair = false;
  }
  state.revision++;
  state.plan = null;
  state.recoveryPlan = null;
  state.error = null;
}

export function editOraclePackageOptions(state: OracleRoutineDeployment, objectId: string, options: Pick<OracleRoutinePlanDraft, "packageBodySource" | "packageContract" | "confirmPackagePair">): void {
  const draft = state.drafts.find((draft) => draft.objectId === objectId);
  if (state.disposed || state.executing || !draft || (draft.operation && oracleRoutineOperationVerified(draft.operation)) || (draft.identity.kind !== "PACKAGE" && draft.identity.kind !== "PACKAGE_BODY")) return;
  const next = { ...draft, ...options };
  if (next.packageBodySource === draft.packageBodySource && next.packageContract === draft.packageContract && next.confirmPackagePair === draft.confirmPackagePair) return;
  if (next.packageBodySource !== draft.packageBodySource) {
    draft.packageBodyDrafts = { ...draft.packageBodyDrafts, [draft.packageBodySource ?? "source"]: draft.sql };
    draft.packageBodyGeneratedSql = { ...draft.packageBodyGeneratedSql, [draft.packageBodySource ?? "source"]: draft.sql === draft.generatedSql ? draft.generatedSql : undefined };
    draft.sql = draft.packageBodyDrafts[next.packageBodySource ?? "source"];
    const generated = draft.packageBodyGeneratedSql[next.packageBodySource ?? "source"];
    draft.generatedSql = draft.sql === generated ? generated : undefined;
    draft.reviewedTargetDraft = false;
  }
  if (next.packageBodySource !== draft.packageBodySource || next.packageContract !== draft.packageContract) {
    for (const peer of state.drafts) if (peer.identity.owner === draft.identity.owner && peer.identity.name === draft.identity.name) peer.confirmPackagePair = false;
  }
  Object.assign(draft, options);
  state.revision++;
  state.plan = null;
  state.recoveryPlan = null;
  state.error = null;
}

export function reviewOraclePackageTargetDraft(state: OracleRoutineDeployment, objectId: string): void {
  const draft = state.drafts.find((draft) => draft.objectId === objectId && draft.included);
  if (state.disposed || state.executing || !draft || !draft.sql?.trim() || draft.reviewedTargetDraft || (draft.operation && oracleRoutineOperationVerified(draft.operation)) || (draft.identity.kind !== "PACKAGE" && draft.identity.kind !== "PACKAGE_BODY")) return;
  draft.reviewedTargetDraft = true;
  draft.generatedSql = undefined;
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
  if (state.recoveryPlan && oracleRoutineDeploymentEntries(state).some((entry) => entry.objectId === objectId)) {
    if (!state.executing) state.selectedObjectId = objectId;
    return;
  }
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

export function acceptOracleRoutineDeploymentOperation(state: OracleRoutineDeployment, operation: OracleRoutineOperation): boolean {
  if (state.disposed || !sameTarget(operation.target, state.target.endpoint)) return false;
  const previous = state.records.find((record) => record.operationId === operation.operationId) ?? state.drafts.find((draft) => draft.operation?.operationId === operation.operationId)?.operation;
  if (
    !previous ||
    routineIdentityKey(previous.identity) !== routineIdentityKey(operation.identity) ||
    (previous.dispatched && !operation.dispatched) ||
    (previous.lifecycle === "terminal" && operation.lifecycle !== "terminal") ||
    (previous.lifecycle === "unproven" && operation.lifecycle === "prepared")
  )
    return false;
  remember(state, operation);
  for (const plan of [state.plan, state.recoveryPlan]) {
    const step = plan?.steps.find((step) => step.operation?.operationId === operation.operationId);
    if (step) {
      step.operation = operation;
      if (operation.dispatched || operation.lifecycle !== "prepared") plan!.ready = false;
    }
  }
  if (operation.dispatched && !state.attemptedOperationIds.includes(operation.operationId)) state.attemptedOperationIds.push(operation.operationId);
  void invalidateTarget(operation);
  return true;
}

function sameTransferDraft(left: OracleRoutinePlanDraft, right: OracleRoutinePlanDraft): boolean {
  return (
    routineIdentityKey(left.identity) === routineIdentityKey(right.identity) &&
    left.action === "create" &&
    right.action === "create" &&
    !!left.sql &&
    left.sql === right.sql &&
    (left.sourceName ?? null) === (right.sourceName ?? null) &&
    (left.packageBodySource ?? null) === (right.packageBodySource ?? null) &&
    (left.packageContract ?? null) === (right.packageContract ?? null) &&
    !!left.confirmPackagePair === !!right.confirmPackagePair &&
    !left.baselineOperationId &&
    !left.supersedesOperationId &&
    !right.baselineOperationId &&
    !right.supersedesOperationId
  );
}

function matchesPendingTransferInput(state: OracleRoutineDeployment, frozen: api.OraclePackageTransferRequest, returned: OracleRoutinePlanInput): boolean {
  const input = frozen.input;
  const pending = frozen.pendingTables;
  if (!input || !pending?.tables.length || !pending.dependencyManifest || pending.tableEvidence.length !== pending.tables.length || frozen.operationIds?.length || state.pendingOperationId || state.attemptedOperationIds.length || state.drafts.some((draft) => draft.operation)) return false;
  if (![input.source.endpoint.databaseType, input.target.endpoint.databaseType].every((type) => type === "oracle" || type === "oceanbase-oracle")) return false;
  if (
    !sameTarget(input.source.endpoint, state.source.endpoint) ||
    !sameTarget(input.target.endpoint, state.target.endpoint) ||
    !sameTarget(pending.source, input.source.endpoint) ||
    !sameTarget(pending.target, input.target.endpoint) ||
    !sameTarget(returned.source.endpoint, input.source.endpoint) ||
    !sameTarget(returned.target.endpoint, input.target.endpoint)
  )
    return false;
  const selected = state.drafts.filter((draft) => draft.included);
  if (
    !selected.length ||
    selected.some((draft) => draft.identity.kind !== "PACKAGE" && draft.identity.kind !== "PACKAGE_BODY") ||
    input.drafts.length !== selected.length ||
    returned.drafts.length !== selected.length ||
    new Set(selected.map((draft) => routineIdentityKey(draft.identity))).size !== selected.length
  )
    return false;
  return !selected.some((draft) => {
    const expected = input.drafts.find((item) => routineIdentityKey(item.identity) === routineIdentityKey(draft.identity));
    const actual = returned.drafts.find((item) => routineIdentityKey(item.identity) === routineIdentityKey(draft.identity));
    return !expected || !actual || !sameTransferDraft(draft, expected) || !sameTransferDraft(expected, actual);
  });
}

export function oraclePackageTransferPendingReady(state: OracleRoutineDeployment, preview: api.OraclePackageTransferPreview): boolean {
  if (
    state.disposed ||
    state.executing ||
    state.validating ||
    state.error ||
    !state.plan ||
    state.plan.ready ||
    preview.plan.ready ||
    !sameTarget(preview.plan.target, state.target.endpoint) ||
    !matchesPendingTransferInput(state, { input: preview.input, pendingTables: preview.pendingTables }, preview.input)
  )
    return false;
  return (
    new Set(state.plan.steps.map((step) => routineIdentityKey(step.identity))).size === state.plan.steps.length &&
    state.plan.steps.length === preview.input.drafts.length &&
    preview.plan.steps.length === state.plan.steps.length &&
    state.plan.steps.every((step, index) => {
      const returned = preview.plan.steps[index];
      const draft = preview.input.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
      return (
        !!draft &&
        !step.operation &&
        !returned.operation &&
        !step.issues.length &&
        !returned.issues.length &&
        step.action === "create" &&
        returned.action === "create" &&
        routineIdentityKey(step.identity) === routineIdentityKey(returned.identity) &&
        step.sql === returned.sql &&
        step.sql === draft.sql
      );
    })
  );
}

export function acceptOraclePackageTransferPreflight(state: OracleRoutineDeployment, frozen: api.OraclePackageTransferRequest, preview: api.OraclePackageTransferPreview): boolean {
  if (state.disposed || !state.executing || state.validating || !state.plan || state.plan.ready || preview.plan.ready || !sameTarget(preview.plan.target, state.target.endpoint) || !matchesPendingTransferInput(state, frozen, preview.input) || preview.plan.steps.length !== frozen.input!.drafts.length)
    return false;
  if (
    new Set(preview.plan.steps.map((step) => routineIdentityKey(step.identity))).size !== preview.plan.steps.length ||
    preview.plan.steps.some((step) => step.operation || step.action !== "create" || !frozen.input!.drafts.some((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity) && draft.sql === step.sql))
  )
    return false;
  state.plan = preview.plan;
  return true;
}

export async function acceptOraclePackageTransferApproval(state: OracleRoutineDeployment, frozen: api.OraclePackageTransferRequest, approval: api.OraclePackageTransferPreview): Promise<boolean> {
  const input = frozen.input;
  const before = state.plan;
  if (
    !input ||
    state.disposed ||
    !state.executing ||
    state.validating ||
    state.error ||
    !before ||
    before.ready ||
    !sameTarget(approval.plan.target, input.target.endpoint) ||
    !matchesPendingTransferInput(state, frozen, approval.input) ||
    before.steps.length !== input.drafts.length ||
    approval.plan.steps.length !== input.drafts.length ||
    approval.pendingTables ||
    !approval.plan.ready
  )
    return false;
  if (new Set(approval.plan.steps.map((step) => routineIdentityKey(step.identity))).size !== approval.plan.steps.length) return false;
  const ids: string[] = [];
  for (const [index, step] of approval.plan.steps.entries()) {
    const expected = before.steps[index];
    const draft = input.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
    const operation = step.operation;
    if (
      !draft ||
      !operation ||
      !sameTarget(operation.target, input.target.endpoint) ||
      operation.lifecycle !== "prepared" ||
      operation.dispatched ||
      operation.acknowledged ||
      operation.error ||
      operation.readback ||
      !operation.operationId ||
      ids.includes(operation.operationId) ||
      state.records.some((record) => record.operationId === operation.operationId) ||
      routineIdentityKey(operation.identity) !== routineIdentityKey(step.identity) ||
      routineIdentityKey(expected.identity) !== routineIdentityKey(step.identity) ||
      expected.action !== "create" ||
      step.action !== "create" ||
      draft.sql !== step.sql ||
      expected.sql !== step.sql ||
      (expected.sourceOriginal ?? null) !== (step.sourceOriginal ?? null) ||
      (expected.targetOriginal ?? null) !== (step.targetOriginal ?? null) ||
      expected.operation ||
      expected.issues.length ||
      step.issues.length
    )
      return false;
    ids.push(operation.operationId);
  }
  // Install IDs synchronously: the next stream event may already be a result.
  state.plan = approval.plan;
  for (const step of approval.plan.steps) remember(state, step.operation!);
  state.retainedOperationIds = [...new Set([...state.retainedOperationIds, ...ids])];
  try {
    await retainOracleRoutineOperations(ids);
    return !state.disposed;
  } catch (error) {
    if (!state.disposed) state.error = errorText(error);
    return false;
  }
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

export function canRegenerateOracleRoutineDeployment(state: OracleRoutineDeployment): boolean {
  if (state.disposed || state.validating || state.executing || state.recoveryPlan || state.pendingOperationId || state.attemptedOperationIds.length || state.records.some((record) => record.dispatched || record.lifecycle === "running" || record.lifecycle === "unproven")) return false;
  const included = state.drafts.filter((draft) => draft.included);
  return included.length > 0 && included.every((draft) => !draft.reviewedTargetDraft && draft.generatedSql !== undefined && draft.sql === draft.generatedSql);
}

/** Final text + exact identities are sent to Core; old database dependencies are
 * not reused as proof of a manually edited draft. */
export async function validateOracleRoutineDeployment(state: OracleRoutineDeployment, prepare: (input: OracleRoutinePlanInput) => Promise<OracleRoutinePlan> = api.prepareOracleRoutinePlan, options: { compactSql?: boolean; regenerateGenerated?: boolean } = {}): Promise<void> {
  const { compactSql = false, regenerateGenerated = false } = options;
  if (state.disposed || state.validating || state.executing) return;
  if (regenerateGenerated && !canRegenerateOracleRoutineDeployment(state)) return;
  const previousPlan = state.plan;
  if (regenerateGenerated) {
    state.revision++;
    if (previousPlan) previousPlan.ready = false;
    state.plan = null;
  }
  const generated = new Set(state.drafts.filter((draft) => !draft.reviewedTargetDraft && (draft.sql === undefined || (draft.generatedSql !== undefined && draft.sql === draft.generatedSql))).map((draft) => draft.objectId));
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
      drafts.push({
        identity: { ...draft.identity },
        action,
        sourceName: draft.sourceName,
        sql: draft.reviewedTargetDraft ? draft.sql : generated.has(draft.objectId) || state.source.endpoint.databaseType !== state.target.endpoint.databaseType ? undefined : draft.sql,
        baselineOperationId: baseline?.operationId,
        supersedesOperationId: previous?.lifecycle === "prepared" ? previous.operationId : undefined,
        ...(draft.packageBodySource === undefined ? {} : { packageBodySource: draft.packageBodySource }),
        ...(draft.packageContract === undefined ? {} : { packageContract: draft.packageContract }),
        ...(draft.confirmPackagePair === undefined ? {} : { confirmPackagePair: draft.confirmPackagePair }),
      });
    }
    if (drafts.length === 0) {
      state.plan = null;
      return;
    }
    const plan = await prepare({ source: state.source, target: state.target, drafts, compactSql });
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
    const reviewOnly =
      !plan.ready &&
      drafts.length > 0 &&
      plan.steps.length === drafts.length &&
      new Set(drafts.map((draft) => routineIdentityKey(draft.identity))).size === drafts.length &&
      new Set(plan.steps.map((step) => routineIdentityKey(step.identity))).size === drafts.length &&
      plan.steps.every((step) => {
        const expected = drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
        const draft = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
        return expected && draft && generated.has(draft.objectId) && expected.action === step.action && !!step.sql.trim() && !step.operation && step.issues.length > 0 && step.issues.every((issue) => issue.code === "target-draft-review");
      });
    if (regenerateGenerated && !plan.ready && !reviewOnly) return;
    for (const step of plan.steps) {
      const draft = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
      if (!draft) throw new Error("Routine plan returned an unselected object");
      draft.sql = step.sql;
      if (generated.has(draft.objectId)) draft.generatedSql = step.sql;
      if (step.operation) {
        draft.operation = step.operation;
        remember(state, step.operation);
      }
    }
    if (!oracleRoutineActiveStep(state) && plan.steps.length) state.selectedObjectId = oracleRoutineDeploymentEntries(state).find((entry) => routineIdentityKey(entry.identity) === routineIdentityKey(plan.steps[0].identity))!.objectId;
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
export async function refreshOracleRoutineDeployment(state: OracleRoutineDeployment, fixedEndpoints?: { source: OracleRoutineSnapshot["endpoint"]; target: OracleRoutineSnapshot["endpoint"] }): Promise<void> {
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
    const typed = state.drafts.some((draft) => draft.identity.kind === "PACKAGE" || draft.identity.kind === "PACKAGE_BODY");
    const objectKinds = [...new Set(state.drafts.map((draft) => draft.identity.kind))];
    const read = (snapshot: OracleRoutineSnapshot, names: string[], source: boolean) =>
      typed
        ? api.loadSchemaDiffRoutines(snapshot.endpoint.connectionId, snapshot.endpoint.database, snapshot.endpoint.schema, undefined, {
            objectKinds,
            selectedObjects: state.drafts.map((draft) => ({ name: source ? (draft.sourceName ?? draft.identity.name) : draft.identity.name, kind: draft.identity.kind })),
          })
        : api.loadSchemaDiffRoutines(snapshot.endpoint.connectionId, snapshot.endpoint.database, snapshot.endpoint.schema, names);
    const [source, target] = await Promise.all([read(state.source, sourceNames, true), read(state.target, targetNames, false)]);
    if (revision !== state.revision || state.disposed) return;
    const sameReadTarget = (current: OracleRoutineSnapshot, before: OracleRoutineSnapshot) =>
      current.endpoint.connectionId === before.endpoint.connectionId && current.endpoint.database === before.endpoint.database && current.endpoint.schema === before.endpoint.schema && current.endpoint.databaseType === before.endpoint.databaseType;
    if (!sameReadTarget(source, state.source) || !sameReadTarget(target, state.target)) throw new Error("Refreshed snapshots do not match this comparison's original endpoints");
    if (fixedEndpoints && (!sameTarget(source.endpoint, fixedEndpoints.source) || !sameTarget(target.endpoint, fixedEndpoints.target))) throw new Error("The original transfer connection generation changed; preserve its results and open a new comparison for the current connection");
    state.source = source;
    state.target = target;
    for (const draft of state.drafts) {
      if (draft.operation && oracleRoutineOperationVerified(draft.operation)) continue;
      if (draft.operation?.lifecycle === "terminal" && draft.action !== "delete") draft.operation = undefined;
      if (draft.action !== "delete") draft.action = target.objects.some((object) => object.version.identity.owner === draft.identity.owner && object.version.identity.name === draft.identity.name && object.version.identity.kind === draft.identity.kind) ? "replace" : "create";
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
  const entry = oracleRoutineDeploymentEntries(state).find((entry) => entry.objectId === state.selectedObjectId);
  return (state.recoveryPlan ?? state.plan)?.steps.find((step) => entry && routineIdentityKey(step.identity) === routineIdentityKey(entry.identity));
}

export function oracleRoutineDeploymentEntries(state: OracleRoutineDeployment): Pick<OracleRoutineDeployDraft, "objectId" | "identity" | "action" | "operation">[] {
  const plan = state.recoveryPlan ?? state.plan;
  if (!plan) return state.drafts.filter((draft) => draft.included);
  const entries = plan.steps.map((step) => {
    const draft = state.drafts.find((draft) => routineIdentityKey(draft.identity) === routineIdentityKey(step.identity));
    return { objectId: draft?.objectId ?? `recovery:${routineIdentityKey(step.identity)}`, identity: step.identity, action: step.action, operation: state.recoveryPlan ? (step.operation ?? undefined) : (draft?.operation ?? step.operation ?? undefined) };
  });
  return state.recoveryPlan ? entries : [...state.drafts.filter((draft) => draft.included && draft.operation && oracleRoutineOperationVerified(draft.operation) && !entries.some((entry) => entry.objectId === draft.objectId)), ...entries];
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
